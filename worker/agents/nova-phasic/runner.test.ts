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

// A full page (an opening photo, 6 sections) around the test's own markup: new-site pages must be full (11 Oct).
const FULL = (body: string) => `<section><img src="h.jpg" alt=""></section>${body}${'<section>s</section>'.repeat(5)}`;
const page = (path: string, body: string) => `<<<FILE ${path}>>>\n${FULL(body)}\n<<<END FILE>>>\n<<<REPLY>>>\n${path} is in.\n<<<END REPLY>>>`;

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
		// The editor gets the name and what was assumed as data, before the first phase (12 Oct spec).
		const plan = s.events.find((e) => e.type === 'nova_plan');
		expect(plan?.data).toEqual({ title: 'Kristi Grace Hair', assumed: [] });
		expect(s.events.indexOf(plan!)).toBeLessThan(s.events.indexOf(generated[0]));
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

	it('a browser problem at the end gets one fix pass (new pages; a small direct edit skips the check)', async () => {
		const plan = `<<<PLAN>>>\n${JSON.stringify({ reply: 'x', phases: [{ name: 'About', files: ['public/about.html'] }] })}\n<<<END PLAN>>>`;
		const s = fakeSite(
			{ 'public/index.html': '<h1>Home</h1>' },
			[plan, page('public/about.html', '<h1>About</h1><script>oops(</script>'), '<<<EDIT public/about.html>>>\n<<<FIND>>>\n<script>oops(</script>\n<<<REPLACE>>>\n\n<<<END EDIT>>>'],
			{ browserErrors: [['SyntaxError: Unexpected end of input (about.html)']] },
		);
		await runRequest(s.deps, { request: 'About page', browserCheck: true });
		expect(s.prompts[2]).toContain('SyntaxError');
		expect(s.files['public/about.html']).not.toContain('oops(');
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
		// Named in her own words (never "Your change", 11 Oct).
		expect(r.failed.map((f) => f.phase)).toEqual(['Headline']);
	});
});

describe('facts are never invented', () => {
	it('every call reads one rule: no made-up phone, address, review, rating or licence', async () => {
		const { FIRST_SYSTEM, PHASE_SYSTEM } = await import('./prompts');
		for (const p of [FIRST_SYSTEM, PHASE_SYSTEM]) {
			expect(p).toMatch(/never invent/i);
			expect(p).toMatch(/phone/i);
			expect(p).toMatch(/555/);
		}
	});
});

describe('a retry adds to the first answer, it does not replace it', () => {
	it('the look phase answered with the stylesheet only; the retry with the home page: both are written', async () => {
		const plan = `<<<PLAN>>>\n${JSON.stringify({ reply: 'x', phases: [{ name: 'Look and home', files: ['public/styles.css', 'public/index.html'] }] })}\n<<<END PLAN>>>`;
		const s = fakeSite({}, [
			plan,
			'<<<FILE public/styles.css>>>\n.btn{}\n<<<END FILE>>>',
			`<<<FILE public/index.html>>>\n${FULL('<a class="btn">Book</a>')}\n<<<END FILE>>>`,
		]);
		const r = await runRequest(s.deps, { request: 'A site' });
		expect(r.failed).toEqual([]);
		expect(Object.keys(s.files).sort()).toEqual(['public/index.html', 'public/styles.css']);
	});

	it('a retry that fixes one missed edit keeps the edits that applied the first time', async () => {
		const s = fakeSite({ 'public/index.html': '<h1>A</h1><p>B</p>' }, [
			'<<<EDIT public/index.html>>>\n<<<FIND>>>\n<h1>A</h1>\n<<<REPLACE>>>\n<h1>A2</h1>\n<<<END EDIT>>>\n<<<EDIT public/about.html>>>\n<<<FIND>>>\nx\n<<<REPLACE>>>\ny\n<<<END EDIT>>>',
			'<<<FILE public/about.html>>>\n<h1>About</h1>\n<<<END FILE>>>',
		]);
		const r = await runRequest(s.deps, { request: 'Change A and add about' });
		expect(r.failed).toEqual([]);
		expect(s.files['public/index.html']).toBe('<h1>A2</h1><p>B</p>');
		expect(s.files['public/about.html']).toContain('About');
	});
});

