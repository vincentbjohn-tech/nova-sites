/**
 * Nova OS → builder sign-in. Nova OS (the only way owners reach the builder)
 * vouches for a signed-in owner with a short-lived assertion:
 *
 *   base64url(JSON payload) + "." + base64url(HMAC-SHA256(NOVA_SITES_SSO_SECRET, payload part))
 *
 * The payload carries the owner's email, display name, Nova user id and an
 * expiry (unix seconds, at most five minutes out). Nothing else is trusted.
 */

export interface NovaAssertion {
	email: string;
	name: string;
	novaUserId: string;
	exp: number;
}

const MAX_LIFETIME_SECONDS = 300;
const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
	const binary = atob(padded);
	return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data)));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

export async function signNovaAssertion(payload: NovaAssertion, secret: string): Promise<string> {
	const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
	return `${body}.${toBase64Url(await hmac(secret, body))}`;
}

/** The verified owner, or null for anything forged, expired, too long-lived or malformed. */
export async function verifyNovaAssertion(
	assertion: string,
	secret: string | undefined,
	nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<NovaAssertion | null> {
	if (!secret || secret.length < 32 || assertion.length > 2048) return null;
	const parts = assertion.split('.');
	if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
	let signature: Uint8Array;
	try {
		signature = fromBase64Url(parts[1]);
	} catch {
		return null;
	}
	if (!constantTimeEqual(signature, await hmac(secret, parts[0]))) return null;
	let payload: Partial<NovaAssertion>;
	try {
		payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0])));
	} catch {
		return null;
	}
	const { email, name, novaUserId, exp } = payload;
	if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
	if (typeof novaUserId !== 'string' || novaUserId.length === 0) return null;
	if (typeof exp !== 'number' || exp <= nowSeconds || exp > nowSeconds + MAX_LIFETIME_SECONDS) return null;
	return {
		email: email.toLowerCase(),
		name: typeof name === 'string' && name.trim() ? name.trim() : email.split('@')[0],
		novaUserId,
		exp,
	};
}
