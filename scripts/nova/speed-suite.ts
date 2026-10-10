/**
 * The six speed budgets of the website builder v2 plan (nova-os-app docs/pages/website-builder-v2.md),
 * timed on one site: the request goes in the way Nova OS sends it (HTTP `POST /api/nova/sites/:id/message`)
 * and the clock runs on the site's WebSocket until the turn is finished.
 *
 *   bun scripts/nova/speed-suite.ts <baseUrl> <token> <siteId> <outDir> [rows] [--build-started-at=<ms>]
 *
 * rows: comma-separated subset of text,layout,section,page,question (default: all edit rows).
 * With --build-started-at the site's first build (started by Nova OS at that epoch-ms) is timed first:
 * row "site" (the full styled site) and its first reply.
 *
 * Per row: firstReply (first words from Nova), firstPreview, done (generation_complete or, for a
 * question, the final reply) and the steps (tool calls). Every message goes to <outDir>/<row>.jsonl.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { VibeClient } from '../../sdk/src/index';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(
	process.argv
		.slice(2)
		.filter((a) => a.startsWith('--'))
		.map((a) => a.slice(2).split('=') as [string, string]),
);
const [baseUrl, token, siteId, outDir, rowsArg] = args;
if (!baseUrl || !token || !siteId || !outDir) {
	console.error('usage: speed-suite.ts <baseUrl> <token> <siteId> <outDir> [rows] [--build-started-at=<ms>]');
	process.exit(2);
}

export const EDIT_ROWS: Record<string, string> = {
	text: 'Change the main headline to "Hair that feels like you, only better." Change nothing else.',
	layout: 'Show the services in two columns side by side instead of one list. Change nothing else.',
	section: 'Add a section with three short client testimonials right below the services.',
	// A section that needs no facts the owner hasn't given (testimonials can't be invented).
	section2: 'Add a short section right below the services explaining how a first appointment works, in three steps.',
	page: 'Add a Gallery page with six photos of hair work, and link it from the menu.',
	question: 'What pages does my site have right now? Just tell me, don\'t change anything.',
};
const rows = (rowsArg ?? 'text,layout,section,page,question').split(',').filter((r) => r in EDIT_ROWS);
mkdirSync(outDir, { recursive: true });

type Msg = { type: string; message?: string; isStreaming?: boolean; previewURL?: string; tool?: { name: string; status: string } };

const session = await new VibeClient({ baseUrl, token }).connect(siteId);
await session.connect();

interface RowResult {
	row: string;
	firstReply?: number;
	firstPreview?: number;
	done?: number;
	steps: number;
	reply?: string;
	error?: string;
}

/** Time one turn: `start` sends it (or nothing, for a build already running), `t0` is when it began. */
function timeTurn(row: string, t0: number, start: () => Promise<void>, timeoutMs: number, endOnReply = false): Promise<RowResult> {
	const log = `${outDir}/${row}.jsonl`;
	writeFileSync(log, '');
	const res: RowResult = { row, steps: 0 };
	const at = () => Math.round((Date.now() - t0) / 100) / 10;
	return new Promise((resolve) => {
		let started = false;
		const finish = (extra: Partial<RowResult> = {}) => {
			off();
			clearTimeout(timer);
			resolve({ ...res, ...extra });
		};
		const off = session.on('ws:message', (raw: unknown) => {
			const m = raw as Msg;
			appendFileSync(log, JSON.stringify({ t: at(), type: m.type, tool: m.tool?.name, status: m.tool?.status, streaming: m.isStreaming, chars: m.message?.length ?? 0 }) + '\n');
			if (m.type === 'generation_started') started = true;
			if (m.type === 'conversation_response') {
				if (m.tool?.status === 'start') res.steps += 1;
				if (!m.tool && m.message?.trim() && res.firstReply === undefined) res.firstReply = at();
				if (!m.tool && m.isStreaming === false && m.message?.trim()) {
					res.reply = m.message;
					if (endOnReply) return finish({ done: at() });
				}
			}
			if ((m.type === 'deployment_completed' || m.type === 'preview_ready') && res.firstPreview === undefined) res.firstPreview = at();
			if (m.type === 'generation_complete' && (started || !endOnReply)) finish({ done: at() });
			if (m.type === 'error') finish({ error: m.message ?? 'error', done: at() });
		});
		const timer = setTimeout(() => finish({ error: 'timeout' }), timeoutMs);
		start().catch((e) => finish({ error: String(e) }));
	});
}

async function post(text: string): Promise<void> {
	const r = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/nova/sites/${encodeURIComponent(siteId)}/message`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ text }),
	});
	if (!r.ok) throw new Error(`message refused: ${r.status}`);
}

const results: RowResult[] = [];
if (flags['build-started-at']) {
	const t0 = Number(flags['build-started-at']);
	const r = await timeTurn('site', t0, async () => undefined, 40 * 60_000);
	results.push(r);
	console.log(JSON.stringify(r));
}
for (const row of rows) {
	const r = await timeTurn(row, Date.now(), () => post(EDIT_ROWS[row]), 20 * 60_000, row === 'question');
	// Her last words for every row: the report shows that every message got an answer.
	r.reply = r.reply?.slice(0, 400);
	results.push(r);
	console.log(JSON.stringify(r));
	// Let the agent settle (the commit and label after a turn) before the next request.
	await new Promise((ok) => setTimeout(ok, 5_000));
}
writeFileSync(`${outDir}/summary.json`, JSON.stringify(results, null, 2));
session.close();
process.exit(results.some((r) => r.error) ? 1 : 0);
