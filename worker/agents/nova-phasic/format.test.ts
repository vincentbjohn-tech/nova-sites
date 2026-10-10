import { describe, expect, it } from 'vitest';
import { applyEdits, isWritablePath, parsePhaseOutput } from './format';

const answer = `Sure, here it is.
<<<FILE public/index.html>>>
<!doctype html>
<h1>Kristi</h1>
<<<END FILE>>>
<<<EDIT public/services.html>>>
<<<FIND>>>
<h2>Services</h2>
<<<REPLACE>>>
<h2>What I do</h2>
<<<FIND>>>
<li>Cut</li>
<<<REPLACE>>>
<li>Cut</li>
<li>Gloss</li>
<<<END EDIT>>>
<<<REPLY>>>
Your home page is in, and the services list has gloss now.
<<<END REPLY>>>`;

describe('a phase answer → files, edits and the reply', () => {
	it('reads whole files, every find/replace pair and the reply', () => {
		const out = parsePhaseOutput(answer);
		expect(out.files).toEqual([{ path: 'public/index.html', content: '<!doctype html>\n<h1>Kristi</h1>\n' }]);
		expect(out.edits).toEqual([
			{ path: 'public/services.html', find: '<h2>Services</h2>', replace: '<h2>What I do</h2>' },
			{ path: 'public/services.html', find: '<li>Cut</li>', replace: '<li>Cut</li>\n<li>Gloss</li>' },
		]);
		expect(out.reply).toBe('Your home page is in, and the services list has gloss now.');
		expect(out.unterminated).toEqual([]);
	});

	it('an unterminated file is not written (the answer was cut off)', () => {
		const out = parsePhaseOutput('<<<FILE public/a.html>>>\n<h1>half');
		expect(out.files).toEqual([]);
		expect(out.unterminated).toEqual(['public/a.html']);
	});

	it('an unterminated edit is not applied', () => {
		const out = parsePhaseOutput('<<<EDIT public/a.html>>>\n<<<FIND>>>\nx\n<<<REPLACE>>>\ny');
		expect(out.edits).toEqual([]);
		expect(out.unterminated).toEqual(['public/a.html']);
	});

	it('only public files are written; config, code and escapes are dropped', () => {
		const out = parsePhaseOutput(
			'<<<FILE wrangler.json>>>\n{}\n<<<END FILE>>>\n<<<FILE public/../src/index.ts>>>\nx\n<<<END FILE>>>\n<<<FILE /public/ok.css>>>\nb{}\n<<<END FILE>>>',
		);
		expect(out.files).toEqual([{ path: 'public/ok.css', content: 'b{}\n' }]);
		expect(out.dropped).toEqual(['wrangler.json', 'public/../src/index.ts']);
		expect(isWritablePath('public/img/a.svg')).toBe(true);
		expect(isWritablePath('src/index.ts')).toBe(false);
	});

	it('a file fenced in markdown inside the block keeps only the code', () => {
		const out = parsePhaseOutput('<<<FILE public/a.css>>>\n```css\nb{}\n```\n<<<END FILE>>>');
		expect(out.files[0].content).toBe('b{}\n');
	});
});

describe('find/replace edits on a file', () => {
	const page = '<main>\n  <h2>Services</h2>\n  <ul>\n    <li>Cut</li>\n  </ul>\n</main>\n';

	it('applies an exact match', () => {
		const r = applyEdits(page, [{ find: '<h2>Services</h2>', replace: '<h2>Menu</h2>' }]);
		expect(r.content).toContain('<h2>Menu</h2>');
		expect(r.missed).toEqual([]);
	});

	it('whitespace-tolerant match: the model quoted the indentation wrong', () => {
		const r = applyEdits(page, [{ find: '<ul>\n<li>Cut</li>\n</ul>', replace: '<ul><li>Cut</li><li>Gloss</li></ul>' }]);
		expect(r.content).toBe('<main>\n  <h2>Services</h2>\n  <ul><li>Cut</li><li>Gloss</li></ul>\n</main>\n');
		expect(r.missed).toEqual([]);
	});

	it('a find that is not there is reported, never guessed', () => {
		const r = applyEdits(page, [{ find: '<h3>Prices</h3>', replace: 'x' }]);
		expect(r.content).toBe(page);
		expect(r.missed).toHaveLength(1);
	});

	it('a find that is there twice is reported (ambiguous), never applied to both', () => {
		const twice = '<p>a</p><p>a</p>';
		const r = applyEdits(twice, [{ find: '<p>a</p>', replace: '<p>b</p>' }]);
		expect(r.content).toBe(twice);
		expect(r.missed).toHaveLength(1);
	});

	it('edits apply in order, each on the result of the one before', () => {
		const r = applyEdits('<p>a</p>', [
			{ find: '<p>a</p>', replace: '<p>b</p>' },
			{ find: '<p>b</p>', replace: '<p>c</p>' },
		]);
		expect(r.content).toBe('<p>c</p>');
	});
});

