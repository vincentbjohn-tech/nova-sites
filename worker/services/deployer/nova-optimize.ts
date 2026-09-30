/**
 * Nova Sites: make a published page fast on a phone without touching what
 * the agent wrote. Applied to HTML at publish time only (the preview keeps
 * the source as written):
 *
 * - web-font stylesheets (Google Fonts and the like) load without blocking
 *   the first paint (preload + swap to stylesheet, with a <noscript> copy);
 * - small local stylesheets are inlined, removing a render-blocking request.
 */

const INLINE_CSS_MAX_BYTES = 40_000;
const FONT_HOSTS = /^https:\/\/(fonts\.googleapis\.com|use\.typekit\.net|fonts\.bunny\.net|api\.fontshare\.com)\//;

function hrefOf(tag: string): string | null {
	return /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? null;
}

function isStylesheet(tag: string): boolean {
	return /\brel\s*=\s*["']stylesheet["']/i.test(tag) && !/\bmedia\s*=\s*["']print["']/i.test(tag);
}

/** Resolve a stylesheet href against the page path to an asset key (`/styles.css`). */
function assetKey(href: string, pagePath: string): string | null {
	if (/^(https?:)?\/\//i.test(href) || href.startsWith('data:')) return null;
	const clean = href.split(/[?#]/)[0];
	if (clean.startsWith('/')) return clean;
	const base = pagePath.slice(0, pagePath.lastIndexOf('/') + 1) || '/';
	return new URL(clean, `https://x${base}`).pathname;
}

export function optimizeHtmlForPublish(html: string, pagePath: string, assets: Record<string, string>): string {
	return html.replace(/<link\b[^>]*>/gi, (tag) => {
		if (!isStylesheet(tag)) return tag;
		const href = hrefOf(tag);
		if (!href) return tag;
		if (FONT_HOSTS.test(href)) {
			const attr = href.replace(/"/g, '&quot;');
			return (
				`<link rel="preload" as="style" href="${attr}" onload="this.onload=null;this.rel='stylesheet'">` +
				`<noscript><link rel="stylesheet" href="${attr}"></noscript>`
			);
		}
		const key = assetKey(href, pagePath);
		const css = key ? assets[key] ?? assets[key.slice(1)] : undefined;
		if (css === undefined || new TextEncoder().encode(css).length > INLINE_CSS_MAX_BYTES) return tag;
		if (/@import\s/i.test(css) || css.includes('</style')) return tag;
		return `<style data-nova-inlined="${key}">${css}</style>`;
	});
}

/** Apply to every HTML page of a bundle's assets (keys as the bundle has them). */
export function optimizeAssetsForPublish(assets: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [path, content] of Object.entries(assets)) {
		out[path] = /\.html?$/i.test(path)
			? optimizeHtmlForPublish(content, path.startsWith('/') ? path : `/${path}`, assets)
			: content;
	}
	return out;
}

/**
 * A published site always answers /robots.txt and /sitemap.xml (search engines
 * ask for both; without them the page's HTML comes back instead). The agent's
 * own files win when it wrote them.
 */
export function withSearchFiles(assets: Record<string, string>, siteUrl: string): Record<string, string> {
	const has = (name: string) => name in assets || `/${name}` in assets;
	const out = { ...assets };
	const base = siteUrl.replace(/\/+$/, '');
	if (!has('sitemap.xml')) {
		const pages = Object.keys(assets)
			.filter((p) => /\.html?$/i.test(p) && !/(^|\/)404\.html?$/i.test(p))
			.map((p) => (p.startsWith('/') ? p : `/${p}`).replace(/index\.html?$/i, ''))
			.sort();
		const urls = pages.map((p) => `  <url><loc>${base}${p}</loc></url>`).join('\n');
		out['sitemap.xml'] = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
	}
	if (!has('robots.txt')) {
		out['robots.txt'] = `User-agent: *\nAllow: /\n\nSitemap: ${base}/sitemap.xml\n`;
	}
	return out;
}
