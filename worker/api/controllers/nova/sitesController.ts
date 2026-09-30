import { BaseController } from '../baseController';
import type { RouteContext } from '../../types/route-context';
import { AppService } from '../../../database/services/AppService';
import { getAgentStub } from '../../../agents';
import { CodingAgentController } from '../agent/controller';

/** The free address domain: `<name>.<NOVA_SITES_SUBDOMAIN>.workers.dev`. */
function siteAddress(env: Env, deploymentId: string | null): string | null {
	const subdomain = (env as unknown as { NOVA_SITES_SUBDOMAIN?: string }).NOVA_SITES_SUBDOMAIN || 'novasites';
	return deploymentId ? `https://${deploymentId}.${subdomain}.workers.dev` : null;
}

type Json = Record<string, unknown>;

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
		const prompt = NovaSitesController.str((await NovaSitesController.body(request)).prompt, 20_000)?.trim();
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
		const text = NovaSitesController.str((await NovaSitesController.body(request)).text, 20_000)?.trim();
		if (!text) return NovaSitesController.createErrorResponse('Say what to change', 400);
		await stub.novaFollowUp(text);
		return NovaSitesController.createSuccessResponse({ accepted: true });
	}

	/** POST /api/nova/sites/:id/text {find, replace, path?} — click-and-type, no AI. */
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

	/** POST /api/nova/sites/:id/meta {title?, description?, icon_url?, share_image_url?} */
	static async meta(request: Request, env: Env, _ctx: ExecutionContext, context: RouteContext): Promise<Response> {
		const stub = await NovaSitesController.ownedStub(env, context);
		if (!stub) return NovaSitesController.notFound();
		const body = await NovaSitesController.body(request);
		try {
			return NovaSitesController.createSuccessResponse(
				await stub.novaSetMeta({
					title: NovaSitesController.str(body.title, 200),
					description: NovaSitesController.str(body.description, 500),
					iconUrl: NovaSitesController.str(body.icon_url, 500),
					shareImageUrl: NovaSitesController.str(body.share_image_url, 500),
				}),
			);
		} catch (error) {
			return NovaSitesController.busyOr(error);
		}
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
