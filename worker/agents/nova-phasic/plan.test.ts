import { describe, expect, it } from 'vitest';
import { parseFirstAnswer, runPhases, type Plan } from './plan';

const plan = (phases: unknown) => `<<<PLAN>>>\n${JSON.stringify({ reply: "I'm building a website: home, services, about.", title: 'Kristi Grace Hair', phases })}\n<<<END PLAN>>>`;

describe('the first answer of a request: a plan, the change itself, or just words', () => {
	it('reads a plan: phases in the owner words, their files, what each waits for', () => {
		const a = parseFirstAnswer(
			plan([
				{ name: 'Your look and home page', files: ['public/styles.css', 'public/index.html'] },
				{ name: 'Services with prices', files: ['public/services.html'], after: [0] },
				{ name: 'About Kristi', files: ['/public/about.html'], after: [0] },
			]),
		);
		expect(a.kind).toBe('plan');
		const p = (a as { plan: Plan }).plan;
		expect(p.reply).toBe("I'm building a website: home, services, about.");
		expect(p.title).toBe('Kristi Grace Hair');
		expect(p.phases.map((x) => x.name)).toEqual(['Your look and home page', 'Services with prices', 'About Kristi']);
		expect(p.phases[2]).toEqual({ name: 'About Kristi', files: ['public/about.html'], after: [0] });
	});

	it('a small change comes back done in the first answer (no second call)', () => {
		const a = parseFirstAnswer('<<<EDIT public/index.html>>>\n<<<FIND>>>\n<h1>A</h1>\n<<<REPLACE>>>\n<h1>B</h1>\n<<<END EDIT>>>\n<<<REPLY>>>\nThe headline reads B now.\n<<<END REPLY>>>');
		expect(a.kind).toBe('direct');
		if (a.kind === 'direct') expect(a.output.edits).toHaveLength(1);
	});

	it('words only (a question, or nothing to change) is an answer', () => {
		expect(parseFirstAnswer('<<<REPLY>>>\nYou have three pages.\n<<<END REPLY>>>')).toEqual({ kind: 'answer', reply: 'You have three pages.' });
		expect(parseFirstAnswer('You have three pages.')).toEqual({ kind: 'answer', reply: 'You have three pages.' });
	});

	it('a broken plan becomes one phase with the whole request (never nothing)', () => {
		const a = parseFirstAnswer('<<<PLAN>>>\n{"phases": [oops\n<<<END PLAN>>>');
		expect(a.kind).toBe('plan');
		if (a.kind === 'plan') expect(a.plan.phases).toEqual([{ name: 'Your change', files: [], after: [] }]);
	});

	it('cleans a plan: no config files, no forward or self waits, at most 8 phases, names kept short', () => {
		const a = parseFirstAnswer(
			plan([
				{ name: 'A', files: ['public/a.html', 'wrangler.json'], after: [0, 3] },
				{ name: 'B'.repeat(200), files: ['public/b.html'], after: [0, 1, 7] },
				...Array.from({ length: 10 }, (_, i) => ({ name: `P${i}`, files: [`public/p${i}.html`] })),
			]),
		);
		if (a.kind !== 'plan') throw new Error('not a plan');
		expect(a.plan.phases).toHaveLength(8);
		expect(a.plan.phases[0]).toEqual({ name: 'A', files: ['public/a.html'], after: [] });
		expect(a.plan.phases[1].after).toEqual([0]);
		expect(a.plan.phases[1].name.length).toBeLessThanOrEqual(80);
	});
});

describe('running the phases: in order of what they wait for, independent ones side by side', () => {
	it('starts a phase as soon as the ones it waits for are done, up to the limit at once', async () => {
		const log: string[] = [];
		const p: Plan = {
			reply: '',
			phases: [
				{ name: 'home', files: [], after: [] },
				{ name: 'services', files: [], after: [0] },
				{ name: 'about', files: [], after: [0] },
				{ name: 'contact', files: [], after: [0] },
				{ name: 'links', files: [], after: [1, 2, 3] },
			],
		};
		let running = 0;
		let most = 0;
		await runPhases(
			p,
			async (i) => {
				running += 1;
				most = Math.max(most, running);
				log.push(`start ${p.phases[i].name}`);
				await new Promise((r) => setTimeout(r, i === 1 ? 30 : 10));
				log.push(`end ${p.phases[i].name}`);
				running -= 1;
			},
			3,
		);
		expect(log[0]).toBe('start home');
		expect(log[1]).toBe('end home');
		expect(log.slice(2, 5).sort()).toEqual(['start about', 'start contact', 'start services']);
		expect(log.at(-1)).toBe('end links');
		expect(log.indexOf('start links')).toBeGreaterThan(log.indexOf('end services'));
		expect(most).toBe(3);
	});

	it('a failed phase stops the ones waiting for it, others still finish, and the error comes back', async () => {
		const done: number[] = [];
		const p: Plan = { reply: '', phases: [{ name: 'a', files: [], after: [] }, { name: 'b', files: [], after: [0] }, { name: 'c', files: [], after: [] }] };
		const r = await runPhases(p, async (i) => {
			if (i === 0) throw new Error('boom');
			done.push(i);
		});
		expect(done).toEqual([2]);
		expect(r.failed).toEqual([{ index: 0, error: 'boom' }]);
		expect(r.skipped).toEqual([1]);
	});

	it('skips phases already done (a restart mid-build carries on)', async () => {
		const ran: number[] = [];
		const p: Plan = { reply: '', phases: [{ name: 'a', files: [], after: [] }, { name: 'b', files: [], after: [0] }] };
		await runPhases(p, async (i) => void ran.push(i), 3, new Set([0]));
		expect(ran).toEqual([1]);
	});
});

describe('a design contract makes every phase independent', () => {
	it('with the class list and the shared header, no phase waits for another (whatever the plan said)', () => {
		const a = parseFirstAnswer(
			`<<<PLAN>>>\n${JSON.stringify({
				reply: 'x',
				phases: [{ name: 'Your look', files: ['public/styles.css'] }, { name: 'Home', files: ['public/index.html'], after: [0] }],
				design: { classes: '.btn the button', header: '<header>H</header>', footer: '<footer>F</footer>' },
			})}\n<<<END PLAN>>>`,
		);
		if (a.kind !== 'plan') throw new Error('not a plan');
		expect(a.plan.phases.map((p) => p.after)).toEqual([[], []]);
		expect(a.plan.classes).toBe('.btn the button');
		expect(a.plan.layout).toBe('<header>H</header>\n<footer>F</footer>');
	});
});

describe('with a contract, the look is its own phase', () => {
	it('a phase that bundles the stylesheet with pages is split: the look, then one phase per page, all side by side', () => {
		const a = parseFirstAnswer(
			`<<<PLAN>>>\n${JSON.stringify({
				reply: 'x',
				phases: [
					{ name: 'Style system and home page', files: ['public/styles.css', 'public/index.html'] },
					{ name: 'Services with prices', files: ['public/services.html'] },
				],
				design: { classes: '.btn', header: '<header/>', footer: '<footer/>' },
			})}\n<<<END PLAN>>>`,
		);
		if (a.kind !== 'plan') throw new Error('not a plan');
		expect(a.plan.phases).toEqual([
			{ name: 'Your look', files: ['public/styles.css'], after: [] },
			{ name: 'Home page', files: ['public/index.html'], after: [] },
			{ name: 'Services with prices', files: ['public/services.html'], after: [] },
		]);
	});
});