describe('the style pass looks only at what this request added', () => {
	it('an edit on a site that already had unstyled classes runs no style pass', async () => {
		const s = fakeSite({ 'public/styles.css': '.a{}', 'public/index.html': '<p class="old-unstyled">x</p><h1>Old</h1>' }, [
			'<<<EDIT public/index.html>>>\n<<<FIND>>>\n<h1>Old</h1>\n<<<REPLACE>>>\n<h1>New</h1>\n<<<END EDIT>>>',
		]);
		await runRequest(s.deps, { request: 'Headline' });
		expect(s.prompts).toHaveLength(1);
	});
});

describe('a failed phase says why in the log', () => {
	it('the problems that failed it are logged', async () => {
		const logs: string[] = [];
		const miss = '<<<EDIT public/index.html>>>\n<<<FIND>>>\n<h1>Olde</h1>\n<<<REPLACE>>>\n<h1>New</h1>\n<<<END EDIT>>>';
		const s = fakeSite({ 'public/index.html': '<h1>Old</h1>' }, [miss, miss]);
		s.deps.log = (msg, data) => logs.push(`${msg} ${JSON.stringify(data)}`);
		await runRequest(s.deps, { request: 'Headline' });
		expect(logs.join('\n')).toContain('nova_phase_failed');
		expect(logs.join('\n')).toContain('Olde');
	});
});

describe('what is never written into a page (Vincent, 10 Oct)', () => {
	it('a page with a builder marker in it is rejected and asked for again', async () => {
		const s = fakeSite({ 'public/index.html': '<h1>Old</h1>' }, [
			'<<<FILE public/about.html>>>\n<header>x</header>\n<<<REPLACE>>><nav>y</nav>\n<<<END FILE>>>',
			'<<<FILE public/about.html>>>\n<header>x</header><nav>y</nav>\n<<<END FILE>>>',
		]);
		await runRequest(s.deps, { request: 'About page' });
		expect(s.prompts[1]).toMatch(/marker/i);
		expect(s.files['public/about.html']).not.toContain('<<<');
	});
	it('a page that shows [[PLACEHOLDER…]] text is asked for again without it', async () => {
		const s = fakeSite({ 'public/index.html': '<h1>Old</h1>' }, [
			'<<<FILE public/contact.html>>>\n<a href="tel:[[PLACEHOLDER: phone]]">[[PLACEHOLDER: phone]]</a>\n<<<END FILE>>>',
			'<<<FILE public/contact.html>>>\n<a href="https://book.kristigrace.com">Book online</a>\n<<<END FILE>>>',
		]);
		await runRequest(s.deps, { request: 'Contact page' });
		expect(s.prompts[1]).toContain('[[');
		expect(s.files['public/contact.html']).not.toContain('[[');
	});
	it('every call reads: no placeholder text on a page, no text hidden until a script runs, readable on every band', async () => {
		const { FIRST_SYSTEM, PHASE_SYSTEM } = await import('./prompts');
		for (const p of [FIRST_SYSTEM, PHASE_SYSTEM]) {
			expect(p).toMatch(/never show placeholder text/i);
			expect(p).toMatch(/hidden until a script/i);
			expect(p).toMatch(/readable/i);
		}
	});
});

describe('the look and the home page get the most care', () => {
	it('the phase that writes the stylesheet is labelled so the gateway can run it at high effort', async () => {
		const labels: (string | undefined)[] = [];
		const plan = `<<<PLAN>>>\n${JSON.stringify({ reply: 'x', phases: [{ name: 'Your look and home page', files: ['public/styles.css', 'public/index.html'] }, { name: 'About', files: ['public/about.html'], after: [0] }] })}\n<<<END PLAN>>>`;
		const s = fakeSite({}, [plan, `<<<FILE public/styles.css>>>\nb{}\n<<<END FILE>>>\n${page('public/index.html', '<h1>H</h1>')}`, page('public/about.html', '<h1>A</h1>')]);
		const model = s.deps.model;
		s.deps.model = (m, o) => {
			labels.push(o?.label);
			return model(m, o);
		};
		await runRequest(s.deps, { request: 'A site' });
		// A new site's plan is 'first-new': the gateway plans it with the strongest model (12 Oct).
		expect(labels).toEqual(['first-new', 'look', 'phase 2']);
	});
});

