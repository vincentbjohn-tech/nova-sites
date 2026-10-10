import { describe, expect, it } from 'vitest';
import { runRequest, type RunnerDeps } from './runner';

type Event = { type: string; data: Record<string, unknown> };

function fakeSite(files: Record<string, string>, answers: (string | ((prompt: string) => string))[], opts: { browserErrors?: string[][]; slowMs?: number } = {}) {
	const events: Event[] = [];
	const prompts: string[] = [];
	const writes: string[] = [];
	let deploys = 0;
	let deploying = 0;
	let mostDeploying = 0;
	const browser = [...(opts.browserErrors ?? [])];
	const deps: RunnerDeps = {
		async model(messages) {
			const prompt = messages.map((m) => m.content).join('\n');
			prompts.push(prompt);
			if (opts.slowMs) await new Promise((r) => setTimeout(r, opts.slowMs));
			const next = answers.shift();
			if (next === undefined) throw new Error('no more answers');
			return typeof next === 'function' ? next(prompt) : next;
		},
		async listFiles() {
			return Object.keys(files);
		},
		async readFile(path) {
			if (!(path in files)) throw new Error('ENOENT');
			return files[path];
		},
		async writeFile(path, content) {
			files[path] = content;
			writes.push(path);
		},
		async deploy() {
			deploying += 1;
			mostDeploying = Math.max(mostDeploying, deploying);
			await new Promise((r) => setTimeout(r, 5));
			deploying -= 1;
			deploys += 1;
			return `https://preview/${deploys}`;
		},
		async browserCheck() {
			return browser.shift() ?? [];
		},
		emit(type, data) {
			events.push({ type, data });
		},
	};
	return { deps, events, prompts, writes, files, get deploys() { return deploys; }, get mostDeploying() { return mostDeploying; } };
}

const types = (events: Event[]) => events.map((e) => e.type);

describe('a question: words only, nothing built', () => {
	it('answers and never writes, deploys or checks', async () => {
		const s = fakeSite({ 'public/index.html': '<h1>Hi</h1>' }, ['<<<REPLY>>>\nYour site has one page: Home.\n<<<END REPLY>>>']);
		const r = await runRequest(s.deps, { request: 'What pages do I have?' });
		expect(r).toMatchObject({ reply: 'Your site has one page: Home.', changed: false });
		expect(s.writes).toEqual([]);
		expect(s.deploys).toBe(0);
		expect(s.prompts[0]).toContain('<h1>Hi</h1>');
	});
});

describe('a small change: done in the first answer, one deploy', () => {
	it('applies the edit, deploys once, says what changed', async () => {
		const s = fakeSite({ 'public/index.html': '<h1>Old</h1>' }, [
			'<<<EDIT public/index.html>>>\n<<<FIND>>>\n<h1>Old</h1>\n<<<REPLACE>>>\n<h1>New</h1>\n<<<END EDIT>>>\n<<<REPLY>>>\nThe headline reads New.\n<<<END REPLY>>>',
		]);
		const r = await runRequest(s.deps, { request: 'Headline: New' });
		expect(s.files['public/index.html']).toBe('<h1>New</h1>');
		expect(s.deploys).toBe(1);
		expect(r).toMatchObject({ reply: 'The headline reads New.', changed: true, previewUrl: 'https://preview/1' });
		expect(types(s.events)).toEqual(expect.arrayContaining(['phase_generated', 'phase_implementing', 'file_generated', 'phase_implemented']));
	});

	it('a missed edit is retried once with the file as it is now', async () => {
		const s = fakeSite({ 'public/index.html': '<h1>Old</h1>' }, [
			'<<<EDIT public/index.html>>>\n<<<FIND>>>\n<h1>Olde</h1>\n<<<REPLACE>>>\n<h1>New</h1>\n<<<END EDIT>>>',
			'<<<EDIT public/index.html>>>\n<<<FIND>>>\n<h1>Old</h1>\n<<<REPLACE>>>\n<h1>New</h1>\n<<<END EDIT>>>\n<<<REPLY>>>\nDone: New.\n<<<END REPLY>>>',
		]);
		const r = await runRequest(s.deps, { request: 'Headline: New' });
		expect(s.files['public/index.html']).toBe('<h1>New</h1>');
		expect(s.prompts[1]).toContain('<h1>Olde</h1>');
		expect(s.prompts[1]).toContain('<h1>Old</h1>');
		expect(r.failed).toEqual([]);
	});

	it('still missing after the retry: nothing half-applied, and it says so', async () => {
		const miss = '<<<EDIT public/index.html>>>\n<<<FIND>>>\n<h1>Olde</h1>\n<<<REPLACE>>>\n<h1>New</h1>\n<<<END EDIT>>>';
		const s = fakeSite({ 'public/index.html': '<h1>Old</h1>' }, [miss, miss]);
		const r = await runRequest(s.deps, { request: 'Headline: New' });
		expect(s.files['public/index.html']).toBe('<h1>Old</h1>');
		expect(s.deploys).toBe(0);
		expect(r.failed).toHaveLength(1);
		expect(r.changed).toBe(false);
	});
});

