import { describe, expect, it } from 'vitest';
import { phaseModel, phasicOn } from './gateway';

const env = { NOVA_GATEWAY_URL: 'https://gw.example/v1/', NOVA_GATEWAY_KEY: 'k' };

describe('the phased builder model: one plain completion through the gateway', () => {
	it('posts the messages to the gateway with the fast CLI model by default, asking for plain text (no JSON around a page)', async () => {
		let seen: { url: string; body: Record<string, unknown>; auth: string } | undefined;
		const model = phaseModel(env, async (url, init) => {
			seen = { url: String(url), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get('Authorization') ?? '' };
			return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }));
		});
		expect(await model!([{ role: 'user', content: 'x' }])).toBe('hi');
		expect(seen).toEqual({ url: 'https://gw.example/v1/chat/completions', body: { model: 'cli:claude-sonnet', messages: [{ role: 'user', content: 'x' }], stream: true, response_format: { type: 'text' }, reasoning_effort: 'medium' }, auth: 'Bearer k' });
	});

	it('NOVA_PHASE_MODEL picks the model; no gateway configured → null', () => {
		expect(phaseModel({})).toBeNull();
		expect(phasicOn({ NOVA_PHASIC: 'on' })).toBe(true);
		expect(phasicOn({ NOVA_PHASIC: 'off' })).toBe(false);
		expect(phasicOn({})).toBe(false);
	});

	it('a refusal or an empty answer is an error, never an empty page', async () => {
		const refused = phaseModel(env, async () => new Response('busy', { status: 503 }));
		await expect(refused!([])).rejects.toThrow('503');
		const empty = phaseModel(env, async () => new Response(JSON.stringify({ choices: [{ message: { content: ' ' } }] })));
		await expect(empty!([])).rejects.toThrow('no words');
	});
});

describe('the browser check → problems worth a fix', () => {
	it('page errors, console errors and failed loads; never a favicon', async () => {
		const { browserProblems } = await import('./gateway');
		expect(
			browserProblems({
				logs: [{ level: 'error', text: 'x is not defined' }, { level: 'log', text: 'hi' }, { level: 'error', text: 'GET /favicon.ico 404' }],
				pageErrors: [{ message: 'SyntaxError: bad' }],
				requestFailures: [{ url: 'https://p/img.jpg', failure: 'net', status: 404 }, { url: 'https://p/favicon.ico', failure: 'net', status: 404 }],
			}),
		).toEqual(['Page error: SyntaxError: bad', 'Console error: x is not defined', 'Failed to load https://p/img.jpg: 404']);
	});
});

describe('effort per call: the plan quick, the pages with more care', () => {
	it('the first answer runs at the plan effort, a phase at the phase effort (both configurable)', async () => {
		const seen: unknown[] = [];
		const fetcher = async (_u: unknown, init?: RequestInit) => {
			seen.push(JSON.parse(String(init?.body)).reasoning_effort);
			return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
		};
		const model = phaseModel(env, fetcher)!;
		await model([], { label: 'first' });
		await model([], { label: 'phase 2' });
		const tuned = phaseModel({ ...env, NOVA_PLAN_EFFORT: 'medium', NOVA_PHASE_EFFORT: 'high' }, fetcher)!;
		await tuned([], { label: 'first' });
		await tuned([], { label: 'phase 1' });
		expect(seen).toEqual(['low', 'medium', 'medium', 'high']);
	});
});

describe('the plan is the strongest model (12 Oct)', () => {
	it("a new site's plan: Opus at high effort; any other first answer: Opus at the plan effort; pages stay on the page model", async () => {
		const seen: [unknown, unknown][] = [];
		const fetcher = async (_u: unknown, init?: RequestInit) => {
			const b = JSON.parse(String(init?.body));
			seen.push([b.model, b.reasoning_effort]);
			return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
		};
		const model = phaseModel(env, fetcher)!;
		await model([], { label: 'first-new' });
		await model([], { label: 'first' });
		await model([], { label: 'look' });
		await model([], { label: 'phase 2' });
		expect(seen).toEqual([['cli:claude-opus', 'high'], ['cli:claude-opus', 'low'], ['cli:claude-sonnet', 'high'], ['cli:claude-sonnet', 'medium']]);
		const tuned = phaseModel({ ...env, NOVA_PLAN_MODEL: 'cli:claude-sonnet', NOVA_NEW_PLAN_EFFORT: 'medium' }, fetcher)!;
		await tuned([], { label: 'first-new' });
		expect(seen.at(-1)).toEqual(['cli:claude-sonnet', 'medium']);
	});
});

describe('the look runs at its own effort', () => {
	it('label "look" → NOVA_LOOK_EFFORT (high by default)', async () => {
		const seen: unknown[] = [];
		const model = phaseModel(env, async (_u, init) => {
			seen.push(JSON.parse(String(init?.body)).reasoning_effort);
			return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
		})!;
		await model([], { label: 'look' });
		await model([], { label: 'look retry' });
		expect(seen).toEqual(['high', 'high']);
	});
});

describe('the switch per account (try it on a test account while everyone else stays on the old agent)', () => {
	it('NOVA_PHASIC=on is everyone; NOVA_PHASIC_USERS lists builder user ids that get it; otherwise off', async () => {
		const { phasicOn } = await import('./gateway');
		expect(phasicOn({ NOVA_PHASIC: 'on' }, 'anyone')).toBe(true);
		expect(phasicOn({ NOVA_PHASIC_USERS: 'u-test, u-2' }, 'u-test')).toBe(true);
		expect(phasicOn({ NOVA_PHASIC_USERS: 'u-test, u-2' }, 'u-vincent')).toBe(false);
		expect(phasicOn({}, 'u-test')).toBe(false);
		expect(phasicOn({ NOVA_PHASIC_USERS: '' }, '')).toBe(false);
	});
});

describe('long answers are streamed (the gateway keeps an idle connection alive with comments)', () => {
	it('asks for a stream and assembles the text from the chunks, ignoring keep-alive comments', async () => {
		let body: Record<string, unknown> = {};
		const sse = [
			': keepalive',
			'',
			`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '<<<FILE public/a.html>>>\n' } }] })}`,
			'',
			': keepalive',
			`data: ${JSON.stringify({ choices: [{ delta: { content: '<h1>x</h1>\n<<<END FILE>>>' } }] })}`,
			'',
			`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
			'data: [DONE]',
			'',
		].join('\n');
		const model = phaseModel(env, async (_u, init) => {
			body = JSON.parse(String(init?.body));
			return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
		})!;
		expect(await model([], { label: 'look' })).toBe('<<<FILE public/a.html>>>\n<h1>x</h1>\n<<<END FILE>>>');
		expect(body.stream).toBe(true);
	});

	it('a stream that ends with an error event is an error, never a half page', async () => {
		const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: 'half' } }] })}\n\ndata: ${JSON.stringify({ error: { message: 'all model routes failed' } })}\n\n`;
		const model = phaseModel(env, async () => new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }))!;
		await expect(model([])).rejects.toThrow('all model routes failed');
	});
});
