/**
 * Stopwatch for the Nova Sites speed budgets: one whole build from a sentence,
 * then a one-word follow-up edit, timed from the moment the request is sent.
 * Every WebSocket message is written to a JSONL log with its elapsed time.
 *
 *   bun scripts/nova/speed-test.ts <baseUrl> <apiKeyFile> <outDir> ["prompt"] ["edit"]
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { VibeClient } from '../../sdk/src/index';

const [baseUrl, keyFile, outDir, promptArg, editArg] = process.argv.slice(2);
if (!baseUrl || !keyFile || !outDir) {
	console.error('usage: speed-test.ts <baseUrl> <apiKeyFile> <outDir> [prompt] [edit]');
	process.exit(2);
}
const prompt = promptArg ?? 'A one-page website for Kristi Grace Hair, an independent hairstylist in Austin. Services with prices: Balayage $220, Color + gloss $140, Women\'s cut $65. A "Book now" button linking to https://book.kristigrace.com. Hours: Tue-Sat 9am-6pm. Warm, modern, luxurious. Build it now, no questions.';
const edit = editArg ?? 'Change the main headline to "Hair that feels like you, only better." Change nothing else.';

mkdirSync(outDir, { recursive: true });
const log = `${outDir}/messages.jsonl`;
writeFileSync(log, '');
const apiKey = JSON.parse(readFileSync(keyFile, 'utf8')).data.key as string;

const client = new VibeClient({ baseUrl, apiKey });
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
const marks: Record<string, string> = {};
const counts: Record<string, number> = {};

function mark(name: string) {
	if (!marks[name]) {
		marks[name] = secs();
		console.log(`[${marks[name]}s] ${name}`);
	}
}

async function run() {
	const session = await client.build(prompt, { behaviorType: 'think', projectType: 'app' });
	mark('build_created');
	console.log(`agentId=${session.agentId}`);
	let phase = 'build';
	session.on('ws:message', (m: { type: string; [k: string]: unknown }) => {
		counts[`${phase}:${m.type}`] = (counts[`${phase}:${m.type}`] ?? 0) + 1;
		appendFileSync(log, JSON.stringify({ t: secs(), phase, type: m.type, keys: Object.keys(m) }) + '\n');
		if (m.type.includes('file')) mark(`${phase}:first_file_event`);
		if (m.type.includes('preview') || m.type.includes('deploy')) mark(`${phase}:first_${m.type}`);
	});
	await session.wait.generationStarted({ timeoutMs: 120_000 });
	mark('build:generation_started');
	await session.wait.generationComplete({ timeoutMs: 1_800_000 });
	mark('build:generation_complete');
	const buildSecs = secs();

	phase = 'edit';
	const e0 = Date.now();
	session.followUp(edit);
	await session.wait.generationStarted({ timeoutMs: 120_000 }).catch(() => undefined);
	await session.wait.generationComplete({ timeoutMs: 900_000 });
	const editSecs = ((Date.now() - e0) / 1000).toFixed(1);
	mark('edit:generation_complete');

	const summary = { agentId: session.agentId, buildSecs, editSecs, marks, counts, files: session.files.listPaths() };
	writeFileSync(`${outDir}/summary.json`, JSON.stringify(summary, null, 2));
	console.log(JSON.stringify({ buildSecs, editSecs, files: summary.files.length }));
	session.close();
}

run().catch((e) => {
	console.error(`FAILED at ${secs()}s:`, e instanceof Error ? e.message : e);
	writeFileSync(`${outDir}/summary.json`, JSON.stringify({ failedAt: secs(), error: String(e), marks, counts }, null, 2));
	process.exit(1);
});