const PLAN = `<<<PLAN>>>
${JSON.stringify({
	reply: "I'm building a website with Home, Services and About.",
	title: 'Kristi Grace Hair',
	phases: [
		{ name: 'Your look and home page', files: ['public/styles.css', 'public/index.html'] },
		{ name: 'Services with prices', files: ['public/services.html'], after: [0] },
		{ name: 'About Kristi', files: ['public/about.html'], after: [0] },
	],
})}
<<<END PLAN>>>`;

const page = (path: string, body: string) => `<<<FILE ${path}>>>\n${body}\n<<<END FILE>>>\n<<<REPLY>>>\n${path} is in.\n<<<END REPLY>>>`;

describe('a new site: plan, then phases, pages side by side, one deploy at a time', () => {
	it('announces every phase first, writes each phase, deploys after each, checks the browser once', async () => {
		const s = fakeSite({}, [
			PLAN,
			`<<<FILE public/styles.css>>>\nbody{}\n<<<END FILE>>>\n${page('public/index.html', '<nav>Home Services About</nav>')}`,
			(p) => page(p.includes('Services with prices') && p.includes('THIS PHASE: Services') ? 'public/services.html' : 'public/about.html', '<nav>Home Services About</nav><h1>x</h1>'),
			(p) => page(p.includes('THIS PHASE: Services') ? 'public/services.html' : 'public/about.html', '<nav>Home Services About</nav><h1>y</h1>'),
		]);
		const r = await runRequest(s.deps, { request: 'A 3-page site for Kristi' });
		expect(Object.keys(s.files).sort()).toEqual(['public/about.html', 'public/index.html', 'public/services.html', 'public/styles.css']);
		expect(r.title).toBe('Kristi Grace Hair');
		expect(r.phases).toEqual(['Your look and home page', 'Services with prices', 'About Kristi']);
		expect(r.changed).toBe(true);
		// Every phase is shown up front (the timeline), before the first is written.
		const generated = s.events.filter((e) => e.type === 'phase_generated');
		expect(generated).toHaveLength(3);
		expect(s.events.findIndex((e) => e.type === 'phase_implementing')).toBeGreaterThan(s.events.lastIndexOf(generated[2]));
		// Later phases see the shared look and the home page's header.
		expect(s.prompts[2]).toContain('body{}');
		expect(s.prompts[2]).toContain('<nav>Home Services About</nav>');
		// One deploy at a time; at least one per phase's worth of writes, at most one per phase.
		expect(s.mostDeploying).toBe(1);
		expect(s.deploys).toBeGreaterThanOrEqual(2);
		expect(s.deploys).toBeLessThanOrEqual(3);
		// Nova says what she'll do first.
		const firstSay = s.events.find((e) => e.type === 'conversation_response');
		expect(firstSay?.data.message).toBe("I'm building a website with Home, Services and About.");
	});

	it('a heartbeat line every few seconds while a phase is written (never a silent minute)', async () => {
		const s = fakeSite({ 'public/index.html': '<h1>Old</h1>' }, ['<<<EDIT public/index.html>>>\n<<<FIND>>>\n<h1>Old</h1>\n<<<REPLACE>>>\n<h1>New</h1>\n<<<END EDIT>>>'], { slowMs: 70 });
		await runRequest(s.deps, { request: 'Headline: New', heartbeatMs: 20 });
		expect(s.events.filter((e) => e.type === 'nova_progress').length).toBeGreaterThanOrEqual(2);
	});

	it('a browser problem at the end gets one fix pass', async () => {
		const s = fakeSite(
			{ 'public/index.html': '<h1>Old</h1><script>oops(</script>' },
			[
				'<<<EDIT public/index.html>>>\n<<<FIND>>>\n<h1>Old</h1>\n<<<REPLACE>>>\n<h1>New</h1>\n<<<END EDIT>>>',
				'<<<EDIT public/index.html>>>\n<<<FIND>>>\n<script>oops(</script>\n<<<REPLACE>>>\n\n<<<END EDIT>>>',
			],
			{ browserErrors: [['SyntaxError: Unexpected end of input (index.html)']] },
		);
		await runRequest(s.deps, { request: 'Headline: New', browserCheck: true });
		expect(s.prompts[1]).toContain('SyntaxError');
		expect(s.files['public/index.html']).toBe('<h1>New</h1>');
	});

	it('resumes after a restart: phases already done are not written again', async () => {
		const s = fakeSite({ 'public/styles.css': 'body{}', 'public/index.html': '<nav/>' }, [
			(p) => page(p.includes('THIS PHASE: Services') ? 'public/services.html' : 'public/about.html', '<h1>x</h1>'),
			(p) => page(p.includes('THIS PHASE: Services') ? 'public/services.html' : 'public/about.html', '<h1>y</h1>'),
		]);
		const plan = JSON.parse(/<<<PLAN>>>\n([\s\S]*)\n<<<END PLAN>>>/.exec(PLAN)![1]);
		const r = await runRequest(s.deps, { request: 'A 3-page site', resume: { plan: { ...plan, phases: plan.phases.map((p: { after?: number[] }) => ({ after: [], ...p })) }, done: [0] } });
		expect(s.prompts).toHaveLength(2);
		expect(r.failed).toEqual([]);
	});
});

