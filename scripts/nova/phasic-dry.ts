/**
 * The phased builder end to end against the real model gateway, on a site in a local folder (no
 * deploy, no browser): how long each call takes and what it writes. For tuning prompts and speed.
 *
 *   bun scripts/nova/phasic-dry.ts <siteDir> "<request>" [--model=cli:claude-sonnet]
 *
 * Needs NOVA_GATEWAY_URL and NOVA_GATEWAY_KEY in the environment. Prints one JSON line per event
 * and a summary; the site's files are read from and written to <siteDir>/public.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { phaseModel } from '../../worker/agents/nova-phasic/gateway';
import { runRequest } from '../../worker/agents/nova-phasic/runner';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const model = process.argv.find((a) => a.startsWith('--model='))?.slice(8);
const [dir, request] = args;
if (!dir || !request) {
	console.error('usage: phasic-dry.ts <siteDir> "<request>" [--model=…]');
	process.exit(2);
}
const call = phaseModel({ ...process.env, ...(model ? { NOVA_PHASE_MODEL: model } : {}) });
if (!call) {
	console.error('NOVA_GATEWAY_URL / NOVA_GATEWAY_KEY not set');
	process.exit(2);
}
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1);
const walk = (d: string): string[] => {
	try {
		return readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
	} catch {
		return [];
	}
};
const calls: { label?: string; seconds: number; inChars: number; outChars: number }[] = [];
const result = await runRequest(
	{
		async model(messages, opts) {
			const s = Date.now();
			const out = await call(messages, opts);
			calls.push({ label: opts?.label, seconds: (Date.now() - s) / 1000, inChars: messages.reduce((n, m) => n + m.content.length, 0), outChars: out.length });
			console.log(JSON.stringify({ t: at(), call: opts?.label, seconds: (Date.now() - s) / 1000, outChars: out.length }));
			return out;
		},
		async listFiles() {
			return walk(join(dir, 'public')).map((p) => relative(dir, p));
		},
		async readFile(path) {
			return readFileSync(join(dir, path), 'utf8');
		},
		async writeFile(path, content) {
			mkdirSync(dirname(join(dir, path)), { recursive: true });
			writeFileSync(join(dir, path), content);
		},
		async deploy() {
			return 'file://' + join(dir, 'public/index.html');
		},
		async browserCheck() {
			return [];
		},
		emit(type, data) {
			if (type === 'nova_progress') return;
			const phase = (data.phase as { name?: string } | undefined)?.name;
			console.log(JSON.stringify({ t: at(), type, ...(phase ? { phase } : {}), ...(typeof data.message === 'string' && type === 'conversation_response' ? { message: data.message } : {}) }));
		},
	},
	{ request },
);
console.log(JSON.stringify({ seconds: Number(at()), ...result, calls }, null, 1));