describe("the plan's outline and kind reach every page (12 Oct: a funnel brief came out as a thin salon page)", () => {
	it('every phase reads the kind and the whole outline, with the media addresses it names', async () => {
		const prompts: string[] = [];
		const outline = 'index: 1. VSL hero: label FREE TRAINING, h1 Become the voice, video poster https://m/stage.webp; 2. Proof strip\nthank-you: 1. YOU\'RE BOOKED';
		const plan = `<<<PLAN>>>\n${JSON.stringify({ reply: 'x', kind: 'funnel', outline, phases: [{ name: 'Your look and home page', files: ['public/styles.css', 'public/index.html'] }, { name: 'Thank-you page', files: ['public/thank-you.html'], after: [0] }] })}\n<<<END PLAN>>>`;
		const s = fakeSite({}, [plan, `<<<FILE public/styles.css>>>\nb{}\n<<<END FILE>>>\n${page('public/index.html', '<h1>H</h1>')}`, page('public/thank-you.html', '<h1>T</h1>')]);
		const model = s.deps.model;
		s.deps.model = (m, o) => {
			if (o?.label !== 'first-new') prompts.push(m.map((x) => x.content).join('\n'));
			return model(m, o);
		};
		await runRequest(s.deps, { request: 'Build my funnel' });
		expect(prompts).toHaveLength(2);
		for (const p of prompts) {
			expect(p).toContain('"kind": "funnel"');
			expect(p).toContain(`THE OUTLINE (every page's sections, in order):\n${outline}`);
			expect(p).toMatch(/THE OUTLINE in THE PLAN is the contract/);
		}
	});
});

describe('new-site pages are asked for again when thin', () => {
	it('a page with too few sections or no opening photo is retried with what is missing; an edit to an existing page is not held to it', async () => {
		const full = `<section class="hero"><img src="h.jpg" alt=""></section>${'<section>s</section>'.repeat(3)}`;
		const plan = `<<<PLAN>>>\n${JSON.stringify({ reply: 'x', phases: [{ name: 'Your look and home page', files: ['public/styles.css', 'public/index.html'] }, { name: 'Contact', files: ['public/contact.html'], after: [0] }] })}\n<<<END PLAN>>>`;
		const s = fakeSite({}, [
			plan,
			`<<<FILE public/styles.css>>>\nb{}\n<<<END FILE>>>\n<<<FILE public/index.html>>>\n<section class="hero"><img src="h.jpg" alt=""></section>${'<section>s</section>'.repeat(5)}\n<<<END FILE>>>`,
			'<<<FILE public/contact.html>>>\n<section>thin</section>\n<<<END FILE>>>',
			`<<<FILE public/contact.html>>>\n${full}\n<<<END FILE>>>`,
		]);
		const r = await runRequest(s.deps, { request: 'A site' });
		expect(r.failed).toEqual([]);
		expect(s.prompts[3]).toContain('at least 4');
		expect(s.prompts[3]).toContain('opens without a photo');
		expect(s.files['public/contact.html']).toContain('h.jpg');

		const e = fakeSite({ 'public/styles.css': 'b{}', 'public/about.html': '<section>old</section>' }, ['<<<EDIT public/about.html>>>\n<<<FIND>>>\nold\n<<<REPLACE>>>\nnew\n<<<END EDIT>>>']);
		await runRequest(e.deps, { request: 'change a word' });
		expect(e.prompts).toHaveLength(1);
	});

	it("a plan with an outline sets the page's length: a short book-a-call page is kept, never refused for its section count (12 Oct)", async () => {
		const short = `<section class="hero"><img src="poster.jpg" alt=""></section>${'<section>s</section>'.repeat(3)}`;
		const plan = `<<<PLAN>>>\n${JSON.stringify({ reply: 'x', kind: 'funnel', outline: 'index: 1. VSL 2. Reasons 3. Daniel 4. Closing band', phases: [{ name: 'Your look and the call page', files: ['public/styles.css', 'public/index.html'] }] })}\n<<<END PLAN>>>`;
		const s = fakeSite({}, [plan, `<<<FILE public/styles.css>>>\nb{}\n<<<END FILE>>>\n<<<FILE public/index.html>>>\n${short}\n<<<END FILE>>>`]);
		const r = await runRequest(s.deps, { request: 'A short book-a-call page' });
		expect(r.failed).toEqual([]);
		expect(s.prompts.some((p) => /sections; a full page/.test(p))).toBe(false); // never sent back for its length
		expect(s.files['public/index.html']).toContain('poster.jpg');
	});

	it('page phases read the style reference page too; the plan does not', async () => {
		const styled = 'Build it.\nREFERENCE IMPLEMENTATION: the Blush style.\n```html\n<!doctype html><p>REFERENCE-PAGE</p>\n```\nNEVER: purple.';
		const full = `<section class="hero"><img src="h.jpg" alt=""></section>${'<section>s</section>'.repeat(5)}`;
		const plan = `<<<PLAN>>>\n${JSON.stringify({ reply: 'x', phases: [{ name: 'Your look and home page', files: ['public/styles.css', 'public/index.html'] }, { name: 'About', files: ['public/about.html'], after: [0] }] })}\n<<<END PLAN>>>`;
		const s = fakeSite({}, [plan, `<<<FILE public/styles.css>>>\nb{}\n<<<END FILE>>>\n<<<FILE public/index.html>>>\n${full}\n<<<END FILE>>>`, `<<<FILE public/about.html>>>\n${full}\n<<<END FILE>>>`]);
		await runRequest(s.deps, { request: styled });
		expect(s.prompts[0]).not.toContain('REFERENCE-PAGE');
		expect(s.prompts[1]).toContain('REFERENCE-PAGE');
		expect(s.prompts[2]).toContain('REFERENCE-PAGE');
	});

	it('the rules ask for the photo strip, the inline booking panel, a full contact page, and one phone booking button at a time', async () => {
		const { PHASE_SYSTEM } = await import('./prompts');
		expect(PHASE_SYSTEM).toMatch(/photo strip/i);
		expect(PHASE_SYSTEM).toMatch(/booking panel/i);
		expect(PHASE_SYSTEM).toMatch(/contact page/i);
		expect(PHASE_SYSTEM).toMatch(/never two .*book/i);
	});
});

