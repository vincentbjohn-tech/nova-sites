/**
 * Serves the Nova Sites media library (R2 bucket nova-sites-media) at
 * media.novasites.workers.dev/<key>. Read-only: uploads go through Nova OS.
 * Keys are content-addressed, so every file is cached for a year; video
 * supports Range requests so players can seek.
 */
interface Env {
	MEDIA: R2Bucket;
}

const YEAR = 'public, max-age=31536000, immutable';

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
		}
		const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
		if (!key || key.includes('..')) return new Response('Not found', { status: 404 });
		const object = await env.MEDIA.get(key, { range: request.headers, onlyIf: request.headers });
		if (!object) return new Response('Not found', { status: 404 });
		const headers = new Headers();
		object.writeHttpMetadata(headers);
		headers.set('etag', object.httpEtag);
		headers.set('cache-control', YEAR);
		headers.set('accept-ranges', 'bytes');
		headers.set('access-control-allow-origin', '*');
		if (!('body' in object) || !object.body) return new Response(null, { status: 304, headers });
		if (request.headers.has('range') && object.range && 'offset' in object.range) {
			const { offset = 0, length = object.size - offset } = object.range as { offset?: number; length?: number };
			headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
			headers.set('content-length', String(length));
			return new Response(request.method === 'HEAD' ? null : object.body, { status: 206, headers });
		}
		headers.set('content-length', String(object.size));
		return new Response(request.method === 'HEAD' ? null : object.body, { headers });
	},
};
