import { BaseController } from '../baseController';
import type { RouteContext } from '../../types/route-context';
import { SessionService } from '../../../database/services/SessionService';
import { UserService } from '../../../database/services/UserService';
import { setSecureAuthCookies } from '../../../utils/authUtils';
import { generateId } from '../../../utils/idGenerator';
import { buildEditScript } from './editScript';
import { verifyNovaAssertion } from '../../../services/nova/novaAssertion';

interface NovaEnv {
	NOVA_SITES_SSO_SECRET?: string;
	/** Comma-separated Nova OS origins allowed to frame previews and receive edits. */
	NOVA_OS_ORIGINS?: string;
}

export function novaOsOrigins(env: Env): string[] {
	return ((env as unknown as NovaEnv).NOVA_OS_ORIGINS ?? 'https://os.usenovaos.com')
		.split(',')
		.map((o) => o.trim())
		.filter(Boolean);
}

/**
 * Sign-in from Nova OS, the only door to the builder for owners. Nova OS
 * signs a short-lived assertion for its signed-in owner; this finds or
 * creates that owner's builder account and opens a session.
 */
export class NovaController extends BaseController {
	private static async openSession(request: Request, env: Env, assertion: string | null) {
		const owner = assertion
			? await verifyNovaAssertion(assertion, (env as unknown as NovaEnv).NOVA_SITES_SSO_SECRET)
			: null;
		if (!owner) return null;
		const users = new UserService(env);
		const user =
			(await users.findUser({ email: owner.email })) ??
			(await users.createUser({
				id: generateId(),
				email: owner.email,
				displayName: owner.name,
				emailVerified: true,
				provider: 'nova',
				providerId: owner.novaUserId,
			}));
		if (user.deletedAt || !user.isActive || user.isSuspended) return null;
		const { session, accessToken } = await new SessionService(env).createSession(user.id, request);
		return { user, session, accessToken };
	}

	/** POST /api/nova/session — `Authorization: Bearer <assertion>` → an access token for the SDK. */
	static async session(request: Request, env: Env, _ctx: ExecutionContext, _context: RouteContext): Promise<Response> {
		const header = request.headers.get('Authorization')?.trim() ?? '';
		const assertion = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
		const opened = await NovaController.openSession(request, env, assertion);
		if (!opened) return NovaController.createErrorResponse('Not signed in to Nova OS', 401);
		const response = NovaController.createSuccessResponse({
			accessToken: opened.accessToken,
			expiresAt: opened.session.expiresAt,
			user: { id: opened.user.id, email: opened.user.email, displayName: opened.user.displayName },
		});
		setSecureAuthCookies(response, { accessToken: opened.accessToken, accessTokenExpiry: SessionService.config.sessionTTL });
		return response;
	}

	/** GET /api/nova/enter?assertion=…&to=/chat/<id> — opens the builder signed in, then goes to `to`. */
	static async enter(request: Request, env: Env, _ctx: ExecutionContext, _context: RouteContext): Promise<Response> {
		const url = new URL(request.url);
		const opened = await NovaController.openSession(request, env, url.searchParams.get('assertion'));
		if (!opened) return new Response('Open the Website page from Nova OS to sign in.', { status: 401 });
		const to = url.searchParams.get('to') ?? '/';
		const target = to.startsWith('/') && !to.startsWith('//') ? to : '/';
		const response = new Response(null, { status: 302, headers: { Location: target } });
		setSecureAuthCookies(response, { accessToken: opened.accessToken, accessTokenExpiry: SessionService.config.sessionTTL });
		return response;
	}

	/** GET /api/nova/edit.js — click-and-type inside the preview (contract §3). */
	static async editScript(_request: Request, env: Env, _ctx: ExecutionContext, _context: RouteContext): Promise<Response> {
		return new Response(buildEditScript(novaOsOrigins(env)), {
			headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
		});
	}
}