describe('her closing words never call the preview live', () => {
	it('"is live" / "now live" about a change becomes "is in your preview"; other uses of the word stay', async () => {
		const { previewWords } = await import('./runner');
		expect(previewWords('The About page is live with her story. The Contact page is now live, and the menu is live too.')).toBe(
			'The About page is in your preview with her story. The Contact page is now in your preview, and the menu is in your preview too.',
		);
		expect(previewWords('The services are live in preview now.')).toBe('The services are in your preview now.');
		expect(previewWords('Clients who live nearby can book online.')).toBe('Clients who live nearby can book online.');
	});
	it('the request reply goes through it', async () => {
		const s = fakeSite({ 'public/index.html': '<h1>Old</h1>' }, ['<<<EDIT public/index.html>>>\n<<<FIND>>>\n<h1>Old</h1>\n<<<REPLACE>>>\n<h1>New</h1>\n<<<END EDIT>>>\n<<<REPLY>>>\nThe new headline is live.\n<<<END REPLY>>>']);
		const r = await runRequest(s.deps, { request: 'Headline' });
		expect(r.reply).toBe('The new headline is in your preview.');
	});
});

describe('speed: a new page and a small edit', () => {
	it('a new page on an existing site: the model writes the page, the builder adds it to every menu', async () => {
		const nav = '<nav><a href="index.html">Home</a><a href="about.html">About</a></nav>';
		const plan = `<<<PLAN>>>\n${JSON.stringify({ reply: 'x', phases: [{ name: 'Gallery page', files: ['public/gallery.html'] }] })}\n<<<END PLAN>>>`;
		const s = fakeSite({ 'public/styles.css': 'nav{}', 'public/index.html': `${nav}<h1>Home</h1>`, 'public/about.html': `${nav}<h1>About</h1>` }, [plan, page('public/gallery.html', nav)]);
		await runRequest(s.deps, { request: 'Add a Gallery page', browserCheck: true });
		expect(s.files['public/index.html']).toContain('<a href="gallery.html">Gallery</a>');
		expect(s.files['public/about.html']).toContain('<a href="gallery.html">Gallery</a>');
		expect(s.files['public/gallery.html']).toContain('<a href="gallery.html">Gallery</a>');
		expect(s.prompts[1]).toMatch(/adds it to every page's menu/i);
	});
	it('a small direct edit skips the end-of-request browser check', async () => {
		let checked = 0;
		const s = fakeSite({ 'public/index.html': '<h1>Old</h1>' }, ['<<<EDIT public/index.html>>>\n<<<FIND>>>\n<h1>Old</h1>\n<<<REPLACE>>>\n<h1>New</h1>\n<<<END EDIT>>>']);
		s.deps.browserCheck = async () => {
			checked += 1;
			return [];
		};
		await runRequest(s.deps, { request: 'Headline', browserCheck: true });
		expect(checked).toBe(0);
	});
	it('the closing band carries hours, a short price list and the button', async () => {
		const { PHASE_SYSTEM } = await import('./prompts');
		expect(PHASE_SYSTEM).toMatch(/closing call-to-action band with the hours, a short price list and the booking button/i);
	});
});

describe('the placeholder and marker checks only judge what this request adds (Vincent, 11 Oct)', () => {
	it('an edit to a page that already shows [[…]] text goes through (an older site), as long as it adds none', async () => {
		const s = fakeSite({ 'public/index.html': '<p>[[PLACEHOLDER: phone]]</p><a class="btn" style="background:#f5c518">Book</a>' }, [
			'<<<EDIT public/index.html>>>\n<<<FIND>>>\nbackground:#f5c518\n<<<REPLACE>>>\nbackground:#10b981;box-shadow:0 0 18px #10b98199\n<<<END EDIT>>>\n<<<REPLY>>>\nThe buttons are emerald with a soft glow now.\n<<<END REPLY>>>',
		]);
		const r = await runRequest(s.deps, { request: 'emerald glowing buttons instead of yellow' });
		expect(r.failed).toEqual([]);
		expect(s.files['public/index.html']).toContain('#10b981');
	});
	it('an edit that adds a new [[…]] is still sent back', async () => {
		const s = fakeSite({ 'public/index.html': '<p>[[PLACEHOLDER: phone]]</p><h1>Hi</h1>' }, [
			'<<<EDIT public/index.html>>>\n<<<FIND>>>\n<h1>Hi</h1>\n<<<REPLACE>>>\n<h1>Hi</h1><p>[[PLACEHOLDER: address]]</p>\n<<<END EDIT>>>',
			'<<<EDIT public/index.html>>>\n<<<FIND>>>\n<h1>Hi</h1>\n<<<REPLACE>>>\n<h1>Hello</h1>\n<<<END EDIT>>>',
		]);
		await runRequest(s.deps, { request: 'headline' });
		expect(s.prompts[1]).toContain('[[');
		expect(s.files['public/index.html']).toBe('<p>[[PLACEHOLDER: phone]]</p><h1>Hello</h1>');
	});
});

describe('a small change is named in the owner\'s words, never "Your change"', () => {
	it('uses the NAME the answer gives; without one, the start of her request', async () => {
		const s = fakeSite({ 'public/index.html': '<a style="background:#f5c518">Book</a>' }, [
			'<<<NAME>>>\nButtons to emerald\n<<<END NAME>>>\n<<<EDIT public/index.html>>>\n<<<FIND>>>\nbackground:#f5c518\n<<<REPLACE>>>\nbackground:#10b981\n<<<END EDIT>>>',
		]);
		await runRequest(s.deps, { request: 'can you make the buttons emerald glowing color instead of yellow' });
		const names = s.events.filter((e) => e.type === 'phase_generated').map((e) => (e.data.phase as { name: string }).name);
		expect(names).toEqual(['Buttons to emerald']);

		const t = fakeSite({ 'public/index.html': '<h1>Old</h1>' }, ['<<<EDIT public/index.html>>>\n<<<FIND>>>\n<h1>Old</h1>\n<<<REPLACE>>>\n<h1>New</h1>\n<<<END EDIT>>>']);
		await runRequest(t.deps, { request: 'can you change the headline to New please, and keep everything else' });
		const n2 = t.events.filter((e) => e.type === 'phase_generated').map((e) => (e.data.phase as { name: string }).name);
		expect(n2[0]).toBe('Change the headline to New please…');
		expect(n2[0]).not.toBe('Your change');
	});
});

describe('never claim a change that was not made (Vincent, 11 Oct)', () => {
	it('a first answer whose blocks are all unusable is retried, then fails honestly — never "words only"', async () => {
		const bad = '<<<EDIT public/index.html>>>\nno replace here\n<<<END EDIT>>>\n<<<REPLY>>>\nThe buttons are emerald now.\n<<<END REPLY>>>';
		const s = fakeSite({ 'public/index.html': '<a class="b">x</a>' }, [bad, bad]);
		const r = await runRequest(s.deps, { request: 'emerald buttons' });
		expect(r.changed).toBe(false);
		expect(r.failed).toHaveLength(1);
		expect(r.reply).not.toContain('emerald now');
	});
	it('rules for a missing styles.css go into the page\'s own <style> (an older site with inline styles)', async () => {
		const s = fakeSite({ 'public/index.html': '<head><style>.btn{background:gold}</style></head><a class="btn">x</a>' }, [
			'<<<APPEND public/styles.css>>>\n.btn{box-shadow:0 0 14px #2ecc8f}\n<<<END APPEND>>>\n<<<REPLY>>>\nThey glow now.\n<<<END REPLY>>>',
		]);
		const r = await runRequest(s.deps, { request: 'make the buttons glow' });
		expect(r.failed).toEqual([]);
		expect(s.files['public/index.html']).toContain('.btn{background:gold}\n.btn{box-shadow:0 0 14px #2ecc8f}\n</style>');
		expect(s.files['public/styles.css']).toBeUndefined();
	});
});

describe("the site's forms post to Nova OS (16 Oct: a lead-magnet form posted to an address that didn't exist)", () => {
	const address = 'https://os.usenovaos.com/api/public/forms/site-1';

	it('the first answer and every phase carry this site\'s own form address', async () => {
		const s = fakeSite({}, [
			PLAN,
			`<<<FILE public/styles.css>>>\nbody{}\n<<<END FILE>>>\n${page('public/index.html', '<nav>Home Services About</nav>')}`,
			(p) => page(p.includes('THIS PHASE: Services') ? 'public/services.html' : 'public/about.html', '<h1>x</h1>'),
			(p) => page(p.includes('THIS PHASE: Services') ? 'public/services.html' : 'public/about.html', '<h1>y</h1>'),
		]);
		await runRequest(s.deps, { request: 'A 3-page site for Kristi', formAddress: address });
		expect(s.prompts.length).toBeGreaterThanOrEqual(4);
		for (const p of s.prompts) {
			expect(p).toContain(`<form method="post" action="${address}">`);
			expect(p).toContain('name="file"');
			expect(p).toContain('name="next"');
			// 17 Oct: the form's name (its list in People), questions by their own words, consent with its words.
			expect(p).toContain('name="form"');
			expect(p).toContain('name="consent_email"');
			expect(p).toContain('name="consent_texts"');
		}
	});

	it('the rules every call reads say a form never posts to a made-up address', async () => {
		const s = fakeSite({ 'public/index.html': '<h1>Hi</h1>' }, ['<<<REPLY>>>\nOk.\n<<<END REPLY>>>']);
		await runRequest(s.deps, { request: 'Hi' });
		expect(s.prompts[0]).toContain("Every form follows THE SITE'S FORMS");
	});
});

describe("a stylesheet is never rewritten blind (16 Oct: a menu change replaced Dr. Martha's whole look)", () => {
	// Her site, in small: big pages, and the look in public/assets/theme.css (not public/styles.css).
	const LOOK = `:root{--pink:#F42BA2;--ink:#17130F}\n${'.rule{color:var(--ink)}\n'.repeat(1100)}`;
	const PAGES = ['index', 'about', 'book', 'book-a-call', 'community', 'free', 'podcast', 'press', 'the-reset', 'work-with-me'];
	const pageHtml = (name: string) => `<!-- ${name} --><nav><a href="about">About</a><a href="press">Press</a></nav>${'<p>words</p>'.repeat(1700)}`;
	const herSite = () => {
		const files: Record<string, string> = { 'public/assets/theme.css': LOOK };
		for (const n of PAGES) files[`public/${n}.html`] = pageHtml(n);
		return files;
	};
	const pressOut = (paths: string[]) =>
		paths.map((p) => `<<<EDIT ${p}>>>\n<<<FIND>>>\n<a href="press">Press</a>\n<<<REPLACE>>>\n\n<<<END EDIT>>>`).join('\n') +
		'\n<<<REPLY>>>\nPress is out of the top menu.\n<<<END REPLY>>>';
	// What the model wrote on the live site when it was told to write a stylesheet it was never shown.
	const INVENTED = '<<<FILE public/assets/theme.css>>>\n:root{--pink:#C96A7C;--ink:#2b2420}\n<<<END FILE>>>\n<<<REPLY>>>\nDone.\n<<<END REPLY>>>';

	it('a plan that lists the stylesheet beside the pages: the phase is shown the stylesheet whole, and never made to write it when it needs no change', async () => {
		const pages = PAGES.map((n) => `public/${n}.html`);
		const plan = `<<<PLAN>>>\n${JSON.stringify({ reply: 'x', phases: [{ name: 'Press off the top menu', files: [...pages, 'public/assets/theme.css'] }] })}\n<<<END PLAN>>>`;
		const s = fakeSite(herSite(), [plan, pressOut(pages), INVENTED]);
		const r = await runRequest(s.deps, { request: 'Take Press out of the top menu and put it in the footer' });
		expect(s.files['public/assets/theme.css']).toBe(LOOK);
		expect(s.prompts[1]).toContain('--pink:#F42BA2');
		expect(s.files['public/index.html']).not.toContain('href="press"');
		expect(r.failed).toEqual([]);
	});

	it('the first answer is shown the look before the pages, wherever the stylesheet lives', async () => {
		const s = fakeSite(herSite(), ['<<<REPLY>>>\nOk.\n<<<END REPLY>>>']);
		await runRequest(s.deps, { request: 'What colours does my site use?' });
		expect(s.prompts[0]).toContain('--pink:#F42BA2');
		expect(s.prompts[0]).toContain('--- public/work-with-me.html (not shown: too much at once)');
	});

	it('a whole-file answer over an existing file it was not shown is sent back with the file as it is, for EDIT blocks', async () => {
		const s = fakeSite(herSite(), [
			'<<<FILE public/work-with-me.html>>>\n<h1>Work with me</h1>\n<<<END FILE>>>\n<<<REPLY>>>\nDone.\n<<<END REPLY>>>',
			'<<<EDIT public/work-with-me.html>>>\n<<<FIND>>>\n<a href="about">About</a>\n<<<REPLACE>>>\n<a href="about">About Martha</a>\n<<<END EDIT>>>\n<<<REPLY>>>\nThe menu says About Martha.\n<<<END REPLY>>>',
		]);
		const r = await runRequest(s.deps, { request: 'On work with me, call the About link About Martha' });
		// The first answer never saw that page (cut off), so its whole file is refused…
		expect(s.prompts[0]).not.toContain('<!-- work-with-me -->');
		expect(s.prompts[1]).toContain('<!-- work-with-me -->');
		// …and only the edit lands: the rest of the page is kept.
		expect(s.files['public/work-with-me.html']).toBe(pageHtml('work-with-me').replace('<a href="about">About</a>', '<a href="about">About Martha</a>'));
		expect(r.failed).toEqual([]);
	});

	it('a whole file the model WAS shown still goes through (a redesign the owner asked for)', async () => {
		const s = fakeSite(herSite(), [
			'<<<FILE public/assets/theme.css>>>\n:root{--pink:#0A7B5C}\n<<<END FILE>>>\n<<<REPLY>>>\nYour site is green now.\n<<<END REPLY>>>',
		]);
		const r = await runRequest(s.deps, { request: 'Redo my whole look in green' });
		expect(s.files['public/assets/theme.css']).toContain(':root{--pink:#0A7B5C}');
		expect(s.files['public/assets/theme.css']).not.toContain('#F42BA2');
		expect(r.failed).toEqual([]);
	});
});
