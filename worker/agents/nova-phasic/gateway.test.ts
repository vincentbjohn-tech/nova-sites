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
		expect(seen).toEqual({ url: 'https://gw.example/v1/chat/completions', body: { model: 'cli:claude-sonnet', messages: [{ role: 'user', content: 'x' }], stream: false, response_format: { type: 'text' } }, auth: 'Bearer k' });
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