describe('the style brief, trimmed per call', () => {
	const styled = 'Build Kristi a site.\nSTYLE TOKENS: bg #FBF6F4\nREFERENCE IMPLEMENTATION: the Blush style for another business.\n```html\n<!doctype html><p>REFERENCE-PAGE</p>\n```\nNEVER: purple.';
	it('only the first phase (the look and the home page) gets the reference page; the plan and later pages get the rules', async () => {
		const s = fakeSite({}, [
			PLAN,
			`<<<FILE public/styles.css>>>\nbody{}\n<<<END FILE>>>\n${page('public/index.html', '<nav/>')}`,
			(p) => page(p.includes('THIS PHASE: Services') ? 'public/services.html' : 'public/about.html', '<h1>x</h1>'),
			(p) => page(p.includes('THIS PHASE: Services') ? 'public/services.html' : 'public/about.html', '<h1>y</h1>'),
		]);
		await runRequest(s.deps, { request: styled });
		expect(s.prompts[0]).not.toContain('REFERENCE-PAGE');
		expect(s.prompts[0]).toContain('STYLE TOKENS: bg #FBF6F4');
		expect(s.prompts[0]).toContain('NEVER: purple.');
		expect(s.prompts[1]).toContain('REFERENCE-PAGE');
		expect(s.prompts[2]).not.toContain('REFERENCE-PAGE');
		expect(s.prompts[3]).not.toContain('REFERENCE-PAGE');
	});
});

describe('the look first, then every page side by side', () => {
	it('pages get the shared header and footer from the look phase (no wait for the home page)', async () => {
		const plan = `<<<PLAN>>>\n${JSON.stringify({
			reply: 'Building.',
			phases: [
				{ name: 'Your look', files: ['public/styles.css'] },
				{ name: 'Home page', files: ['public/index.html'], after: [0] },
				{ name: 'Services', files: ['public/services.html'], after: [0] },
			],
		})}\n<<<END PLAN>>>`;
		const s = fakeSite({}, [
			plan,
			'<<<FILE public/styles.css>>>\n.nav{}\n<<<END FILE>>>\n<<<LAYOUT>>>\n<header class="nav">MENU</header>\n<<<END LAYOUT>>>',
			(p) => page(p.includes('THIS PHASE: Home') ? 'public/index.html' : 'public/services.html', '<header class="nav">MENU</header>'),
			(p) => page(p.includes('THIS PHASE: Home') ? 'public/index.html' : 'public/services.html', '<header class="nav">MENU</header>'),
		]);
		const r = await runRequest(s.deps, { request: 'A site', concurrency: 4 });
		expect(r.failed).toEqual([]);
		expect(s.prompts[2]).toContain('<header class="nav">MENU</header>');
		expect(s.prompts[3]).toContain('<header class="nav">MENU</header>');
		expect(s.files['public/layout.html']).toBeUndefined();
	});
});

