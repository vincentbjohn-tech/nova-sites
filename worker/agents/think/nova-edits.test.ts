import { describe, expect, it } from 'vitest';
import { replaceVisibleText, setHeadMeta, readHeadMeta, readPageMeta, planMetaChanges, toHistory, isEditableSource, OWNER_COMMIT_PREFIX, markEarlierRequests, EARLIER_REQUEST_LABEL, netUnpublished, toNetHistory, planLinkChanges } from './nova-edits';

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
	it('counts a restore as the owner\'s change', () => {
		const h = toHistory([{ oid: 'r1', message: 'rollback: restore 1234abcd', author: { timestamp: 1_800_000_400 } }], { r1: 'Went back to: Warm the top photo' });
		expect(h[0]).toMatchObject({ message: 'Went back to: Warm the top photo', by: 'you' });
	});
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

describe('icon and share image: read back and remove', () => {
	it('reads what is set, and an empty value removes the tags', () => {
		const set = setHeadMeta(html, { iconUrl: 'https://m/i.png', shareImageUrl: 'https://m/s.jpg' });
		expect(readHeadMeta(set)).toEqual({ iconUrl: 'https://m/i.png', shareImageUrl: 'https://m/s.jpg' });
		const cleared = setHeadMeta(set, { iconUrl: '', shareImageUrl: '' });
		expect(readHeadMeta(cleared)).toEqual({ iconUrl: null, shareImageUrl: null });
		expect(cleared).not.toContain('twitter:image');
	});
});

