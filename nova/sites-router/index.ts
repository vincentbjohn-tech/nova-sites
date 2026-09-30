/**
 * Serves an owner's own domain from their Nova site. The host is looked up in the
 * DOMAINS KV (host -> site name, lower-case, e.g. "www.kristigrace.com" ->
 * "kristine-grace"); the bare domain forwards to www when only www is mapped.
 * The site's own Worker at <name>.<SITES_SUBDOMAIN>.workers.dev answers.
 */
interface Env {
	DOMAINS: KVNamespace;
	SITES_SUBDOMAIN: string;
}

const NOT_HERE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Nova Sites</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#faf9f7;color:#222}main{text-align:center;padding:24px}</style></head><body><main><h1 style="font-weight:500">This address isn't connected to a site yet.</h1><p>If you just connected it, it's usually live within a few minutes.</p></main></body></html>`;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const host = url.hostname.toLowerCase();
		let site = await env.DOMAINS.get(host, { cacheTtl: 60 });
		if (!site && !host.startsWith('www.')) {
			const www = await env.DOMAINS.get(`www.${host}`, { cacheTtl: 60 });
			if (www) return Response.redirect(`https://www.${host}${url.pathname}${url.search}`, 301);
		}
		if (!site) return new Response(NOT_HERE, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
		const target = new URL(url.pathname + url.search, `https://${site}.${env.SITES_SUBDOMAIN}.workers.dev`);
		const headers = new Headers(request.headers);
		headers.set('x-forwarded-host', host);
		const upstream = await fetch(target, { method: request.method, headers, body: request.body, redirect: 'manual' });
		const out = new Response(upstream.body, upstream);
		// Links in the site's own sitemap/robots point at the workers.dev address; say where it really lives.
		out.headers.set('x-nova-site', site);
		return out;
	},
};