describe('a phase that writes nothing is never "done"', () => {
	it('retries once when a planned page is missing from the answer, then fails the phase', async () => {
		const plan = `<<<PLAN>>>\n${JSON.stringify({ reply: 'x', phases: [{ name: 'Services', files: ['public/services.html'] }] })}\n<<<END PLAN>>>`;
		const s = fakeSite({}, [plan, '<<<REPLY>>>\nI will write the services page.\n<<<END REPLY>>>', page('public/services.html', '<h1>S</h1>')]);
		const r = await runRequest(s.deps, { request: 'services page' });
		expect(s.prompts[2]).toContain('public/services.html');
		expect(s.files['public/services.html']).toContain('<h1>S</h1>');
		expect(r.failed).toEqual([]);

		const t = fakeSite({}, [plan, '<<<REPLY>>>\nnothing\n<<<END REPLY>>>', '<<<REPLY>>>\nstill nothing\n<<<END REPLY>>>']);
		const r2 = await runRequest(t.deps, { request: 'services page' });
		expect(r2.failed.map((f) => f.phase)).toEqual(['Services']);
		expect(t.events.filter((e) => e.type === 'phase_implemented')).toEqual([]);
	});
});

describe('a new site: the design contract in the plan, so the look and every page are written side by side', () => {
	const contract = `<<<PLAN>>>\n${JSON.stringify({
		reply: 'Building.',
		phases: [
			{ name: 'Your look', files: ['public/styles.css'] },
			{ name: 'Home page', files: ['public/index.html'] },
			{ name: 'Services', files: ['public/services.html'] },
		],
		design: { classes: '.btn primary button; .card a boxed item', header: '<header class="nav">MENU</header>', footer: '<footer>F</footer>' },
	})}\n<<<END PLAN>>>`;

	it('every phase starts at once, each sees the class list and the shared header and footer', async () => {
		const started: number[] = [];
		const s = fakeSite({}, [
			contract,
			(p) => (p.includes('THIS PHASE: Your look') ? '<<<FILE public/styles.css>>>\n.nav{} .btn{} .card{}\n<<<END FILE>>>' : page(p.includes('THIS PHASE: Home') ? 'public/index.html' : 'public/services.html', '<header class="nav">MENU</header><a class="btn">x</a>')),
			(p) => (p.includes('THIS PHASE: Your look') ? '<<<FILE public/styles.css>>>\n.nav{} .btn{} .card{}\n<<<END FILE>>>' : page(p.includes('THIS PHASE: Home') ? 'public/index.html' : 'public/services.html', '<header class="nav">MENU</header><a class="btn">x</a>')),
			(p) => (p.includes('THIS PHASE: Your look') ? '<<<FILE public/styles.css>>>\n.nav{} .btn{} .card{}\n<<<END FILE>>>' : page(p.includes('THIS PHASE: Home') ? 'public/index.html' : 'public/services.html', '<header class="nav">MENU</header><a class="btn">x</a>')),
		], { slowMs: 20 });
		s.deps.emit = ((orig) => (type: string, data: Record<string, unknown>) => {
			if (type === 'phase_implementing') started.push(Date.now());
			orig(type, data);
		})(s.deps.emit);
		const r = await runRequest(s.deps, { request: 'A site' });
		expect(r.failed).toEqual([]);
		expect(Math.max(...started) - Math.min(...started)).toBeLessThan(15);
		for (const p of s.prompts.slice(1)) {
			expect(p).toContain('.btn primary button');
			expect(p).toContain('<header class="nav">MENU</header>');
		}
	});

	it('no deploy before there is a styled page to show (no unstyled flash, no empty preview)', async () => {
		let deployedWith: string[][] = [];
		const s = fakeSite({}, [
			contract,
			(p) => (p.includes('THIS PHASE: Your look') ? '<<<FILE public/styles.css>>>\n.nav{} .btn{} .card{}\n<<<END FILE>>>' : page(p.includes('THIS PHASE: Home') ? 'public/index.html' : 'public/services.html', '<a class="btn">x</a>')),
			(p) => (p.includes('THIS PHASE: Your look') ? '<<<FILE public/styles.css>>>\n.nav{} .btn{} .card{}\n<<<END FILE>>>' : page(p.includes('THIS PHASE: Home') ? 'public/index.html' : 'public/services.html', '<a class="btn">x</a>')),
			(p) => (p.includes('THIS PHASE: Your look') ? '<<<FILE public/styles.css>>>\n.nav{} .btn{} .card{}\n<<<END FILE>>>' : page(p.includes('THIS PHASE: Home') ? 'public/index.html' : 'public/services.html', '<a class="btn">x</a>')),
		]);
		const deploy = s.deps.deploy;
		s.deps.deploy = async () => {
			deployedWith = [...deployedWith, Object.keys(s.files).sort()];
			return deploy();
		};
		await runRequest(s.deps, { request: 'A site' });
		for (const files of deployedWith) {
			expect(files).toContain('public/styles.css');
			expect(files.some((f) => f.endsWith('.html'))).toBe(true);
		}
		expect(deployedWith.length).toBeGreaterThanOrEqual(1);
	});

	it('classes the pages use that the stylesheet never styles get one short pass that adds them', async () => {
		const s = fakeSite({ 'public/styles.css': '.nav{}', 'public/index.html': '<header class="nav"></header>' }, [
			'<<<EDIT public/index.html>>>\n<<<FIND>>>\n<header class="nav"></header>\n<<<REPLACE>>>\n<header class="nav"></header><ul class="price-list"></ul>\n<<<END EDIT>>>',
			'<<<APPEND public/styles.css>>>\n.price-list{display:grid}\n<<<END APPEND>>>',
		]);
		await runRequest(s.deps, { request: 'Add a price list' });
		expect(s.prompts[1]).toContain('price-list');
		expect(s.files['public/styles.css']).toContain('.price-list{display:grid}');
	});
});

