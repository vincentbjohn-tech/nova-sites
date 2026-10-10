/**
 * The first answer of a builder request (vibesdk's blueprint + phase generation, in one call):
 *
 *   - a PLAN: phases named in the owner's words, each with the files it writes and the phases it waits
 *     for (pages that only need the shared look are written side by side);
 *   - or the change itself, done (a small edit needs no plan and no second call);
 *   - or just words (a question, or nothing to change).
 *
 * Pure, so it is tested. A broken plan never stops a request: it becomes one phase with the whole of it.
 */
import { isWritablePath, parsePhaseOutput, type PhaseOutput } from './format';

export interface Phase {
	/** In the owner's words ("Services with prices"): the timeline's line and Nova's narration. */
	name: string;
	/** Files this phase writes (`public/…`); empty = whatever the request needs. */
	files: string[];
	/** Indexes of the phases it waits for (always earlier ones). */
	after: number[];
}

export interface Plan {
	/** What Nova will do, in one or two plain sentences. */
	reply: string;
	title?: string;
	phases: Phase[];
	/** The shared header and footer, once the look phase has written them (kept for a restart). */
	layout?: string;
}

export type FirstAnswer = { kind: 'plan'; plan: Plan } | { kind: 'direct'; output: PhaseOutput } | { kind: 'answer'; reply: string };

export const MAX_PHASES = 8;
const NAME_MAX = 80;

const FALLBACK: Phase = { name: 'Your change', files: [], after: [] };

function cleanPlan(raw: unknown): Plan {
	const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const list = Array.isArray(o.phases) ? o.phases.slice(0, MAX_PHASES) : [];
	const phases: Phase[] = list
		.filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string')
		.map((p, i) => {
			const name = String(p.name).trim();
			return {
				name: name.length > NAME_MAX ? name.slice(0, NAME_MAX - 1).replace(/\s+\S*$/, '') + '…' : name,
				files: (Array.isArray(p.files) ? p.files : [])
					.filter((f): f is string => typeof f === 'string')
					.map((f) => f.trim().replace(/^\/+/, ''))
					.filter(isWritablePath),
				after: [...new Set((Array.isArray(p.after) ? p.after : []).filter((n): n is number => Number.isInteger(n) && n >= 0 && n < i))],
			};
		});
	return {
		reply: typeof o.reply === 'string' ? o.reply.trim() : '',
		...(typeof o.title === 'string' && o.title.trim() ? { title: o.title.trim().slice(0, 60) } : {}),
		phases: phases.length ? phases : [FALLBACK],
	};
}

export function parseFirstAnswer(text: string): FirstAnswer {
	const planBlock = /<<<PLAN>>>\s*([\s\S]*?)\s*<<<END PLAN>>>/.exec(text);
	if (planBlock) {
		const json = planBlock[1].replace(/^```(?:json)?\s*|\s*```$/g, '');
		try {
			return { kind: 'plan', plan: cleanPlan(JSON.parse(json)) };
		} catch {
			return { kind: 'plan', plan: { reply: '', phases: [FALLBACK] } };
		}
	}
	const out = parsePhaseOutput(text);
	if (out.files.length || out.edits.length || out.unterminated.length) return { kind: 'direct', output: out };
	return { kind: 'answer', reply: out.reply ?? text.trim() };
}

export interface RunResult {
	failed: { index: number; error: string }[];
	/** Phases never run because one they wait for failed. */
	skipped: number[];
}

/**
 * Run every phase once what it waits for is done, at most `limit` at a time. A phase that fails
 * stops only the phases waiting for it. Phases in `done` (finished before a restart) are skipped.
 */
export async function runPhases(plan: Plan, run: (index: number) => Promise<void>, limit = 3, done: Set<number> = new Set()): Promise<RunResult> {
	const n = plan.phases.length;
	const finished = new Set<number>(done);
	const failed: RunResult['failed'] = [];
	const blocked = new Set<number>();
	const started = new Set<number>(done);
	let running = 0;

	return new Promise((resolve) => {
		const settle = () => {
			// A phase waiting for a failed or blocked phase never runs.
			let changed = true;
			while (changed) {
				changed = false;
				for (let i = 0; i < n; i++) {
					if (started.has(i) || blocked.has(i)) continue;
					if (plan.phases[i].after.some((a) => blocked.has(a) || failed.some((f) => f.index === a))) {
						blocked.add(i);
						changed = true;
					}
				}
			}
			for (let i = 0; i < n && running < limit; i++) {
				if (started.has(i) || blocked.has(i)) continue;
				if (!plan.phases[i].after.every((a) => finished.has(a))) continue;
				started.add(i);
				running += 1;
				run(i)
					.then(() => void finished.add(i))
					.catch((e) => void failed.push({ index: i, error: e instanceof Error ? e.message : String(e) }))
					.finally(() => {
						running -= 1;
						settle();
					});
			}
			if (running === 0) resolve({ failed, skipped: [...blocked].sort((a, b) => a - b) });
		};
		settle();
	});
}
