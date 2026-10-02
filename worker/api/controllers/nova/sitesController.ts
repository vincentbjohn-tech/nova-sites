import { BaseController } from '../baseController';
import type { RouteContext } from '../../types/route-context';
import { AppService } from '../../../database/services/AppService';
import { getAgentStub } from '../../../agents';
import { CodingAgentController } from '../agent/controller';
import type { SiteMeta } from '../../../agents/think/nova-edits';

/** The free address domain: `<name>.<NOVA_SITES_SUBDOMAIN>.workers.dev`. */
function siteAddress(env: Env, deploymentId: string | null): string | null {
	const subdomain = (env as unknown as { NOVA_SITES_SUBDOMAIN?: string }).NOVA_SITES_SUBDOMAIN || 'novasites';
	return deploymentId ? `https://${deploymentId}.${subdomain}.workers.dev` : null;
}

type Json = Record<string, unknown>;

/** Workers AI text-to-image model used for Nova's images. */
const NOVA_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';

/**
 * Nova Sites (contract: nova-os-app `docs/pages/websites-contract.md` §2).
 * Every site call is owner-only: a site that is not the caller's is a 404.
 */
export class NovaSitesController extends BaseController {
	private static async ownedStub(env: Env, context: RouteContext) {
		const id = context.pathParams.id;
		const userId = context.user?.id;
		if (!id || !userId) return null;
		const owner = await new AppService(env).getAppOwnerId(id);
		if (owner !== userId) return null;
		return getAgentStub(env, id);
	}

	private static async body(request: Request): Promise<Json> {
		try {
			const parsed = (await request.json()) as unknown;
			return parsed && typeof parsed === 'object' ? (parsed as Json) : {};
		} catch {
			return {};
		}
	}

	private static str(value: unknown, max = 2000): string | undefined {
		return typeof value === 'string' && value.length <= max ? value : undefined;
	}

	private static notFound() {
		return NovaSitesController.createErrorResponse('Site not found', 404);
	}

