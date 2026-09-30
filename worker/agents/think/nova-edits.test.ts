import { describe, expect, it } from 'vitest';
import { replaceVisibleText, setHeadMeta, toHistory, isEditableSource, OWNER_COMMIT_PREFIX } from './nova-edits';

const html = `<!doctype html><html><head><title>Kristi Grace Hair</title></head><body>
  <h1>Hair that feels
    <em>like you.</em></h1>
  <p>Kristi&rsquo;s chair &amp; coffee.</p>
  <a class="btn">Book now</a><a class="btn">Book now</a>
</body></html>`;
const files = [
	{ path: 'public/index.html', content: html },
	{ path: 'wrangler.json', content: '{"name":"Book now"}' },
	{ path: 'src/App.tsx', content: String.raw`const t = 'Kristi\'s salon';` },
];

describe('click-and-type: replace the visible text in the source', () => {
	it('replaces text the browser shows on one line though the source breaks it', () => {
		const r = replaceVisibleText(files, 'Hair that feels', 'Hair that fits');
		expect(r).toMatchObject({ ok: true, path: 'public/index.html' });
		expect(r.ok && r.content).toContain('<h1>Hair that fits\n    <em>like you.</em>');
	});
	it('matches typographic apostrophes and entities, and escapes what it writes into HTML', () => {
		const r = replaceVisibleText(files, 'Kristi’s chair & coffee.', 'Kristi’s chair & tea <3');
		expect(r.ok && r.content).toContain('<p>Kristi’s chair &amp; tea &lt;3</p>');
	});
	it('finds text inside a JS string with an escaped quote', () => {
		const r = replaceVisibleText(files, "Kristi's salon", 'Kristi Grace');
		expect(r).toMatchObject({ ok: true, path: 'src/App.tsx' });
		expect(r.ok && r.content).toBe("const t = 'Kristi Grace';");
	});
	it('refuses to guess: twice is ambiguous, absent is not_found, config is never edited', () => {
		expect(replaceVisibleText(files, 'Book now', 'Book')).toEqual({ ok: false, error: 'ambiguous' });
		expect(replaceVisibleText(files, 'Nails', 'Hair')).toEqual({ ok: false, error: 'not_found' });
		expect(replaceVisibleText(files, '   ', 'x')).toEqual({ ok: false, error: 'empty' });
		expect(isEditableSource('wrangler.json')).toBe(false);
		expect(isEditableSource('node_modules/x/index.js')).toBe(false);
	});
});

describe('Google & sharing: head tags', () => {
	it('replaces the title and adds description, icon and share image', () => {
		const out = setHeadMeta(html, {
			title: 'Kristi Grace Hair — Balayage & Color in Austin',
			description: 'Honey balayage in Austin. Book online in a minute.',
			iconUrl: 'https://media.novasites.workers.dev/k/icon.png',
			shareImageUrl: 'https://media.novasites.workers.dev/k/share.webp',
		});
		expect(out).toContain('<title>Kristi Grace Hair — Balayage &amp; Color in Austin</title>');
		expect(out).toContain('<meta name="description" content="Honey balayage in Austin. Book online in a minute.">');
		expect(out).toContain('<meta property="og:image" content="https://media.novasites.workers.dev/k/share.webp">');
		expect(out).toContain('<link rel="icon" href="https://media.novasites.workers.dev/k/icon.png">');
		expect(setHeadMeta(out, { title: 'Again' }).match(/<title>/g)).toHaveLength(1);
	});
});

describe('History', () => {
	it('says who did it in plain words and hides setup commits', () => {
		const h = toHistory(
			[
				{ oid: 'c3', message: `${OWNER_COMMIT_PREFIX}Headline changed`, author: { timestamp: 1_800_000_300 } },
				{ oid: 'c2', message: 'deploy: snapshot working tree', author: { timestamp: 1_800_000_200 } },
				{ oid: 'c1', message: 'chore: initialize think space', author: { timestamp: 1_800_000_100 } },
			],
			{ c2: 'Warm the top photo' },
		);
		expect(h.map((e) => [e.hash, e.message, e.by])).toEqual([
			['c3', 'Headline changed', 'you'],
			['c2', 'Warm the top photo', 'nova'],
		]);
	});
});