describe('her words never call the preview live', () => {
	it('the rules every call reads say the preview is not live', async () => {
		const { FIRST_SYSTEM, PHASE_SYSTEM } = await import('./prompts');
		for (const p of [FIRST_SYSTEM, PHASE_SYSTEM]) expect(p).toMatch(/never say .*live/i);
	});
});

describe('a workspace call that never answers never hangs the request', () => {
	it('an edit aimed at a page that does not exist yet is never read: it is asked for whole', async () => {
		const s = fakeSite({ 'public/index.html': '<nav>Home</nav>' }, [
			'<<<EDIT public/gallery.html>>>\n<<<FIND>>>\n<h1>x</h1>\n<<<REPLACE>>>\n<h1>y</h1>\n<<<END EDIT>>>',
			'<<<FILE public/gallery.html>>>\n<h1>Gallery</h1>\n<<<END FILE>>>',
		]);
		const read = s.deps.readFile;
		// The workspace's read of a file that isn't there never answers (as seen live).
		s.deps.readFile = (path) => (path in s.files ? read(path) : new Promise(() => undefined));
		const r = await runRequest(s.deps, { request: 'Add a gallery page' });
		expect(r.failed).toEqual([]);
		expect(s.files['public/gallery.html']).toContain('Gallery');
	});

	it('a stuck write or deploy ends the phase as not finished, and the request still ends', async () => {
		const s = fakeSite({ 'public/index.html': '<h1>Old</h1>' }, ['<<<EDIT public/index.html>>>\n<<<FIND>>>\n<h1>Old</h1>\n<<<REPLACE>>>\n<h1>New</h1>\n<<<END EDIT>>>']);
		s.deps.writeFile = () => new Promise(() => undefined);
		const r = await runRequest(s.deps, { request: 'Headline', callTimeoutMs: 30 });
		expect(r.failed.map((f) => f.phase)).toEqual(['Your change']);
	});
});

describe('a brand-new site has no look until its stylesheet is written', () => {
	it('pages finished before the look are not deployed; the look phase deploys them together', async () => {
		const contract = `<<<PLAN>>>\n${JSON.stringify({
			reply: 'x',
			phases: [{ name: 'Your look', files: ['public/styles.css'] }, { name: 'Home page', files: ['public/index.html'] }],
			design: { classes: '.btn', header: '<header/>', footer: '<footer/>' },
		})}\n<<<END PLAN>>>`;
		const deployedWith: string[][] = [];
		const s = fakeSite({}, [
			contract,
			// The page answers first (no delay), the look later.
			(p) => (p.includes('THIS PHASE: Your look') ? 'SLOW' : page('public/index.html', '<a class="btn">x</a>')),
			(p) => (p.includes('THIS PHASE: Your look') ? 'SLOW' : page('public/index.html', '<a class="btn">x</a>')),
		]);
		const model = s.deps.model;
		s.deps.model = async (m, o) => {
			const out = await model(m, o);
			if (out === 'SLOW') {
				await new Promise((r) => setTimeout(r, 30));
				return '<<<FILE public/styles.css>>>\n.btn{}\n<<<END FILE>>>';
			}
			return out;
		};
		const deploy = s.deps.deploy;
		s.deps.deploy = async () => {
			deployedWith.push(Object.keys(s.files).sort());
			return deploy();
		};
		await runRequest(s.deps, { request: 'A site' });
		expect(deployedWith[0]).toEqual(['public/index.html', 'public/styles.css']);
	});
});