describe('Google & sharing: every page, in one change', () => {
	const home = `<!doctype html><html><head><title>Vite App</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg%2F%3E">
<meta content="https://pub-x.r2.dev/lovable-shot.png" property="og:image">
<script type="application/ld+json">{"@type":"WebSite","name":"Kristine Grace"}</script>
</head><body><h1>Hair</h1></body></html>`;
	const about = '<!doctype html><html><head><title>About</title></head><body><p>About Kristi</p></body></html>';
	const pages = [
		{ path: 'public/index.html', content: home },
		{ path: 'public/about.html', content: about },
		{ path: 'src/index.ts', content: 'export {}' },
	];

	it('sets a title and description per page, and shared tags on every page', () => {
		const r = planMetaChanges(pages, { shareImageUrl: 'https://m/s.jpg', iconUrl: 'https://m/i-512.png', appleTouchIconUrl: 'https://m/i-180.png' }, [
			{ path: 'public/index.html', meta: { title: 'Kristi Grace Hair — Balayage in Austin', canonical: 'https://kristi.novasites.workers.dev/' } },
			{ path: '/public/about.html', meta: { description: 'Meet Kristi.', canonical: 'https://kristi.novasites.workers.dev/about' } },
		]);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const byPath = Object.fromEntries(r.changes.map((c) => [c.path, c.content]));
		expect(Object.keys(byPath).sort()).toEqual(['public/about.html', 'public/index.html']);
		expect(byPath['public/index.html']).toContain('<title>Kristi Grace Hair — Balayage in Austin</title>');
		expect(byPath['public/about.html']).toContain('<title>About</title>');
		expect(byPath['public/about.html']).toContain('<meta name="description" content="Meet Kristi.">');
		for (const html of Object.values(byPath)) {
			expect(html).toContain('<meta property="og:image" content="https://m/s.jpg">');
			expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
			expect(html).toContain('<link rel="icon" href="https://m/i-512.png">');
			expect(html).toContain('<link rel="apple-touch-icon" href="https://m/i-180.png">');
			expect(html.match(/og:image"/g)).toHaveLength(1);
		}
		// the attribute-order-swapped foreign og:image was replaced, not duplicated
		expect(byPath['public/index.html']).not.toContain('lovable-shot');
		expect(byPath['public/index.html']).toContain('<link rel="canonical" href="https://kristi.novasites.workers.dev/">');
		expect(byPath['public/index.html']).toContain('<meta property="og:url" content="https://kristi.novasites.workers.dev/">');
		expect(byPath['public/about.html']).toContain('<link rel="canonical" href="https://kristi.novasites.workers.dev/about">');
	});

	it('a page field the request left out never hides a shared one (the controller passes absent fields as undefined)', () => {
		const r = planMetaChanges(pages, { shareImageUrl: 'https://m/s.jpg', iconUrl: 'https://m/i.png' }, [
			{ path: 'public/index.html', meta: { title: undefined, shareImageUrl: undefined, iconUrl: undefined, canonical: 'https://k.novasites.workers.dev/' } },
		]);
		expect(r.ok && r.changes[0].content).toContain('<meta property="og:image" content="https://m/s.jpg">');
		expect(r.ok && r.changes[0].content).toContain('<link rel="icon" href="https://m/i.png">');
	});

	it('refuses a page that is not an HTML file of the site, and changes nothing', () => {
		expect(planMetaChanges(pages, {}, [{ path: 'public/missing.html', meta: { title: 'x' } }])).toEqual({ ok: false, error: 'not_found', path: 'public/missing.html' });
		expect(planMetaChanges(pages, {}, [{ path: 'src/index.ts', meta: { title: 'x' } }])).toEqual({ ok: false, error: 'not_found', path: 'src/index.ts' });
	});

	it('leaves pages that would not change out of the commit', () => {
		const want = [{ path: 'public/about.html', meta: { title: 'About Kristi', description: 'Meet Kristi.' } }];
		const once = planMetaChanges(pages, {}, want);
		expect(once.ok && once.changes.length).toBe(1);
		const after = pages.map((p) => (once.ok && p.path === 'public/about.html' ? once.changes[0] : p));
		expect(planMetaChanges(after, {}, want)).toEqual({ ok: true, changes: [] });
	});

	it('writes Nova\'s business block, replaces it next time, and keeps the owner\'s own JSON-LD', () => {
		const block = { '@context': 'https://schema.org', '@type': 'HairSalon', name: 'Kristi </script><script>alert(1)</script>' };
		const once = setHeadMeta(home, { jsonLd: JSON.stringify(block) });
		expect(once.match(/data-nova="business"/g)).toHaveLength(1);
		expect(once).toContain('{"@type":"WebSite","name":"Kristine Grace"}');
		expect(once).not.toContain('</script><script>alert(1)');
		const script = /<script type="application\/ld\+json" data-nova="business">([\s\S]*?)<\/script>/.exec(once)?.[1] ?? '';
		expect(JSON.parse(script).name).toBe('Kristi </script><script>alert(1)</script>');
		const twice = setHeadMeta(once, { jsonLd: JSON.stringify({ ...block, name: 'Kristi Grace Hair' }) });
		expect(twice.match(/data-nova="business"/g)).toHaveLength(1);
		expect(twice).toContain('Kristi Grace Hair');
		expect(readPageMeta(twice).jsonLd).toContain('"HairSalon"');
		const removed = setHeadMeta(twice, { jsonLd: '' });
		expect(removed).not.toContain('data-nova="business"');
		expect(removed).toContain('"WebSite"');
	});

	it('refuses JSON-LD that is not JSON', () => {
		expect(() => setHeadMeta(home, { jsonLd: '{not json' })).toThrow('invalid_json_ld');
	});

	it('reads back everything Settings shows', () => {
		const html = setHeadMeta(home, {
			title: 'Kristi & Co',
			description: 'Color "that lasts".',
			canonical: 'https://www.kristigrace.com/',
			shareImageUrl: 'https://m/s.jpg?a=1&b=2',
		});
		expect(readPageMeta(html)).toEqual({
			title: 'Kristi & Co',
			description: 'Color "that lasts".',
			canonical: 'https://www.kristigrace.com/',
			iconUrl: 'data:image/svg+xml,%3Csvg%2F%3E',
			appleTouchIconUrl: null,
			shareImageUrl: 'https://m/s.jpg?a=1&b=2',
			jsonLd: null,
		});
		expect(readPageMeta(setHeadMeta(html, { canonical: '' })).canonical).toBeNull();
		expect(setHeadMeta(html, { canonical: '' })).not.toContain('og:url');
	});
});

describe('markEarlierRequests', () => {
	it('labels every owner message except the newest one', () => {
		const out = markEarlierRequests([
			{ role: 'user', content: 'Add a New clients line' },
			{ role: 'assistant', content: 'Added it.' },
			{ role: 'user', content: [{ type: 'text', text: 'Change the About heading' }] },
			{ role: 'assistant', content: 'Changed it.' },
			{ role: 'user', content: 'Make the button say Book now' },
		]);
		expect(out[0].content).toBe(`${EARLIER_REQUEST_LABEL}\nAdd a New clients line`);
		expect(out[2].content).toEqual([
			{ type: 'text', text: EARLIER_REQUEST_LABEL },
			{ type: 'text', text: 'Change the About heading' },
		]);
		expect(out[4].content).toBe('Make the button say Book now');
		expect(out[1].content).toBe('Added it.');
	});
});

describe('netUnpublished', () => {
	const c = (oid: string, message: string) => ({ oid, message, author: { timestamp: 1_800_000_000 } });
	const labels = { f0000000: 'Start', a0000000: 'Say hi', b0000000: 'Meet Kristine', d0000000: 'Book now', e1000000: 'Went back to: Say hi', e2000000: 'Went back to: Start' };

	it('lists nothing when the draft went back to the live version', () => {
		const log = [c('e2000000', 'rollback: restore f0000000'), c('b0000000', 'x'), c('a0000000', 'x'), c('f0000000', 'x')].map((e) => e);
		expect(netUnpublished(log, labels, 'f0000000')).toEqual([]);
		expect(toNetHistory(log, labels).map((e) => e.message)).toEqual(['Start']);
	});

	it('drops an undone change and the restore itself', () => {
		const log = [c('d0000000', 'x'), c('e1000000', 'rollback: restore a0000000'), c('b0000000', 'x'), c('a0000000', 'x'), c('f0000000', 'x')];
		expect(netUnpublished(log, labels, 'f0000000').map((e) => e.message)).toEqual(['Say hi', 'Book now']);
		expect(toNetHistory(log, labels).map((e) => e.message)).toEqual(['Book now', 'Say hi', 'Start']);
	});

	it('lists every change once it is past the live version', () => {
		const log = [c('b0000000', 'x'), c('a0000000', 'x'), c('f0000000', 'x')];
		expect(netUnpublished(log, labels, 'f0000000').map((e) => e.message)).toEqual(['Say hi', 'Meet Kristine']);
	});

	it('says so when the draft takes back something that is live', () => {
		const log = [c('e2000000', 'rollback: restore f0000000'), c('a0000000', 'x'), c('f0000000', 'x')];
		expect(netUnpublished(log, labels, 'a0000000').map((e) => e.message)).toEqual(['Takes back changes that are live now']);
	});
});

describe('planLinkChanges', () => {
	it('repoints exact hrefs in pages, and nothing else (not a selector in a script)', () => {
		const sq = 'https://book.squareup.com/appointments/x/services/HAIRCUT';
		const files = [
			{ path: 'public/index.html', content: `<a href="${sq}">Haircut</a><a href="#book">Book</a><a href="${sq}-2">Other</a><p>${sq}</p>` },
			{ path: 'public/site.js', content: `$$('a[href="#book"]').forEach(scroll);` },
			{ path: 'public/style.css', content: `/* href="#book" */` },
		];
		const plan = planLinkChanges(files, [
			{ from: sq, to: 'https://os.usenovaos.com/book/k?service=1' },
			{ from: '#book', to: 'https://os.usenovaos.com/book/k' },
		]);
		expect(plan.counts).toEqual([1, 1]);
		expect(plan.files.map((f) => f.path)).toEqual(['public/index.html']);
		expect(plan.files[0].content).toBe(
			`<a href="https://os.usenovaos.com/book/k?service=1">Haircut</a><a href="https://os.usenovaos.com/book/k">Book</a><a href="${sq}-2">Other</a><p>${sq}</p>`,
		);
	});
});