describe('the shared header and footer (the look phase hands them to every page)', () => {
	it('reads a LAYOUT block and keeps it out of the files', () => {
		const out = parsePhaseOutput('<<<FILE public/styles.css>>>\nb{}\n<<<END FILE>>>\n<<<LAYOUT>>>\n<header>H</header>\n<footer>F</footer>\n<<<END LAYOUT>>>');
		expect(out.layout).toBe('<header>H</header>\n<footer>F</footer>');
		expect(out.files.map((f) => f.path)).toEqual(['public/styles.css']);
	});
});

describe('APPEND: rules added at the end of a file (no anchor to find)', () => {
	it('reads an APPEND block as an edit that adds to the end', () => {
		const out = parsePhaseOutput('<<<APPEND public/styles.css>>>\n.price{color:red}\n<<<END APPEND>>>');
		expect(out.edits).toEqual([{ path: 'public/styles.css', find: '', replace: '.price{color:red}' }]);
	});
	it('applies it after the file, on its own line', () => {
		expect(applyEdits('body{}', [{ find: '', replace: '.a{}' }])).toEqual({ content: 'body{}\n.a{}\n', missed: [] });
	});
});

describe('classes a page uses that the stylesheet never styles', () => {
	it('lists them, ignoring ones the page styles itself and the usual state classes', async () => {
		const { unstyledClasses } = await import('./format');
		const pages = [
			{ path: 'public/index.html', content: '<div class="hero hero--big is-open"><p class="price lede">x</p><style>.lede{}</style></div>' },
			{ path: 'public/about.html', content: '<section class="card  story">y</section>' },
		];
		const css = '.hero{} .hero--big:hover{} .card,.x{} @media (min-width:600px){.price{}}';
		expect(unstyledClasses(pages, css)).toEqual(['story']);
	});
});

describe('the marker with the path after it (a common slip) still counts', () => {
	it('reads <<<APPEND>>> path, <<<FILE>>> path and <<<EDIT>>> path', () => {
		const out = parsePhaseOutput(
			'<<<APPEND>>> public/styles.css\n.a{}\n<<<END APPEND>>>\n<<<FILE>>> public/x.html\n<h1>x</h1>\n<<<END FILE>>>\n<<<EDIT>>> public/y.html\n<<<FIND>>>\na\n<<<REPLACE>>>\nb\n<<<END EDIT>>>',
		);
		expect(out.edits).toEqual([
			{ path: 'public/styles.css', find: '', replace: '.a{}' },
			{ path: 'public/y.html', find: 'a', replace: 'b' },
		]);
		expect(out.files).toEqual([{ path: 'public/x.html', content: '<h1>x</h1>\n' }]);
	});
});

describe('a new page is a full page (Vincent, 11 Oct: as rich as the old builder\'s)', () => {
	it('names what a page is missing: too few sections, no photo in its opening section', async () => {
		const { pageShortfalls } = await import('./format');
		const thin = '<header>H</header><section class="hero"><h1>Contact</h1><p>Hi</p></section><section>form</section>';
		expect(pageShortfalls('public/contact.html', thin)).toEqual([
			'public/contact.html has 2 sections; a full page here has at least 4',
			'public/contact.html opens without a photo; its first section needs one (an <img> or a background image)',
		]);
		const home = `<section class="hero"><img src="a.jpg" alt=""></section>${'<section>x</section>'.repeat(5)}`;
		expect(pageShortfalls('public/index.html', home)).toEqual([]);
		expect(pageShortfalls('public/index.html', home.replace('<section>x</section>', ''))).toEqual(['public/index.html has 5 sections; a full page here has at least 6']);
		const bg = `<section class="hero" style="background-image:url(b.jpg)">x</section>${'<section>y</section>'.repeat(3)}`;
		expect(pageShortfalls('public/about.html', bg)).toEqual([]);
		expect(pageShortfalls('public/404.html', '<section>x</section>')).toEqual([]);
	});
});

describe('a FIND or REPLACE closed with a stray XML tag (a common slip, 11 Oct) still matches', () => {
	it('drops a trailing </FIND> or </REPLACE> line from the block', () => {
		const out = parsePhaseOutput('<<<EDIT public/a.html>>>\n<<<FIND>>>\n<h2>Before you book.</h2>\n</FIND>\n<<<REPLACE>>>\n<h2>First visit</h2>\n</REPLACE>\n<<<END EDIT>>>');
		expect(out.edits).toEqual([{ path: 'public/a.html', find: '<h2>Before you book.</h2>', replace: '<h2>First visit</h2>' }]);
	});
	it('keeps a real closing tag that is part of the page', () => {
		const out = parsePhaseOutput('<<<EDIT public/a.html>>>\n<<<FIND>>>\n<p>x</p>\n</section>\n<<<REPLACE>>>\n<p>y</p>\n</section>\n<<<END EDIT>>>');
		expect(out.edits[0]).toEqual({ path: 'public/a.html', find: '<p>x</p>\n</section>', replace: '<p>y</p>\n</section>' });
	});
});