	private static busyOr(error: unknown): Response {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes('busy')) {
			return NovaSitesController.createErrorResponse('Nova is still working on this site', 409);
		}
		return NovaSitesController.handleError(error, 'change the site');
	}

	/** GET /api/nova/sites */
	static async list(_request: Request, env: Env, _ctx: ExecutionContext, context: RouteContext): Promise<Response> {
		const apps = await new AppService(env).getUserAppsWithFavorites(context.user!.id, { limit: 100 });
		const sites = apps.map((app) => ({
			id: app.id,
			title: app.title,
			address: siteAddress(env, app.deploymentId ?? null),
			status: app.deploymentId ? 'live' : 'draft',
			updatedAt: app.updatedAt,
		}));
		return NovaSitesController.createSuccessResponse({ sites });
	}

	/** POST /api/nova/sites {prompt} → {id}; the agent starts building right away. */
	static async create(request: Request, env: Env, ctx: ExecutionContext, context: RouteContext): Promise<Response> {
		const prompt = NovaSitesController.str((await NovaSitesController.body(request)).prompt, 100_000)?.trim();
		if (!prompt) return NovaSitesController.createErrorResponse('Describe the site you want', 400);
		const forwarded = new Request(new URL('/api/agent', request.url), {
			method: 'POST',
			headers: request.headers,
			body: JSON.stringify({ query: prompt, behaviorType: 'think', projectType: 'app' }),
		});
		const response = await CodingAgentController.startCodeGeneration(forwarded, env, ctx, context);
		if (!response.ok || !response.body) return response;
		let agentId: string | undefined;
		let failure: string | undefined;
		const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
		let buffer = '';
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += value;
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.trim() || line.trim() === '"terminate"') continue;
				try {
					const event = JSON.parse(line) as { agentId?: string; error?: { message?: string } };
					agentId ??= event.agentId;
					if (event.error) failure = event.error.message ?? 'failed';
				} catch {
					// blueprint chunks and keep-alives
				}
			}
		}
		if (!agentId || failure) return NovaSitesController.createErrorResponse(failure ?? 'Could not start the site', 500);
		const stub = await getAgentStub(env, agentId);
		await stub.novaStartBuild();
		return NovaSitesController.createSuccessResponse({ id: agentId });
	}

	/**
	 * POST /api/nova/sites/import {title, files: {path: text}, label?} → {id, previewUrl}.
	 * An existing site brought over as it is: a new site whose first version is these files.
	 */
	static async importSite(request: Request, env: Env, ctx: ExecutionContext, context: RouteContext): Promise<Response> {
		const body = await NovaSitesController.body(request);
		const title = NovaSitesController.str(body.title, 120)?.trim();
		const label = NovaSitesController.str(body.label, 120)?.trim() || `Brought over ${title}`;
		const files = body.files && typeof body.files === 'object' ? (body.files as Record<string, unknown>) : null;
		if (!title || !files) return NovaSitesController.createErrorResponse('title and files are required', 400);
		const entries = Object.entries(files);
		let total = 0;
		for (const [path, content] of entries) {
			if (typeof content !== 'string' || !/^[A-Za-z0-9._\-/]+$/.test(path) || path.includes('..') || path.startsWith('/') || path.startsWith('.think')) {
				return NovaSitesController.createErrorResponse(`Not a site file: ${path}`, 400);
			}
			total += content.length;
		}
		if (entries.length === 0 || entries.length > 400 || total > 12_000_000) {
			return NovaSitesController.createErrorResponse('A site is 1–400 text files, up to 12 MB (photos go to the media library)', 400);
		}
		const forwarded = new Request(new URL('/api/agent', request.url), {
			method: 'POST',
			headers: request.headers,
			body: JSON.stringify({ query: `${label}.`, behaviorType: 'think', projectType: 'app' }),
		});
		const response = await CodingAgentController.startCodeGeneration(forwarded, env, ctx, context);
		if (!response.ok || !response.body) return response;
		let agentId: string | undefined;
		const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
		let buffer = '';
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += value;
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				try {
					agentId ??= (JSON.parse(line) as { agentId?: string }).agentId;
				} catch {
					// blueprint chunks and keep-alives
				}
			}
		}
		if (!agentId) return NovaSitesController.createErrorResponse('Could not start the site', 500);
		const stub = await getAgentStub(env, agentId);
		const result = await stub.novaImport(files as Record<string, string>, title, label);
		return NovaSitesController.createSuccessResponse({ id: agentId, ...result });
	}

	/**
	 * POST /api/nova/images {prompt} -> {image: base64 JPEG, model, ms}. Cloudflare Workers AI
	 * (FLUX.1 schnell, 1024x1024) through the builder's own AI binding; Nova OS stores the result
	 * in the owner's media library (resized, described) like any upload. Owners only.
	 */
	static async generateImage(request: Request, env: Env, _ctx: ExecutionContext, _context: RouteContext): Promise<Response> {
		const prompt = NovaSitesController.str((await NovaSitesController.body(request)).prompt, 2000)?.trim();
		if (!prompt) return NovaSitesController.createErrorResponse('Describe the image you want', 400);
		const started = Date.now();
		try {
			const ai = (env as unknown as { AI: { run: (model: string, input: Record<string, unknown>) => Promise<{ image?: string }> } }).AI;
			const out = await ai.run(NOVA_IMAGE_MODEL, { prompt, steps: 6 });
			if (!out?.image) return NovaSitesController.createErrorResponse('No image came back', 502);
			return NovaSitesController.createSuccessResponse({ image: out.image, model: NOVA_IMAGE_MODEL, ms: Date.now() - started });
		} catch (error) {
			return NovaSitesController.handleError(error, 'make the image');
		}
	}

	/** GET /api/nova/sites/:id */
	static async get(_request: Request, env: Env, _ctx: ExecutionContext, context: RouteContext): Promise<Response> {
		const stub = await NovaSitesController.ownedStub(env, context);
		if (!stub) return NovaSitesController.notFound();
		return NovaSitesController.createSuccessResponse(await stub.novaSummary());
	}

	/** POST /api/nova/sites/:id/message {text} — a request to Nova's agent (same as the chat). */
	static async message(request: Request, env: Env, _ctx: ExecutionContext, context: RouteContext): Promise<Response> {
		const stub = await NovaSitesController.ownedStub(env, context);
		if (!stub) return NovaSitesController.notFound();
		const text = NovaSitesController.str((await NovaSitesController.body(request)).text, 100_000)?.trim();
		if (!text) return NovaSitesController.createErrorResponse('Say what to change', 400);
		await stub.novaFollowUp(text);
		return NovaSitesController.createSuccessResponse({ accepted: true });
	}

	/** POST /api/nova/sites/:id/text {find, replace, path?} — click-and-type, no AI. */
	/** POST /api/nova/sites/:id/links {changes: [{from, to, text?}], label}: repoint exact hrefs (only links whose words contain `text`, when given) as one owner change. */
	static async links(request: Request, env: Env, _ctx: ExecutionContext, context: RouteContext): Promise<Response> {
		const stub = await NovaSitesController.ownedStub(env, context);
		if (!stub) return NovaSitesController.notFound();
		const body = await NovaSitesController.body(request);
		const raw = Array.isArray(body.changes) ? body.changes : [];
		const changes = raw
			.map((c: { from?: unknown; to?: unknown; text?: unknown }) => ({ from: NovaSitesController.str(c?.from, 2000), to: NovaSitesController.str(c?.to, 2000), text: NovaSitesController.str(c?.text, 200) }))
			.filter((c): c is { from: string; to: string; text: string | undefined } => !!c.from && !!c.to && !/["'<>\s]/.test(c.to));
		const label = NovaSitesController.str(body.label, 200) ?? 'Changed where links go';
		if (changes.length === 0 || changes.length !== raw.length || changes.length > 100) return NovaSitesController.createErrorResponse('changes: 1–100 of {from, to}', 400);
		try {
			const result = await stub.novaLinkEdit(changes, label);
			if ('error' in result) {
				return new Response(JSON.stringify({ success: false, error: result.error }), { status: 409, headers: { 'Content-Type': 'application/json' } });
			}
			return NovaSitesController.createSuccessResponse(result);
		} catch (error) {
			return NovaSitesController.busyOr(error);
		}
	}

	static async text(request: Request, env: Env, _ctx: ExecutionContext, context: RouteContext): Promise<Response> {
		const stub = await NovaSitesController.ownedStub(env, context);
		if (!stub) return NovaSitesController.notFound();
		const body = await NovaSitesController.body(request);
		const find = NovaSitesController.str(body.find);
		const replace = NovaSitesController.str(body.replace);
		if (find === undefined || replace === undefined) return NovaSitesController.createErrorResponse('find and replace are required', 400);
		try {
			const result = await stub.novaTextEdit(find, replace, NovaSitesController.str(body.path, 300));
			if ('error' in result) {
				return new Response(JSON.stringify({ success: false, error: result.error }), {
					status: 409,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			return NovaSitesController.createSuccessResponse(result);
		} catch (error) {
			return NovaSitesController.busyOr(error);
		}
	}

	/** The Google & sharing fields a body carries (snake_case, as Nova OS sends them); absent stays absent. */
	private static metaFields(body: Json): SiteMeta | null {
		const S = NovaSitesController;
		const meta: SiteMeta = {
			title: S.str(body.title, 200),
			description: S.str(body.description, 500),
			iconUrl: S.str(body.icon_url, 500),
			shareImageUrl: S.str(body.share_image_url, 500),
			appleTouchIconUrl: S.str(body.apple_touch_icon_url, 500),
			canonical: S.str(body.canonical, 500),
			jsonLd: S.str(body.json_ld, 50_000),
		};
		// A field that is present but not a short-enough string is refused, not silently dropped.
		const keys: [string, keyof SiteMeta][] = [
			['title', 'title'],
			['description', 'description'],
			['icon_url', 'iconUrl'],
			['share_image_url', 'shareImageUrl'],
			['apple_touch_icon_url', 'appleTouchIconUrl'],
			['canonical', 'canonical'],
			['json_ld', 'jsonLd'],
		];
		for (const [wire, key] of keys) if (body[wire] !== undefined && body[wire] !== null && meta[key] === undefined) return null;
		return meta;
	}

	/**
	 * POST /api/nova/sites/:id/meta
	 *   {title?, description?, icon_url?, share_image_url?, apple_touch_icon_url?, canonical?, json_ld?, path?}
	 *   one page (`path`, default public/index.html), or
	 *   {pages: [{path, title?, description?, canonical?, json_ld?}], icon_url?, share_image_url?, ..., by?}
	 *   several pages as one change: the top-level fields on every listed page, each page's own on top.
	 *   `by: "nova"` labels the change as Nova's in History (her automatic Google & sharing pass).
	 */
	static async meta(request: Request, env: Env, _ctx: ExecutionContext, context: RouteContext): Promise<Response> {
		const S = NovaSitesController;
		const stub = await S.ownedStub(env, context);
		if (!stub) return S.notFound();
		const body = await S.body(request);
		const shared = S.metaFields(body);
		if (!shared) return S.createErrorResponse('A Google & sharing field is too long or not text', 400);
		try {
			if (body.pages === undefined) {
				const path = S.str(body.path, 300) ?? 'public/index.html';
				return S.createSuccessResponse(await stub.novaSetMeta(shared, path));
			}
			if (!Array.isArray(body.pages) || body.pages.length === 0 || body.pages.length > 100) {
				return S.createErrorResponse('pages is a list of 1 to 100 pages', 400);
			}
			const pages: { path: string; meta: SiteMeta }[] = [];
			for (const raw of body.pages as unknown[]) {
				const page = raw && typeof raw === 'object' ? (raw as Json) : {};
				const path = S.str(page.path, 300);
				const meta = S.metaFields(page);
				if (!path || !meta) return S.createErrorResponse('Each page needs its path, and text fields', 400);
				pages.push({ path, meta });
			}
			const result = await stub.novaSetMetaPages(shared, pages, body.by === 'nova' ? 'nova' : 'you');
			if ('error' in result) {
				return new Response(JSON.stringify({ success: false, error: result.error, path: result.path }), {
					status: 409,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			return S.createSuccessResponse(result);
		} catch (error) {
			if (error instanceof Error && error.message.includes('invalid_json_ld')) return S.createErrorResponse('json_ld is not JSON', 400);
			return S.busyOr(error);
		}
	}

	/** POST /api/nova/sites/:id/read {paths} → {files: [{path, content}]} (missing files are left out). */
	static async read(request: Request, env: Env, _ctx: ExecutionContext, context: RouteContext): Promise<Response> {
		const stub = await NovaSitesController.ownedStub(env, context);
		if (!stub) return NovaSitesController.notFound();
		const paths = (await NovaSitesController.body(request)).paths;
		if (!Array.isArray(paths) || paths.length === 0 || paths.length > 60 || paths.some((p) => typeof p !== 'string' || p.length > 300)) {
			return NovaSitesController.createErrorResponse('paths is a list of 1 to 60 file paths', 400);
		}
		return NovaSitesController.createSuccessResponse({ files: await stub.novaReadFiles(paths as string[]) });
	}

	/** GET /api/nova/sites/:id/history */
	static async history(_request: Request, env: Env, _ctx: ExecutionContext, context: RouteContext): Promise<Response> {
		const stub = await NovaSitesController.ownedStub(env, context);
		if (!stub) return NovaSitesController.notFound();
		return NovaSitesController.createSuccessResponse({ entries: await stub.novaHistory() });
	}

	/** POST /api/nova/sites/:id/restore {hash} */
	static async restore(request: Request, env: Env, _ctx: ExecutionContext, context: RouteContext): Promise<Response> {
		const stub = await NovaSitesController.ownedStub(env, context);
		if (!stub) return NovaSitesController.notFound();
		const hash = NovaSitesController.str((await NovaSitesController.body(request)).hash, 64);
		if (!hash || !/^[0-9a-f]{7,64}$/.test(hash)) return NovaSitesController.createErrorResponse('Pick a version', 400);
		try {
			return NovaSitesController.createSuccessResponse(await stub.novaRestore(hash));
		} catch (error) {
			return NovaSitesController.busyOr(error);
		}
	}

	/** POST /api/nova/sites/:id/publish */
	static async publish(_request: Request, env: Env, _ctx: ExecutionContext, context: RouteContext): Promise<Response> {
		const stub = await NovaSitesController.ownedStub(env, context);
		if (!stub) return NovaSitesController.notFound();
		try {
			return NovaSitesController.createSuccessResponse(await stub.novaPublish());
		} catch (error) {
			return NovaSitesController.busyOr(error);
		}
	}

	/** POST /api/nova/sites/:id/unpublish */
	static async unpublish(_request: Request, env: Env, _ctx: ExecutionContext, context: RouteContext): Promise<Response> {
		const stub = await NovaSitesController.ownedStub(env, context);
		if (!stub) return NovaSitesController.notFound();
		return NovaSitesController.createSuccessResponse(await stub.novaUnpublish());
	}

	/** POST /api/nova/sites/:id/address {name} */
	static async address(request: Request, env: Env, _ctx: ExecutionContext, context: RouteContext): Promise<Response> {
		const stub = await NovaSitesController.ownedStub(env, context);
		if (!stub) return NovaSitesController.notFound();
		const name = NovaSitesController.str((await NovaSitesController.body(request)).name, 63)?.trim();
		if (!name) return NovaSitesController.createErrorResponse('Type the address you want', 400);
		const result = await stub.novaSetAddress(name);
		if ('error' in result) {
			return new Response(JSON.stringify({ success: false, error: result.error }), {
				status: 409,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		return NovaSitesController.createSuccessResponse(result);
	}
}
