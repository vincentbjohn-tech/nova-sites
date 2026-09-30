import { describe, expect, it } from 'vitest';
import { optimizeAssetsForPublish, optimizeHtmlForPublish, withSearchFiles } from './nova-optimize';

const page = `<head>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Jost:wght@300&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="https://cdn.example.com/lib.css">
<link rel="icon" href="/favicon.svg">
</head>`;

describe('publish-time page speed', () => {
	it('loads web fonts without blocking and inlines a small local stylesheet', () => {
		const out = optimizeHtmlForPublish(page, '/index.html', { '/styles.css': 'body{color:#111}' });
		expect(out).toContain('<link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=Jost:wght@300&display=swap" onload="this.onload=null;this.rel=\'stylesheet\'">');
		expect(out).toContain('<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Jost:wght@300&display=swap"></noscript>');
		expect(out).toContain('<style data-nova-inlined="/styles.css">body{color:#111}</style>');
		expect(out).toContain('<link rel="stylesheet" href="https://cdn.example.com/lib.css">');
		expect(out).toContain('<link rel="preconnect" href="https://fonts.googleapis.com">');
		expect(out).toContain('<link rel="icon" href="/favicon.svg">');
	});
	it('keeps big stylesheets, ones with @import, and missing ones as links', () => {
		const big = 'a{}'.repeat(20_000);
		expect(optimizeHtmlForPublish(page, '/index.html', { '/styles.css': big })).toContain('<link rel="stylesheet" href="/styles.css">');
		expect(optimizeHtmlForPublish(page, '/index.html', { '/styles.css': '@import url(x.css);' })).toContain('<link rel="stylesheet" href="/styles.css">');
		expect(optimizeHtmlForPublish(page, '/index.html', {})).toContain('<link rel="stylesheet" href="/styles.css">');
	});
	it('resolves relative stylesheets and only rewrites HTML files', () => {
		const assets = { 'about/index.html': '<link rel="stylesheet" href="page.css">', 'about/page.css': 'p{}', 'styles.css': 'x{}' };
		const out = optimizeAssetsForPublish(assets);
		expect(out['about/index.html']).toBe('<style data-nova-inlined="/about/page.css">p{}</style>');
		expect(out['styles.css']).toBe('x{}');
	});
});

describe('search files', () => {
	it('adds robots.txt and a sitemap of the pages when the site has none', () => {
		const out = withSearchFiles({ 'index.html': '', 'about/index.html': '', '404.html': '', 'styles.css': '' }, 'https://kristi.novasites.workers.dev/');
		expect(out['robots.txt']).toBe('User-agent: *\nAllow: /\n\nSitemap: https://kristi.novasites.workers.dev/sitemap.xml\n');
		expect(out['sitemap.xml']).toContain('<loc>https://kristi.novasites.workers.dev/</loc>');
		expect(out['sitemap.xml']).toContain('<loc>https://kristi.novasites.workers.dev/about/</loc>');
		expect(out['sitemap.xml']).not.toContain('404');
	});
	it('keeps the ones the site already has', () => {
		const out = withSearchFiles({ '/robots.txt': 'mine', 'index.html': '' }, 'https://k.novasites.workers.dev');
		expect(out['/robots.txt']).toBe('mine');
		expect(out['robots.txt']).toBeUndefined();
	});
});
