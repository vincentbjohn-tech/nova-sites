/**
 * One owner request through the phased builder (vibesdk's phasic pipeline on Nova's SpaceDO sites):
 *
 *   1. the first answer: a plan, the change itself (small edits), or words only (a question);
 *   2. a plan's phases are all announced at once (`phase_generated`, the timeline), then written,
 *      each in ONE model call, side by side when they only wait for the shared look;
 *   3. each phase's files are written all together or not at all, then deployed (one deploy at a
 *      time; a deploy asked for while one runs is shared by everything that asked meanwhile);
 *   4. one browser check at the end, and one fix pass if it finds problems.
 *
 * Everything outside (the model, the files, the deploy, the socket) comes in through `RunnerDeps`, so
 * the whole flow is tested with fakes. While a model call runs, a `nova_progress` line goes out every
 * few seconds: the owner never watches a silent minute.
 */
import { applyEdits, parsePhaseOutput, unstyledClasses, type PhaseOutput } from './format';
import { parseFirstAnswer, runPhases, type Plan } from './plan';
import { FIRST_SYSTEM, FIX_SYSTEM, PHASE_SYSTEM, STYLE_FIX_SYSTEM, filesBlock } from './prompts';

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface RunnerDeps {
	/** One plain completion (no tools). */
	model(messages: ChatMessage[], opts?: { label?: string }): Promise<string>;
	listFiles(): Promise<string[]>;
	readFile(path: string): Promise<string>;
	writeFile(path: string, content: string): Promise<void>;
	/** Save and deploy what's written; the preview address, or null when the deploy failed. */
	deploy(): Promise<string | null>;
	/** Errors a real browser shows on the preview's pages (empty: clean). */
	browserCheck(): Promise<string[]>;
	emit(type: string, data: Record<string, unknown>): void;
	/** Persist progress so a restart carries on (the plan, then each phase as it finishes). */
	onPlan?(plan: Plan): void;
	onPhaseDone?(index: number): void;
	/** Structured log lines (why a phase failed, what was retried). */
	log?(message: string, data: Record<string, unknown>): void;
}

export interface RequestInput {
	request: string;
	/** The owner's earlier requests on this site, oldest first (context only). */
	history?: string[];
	browserCheck?: boolean;
	heartbeatMs?: number;
	concurrency?: number;
	/** Carry on a plan a restart interrupted. */
	resume?: { plan: Plan; done: number[] };
	/** The most a workspace call (list, read, write, deploy, browser check) may take; never a model call. */
	callTimeoutMs?: number;
}

export interface RequestResult {
	reply: string;
	changed: boolean;
	title?: string;
	phases: string[];
	failed: { phase: string; error: string }[];
	previewUrl?: string;
}

const TEXT_FILE = /\.(?:html?|css|js|mjs|svg|txt|xml|json|webmanifest)$/i;
const DIRECT_PHASE = 'Your change';
const FIX_PHASE = 'Fixing a small problem';

function order(paths: string[]): string[] {
	const rank = (p: string) => (p === 'public/index.html' ? 0 : p === 'public/styles.css' ? 1 : /\.html?$/.test(p) ? 2 : 3);
	return [...paths].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

class Problem extends Error {}

/** A retry's blocks over the first answer's: a path the retry writes or edits is entirely the retry's;
 *  every other path keeps what the first answer had. */
export function mergeAnswers(first: PhaseOutput, retry: PhaseOutput): PhaseOutput {
	const redone = new Set([...retry.files.map((f) => f.path), ...retry.edits.map((e) => e.path)]);
	const kept = (path: string) => !redone.has(path);
	return {
		files: [...first.files.filter((f) => kept(f.path)), ...retry.files],
		edits: [...first.edits.filter((e) => kept(e.path) && !first.files.some((f) => f.path === e.path && !kept(f.path))), ...retry.edits],
		reply: retry.reply ?? first.reply,
		layout: retry.layout ?? first.layout,
		dropped: [...first.dropped, ...retry.dropped],
		unterminated: [...first.unterminated.filter(kept), ...retry.unterminated],
	};
}

/** A styled brief's reference page (a whole example site in the chosen style): only the call that
 *  sets the look needs it; the plan and pages built on the home page get the style's rules alone. */
const REFERENCE = /(REFERENCE IMPLEMENTATION[^\n]*\n)```html\n[\s\S]*?\n```\n?/;
export function withoutReference(request: string): string {
	return request.replace(REFERENCE, '$1(not shown here: the look is already set in the shared stylesheet and the home page)\n');
}

/** A workspace call that never answers ends as an error (seen 10 Oct: a request waited 8 minutes). */
function limited<T>(call: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => reject(new Problem(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms);
		call.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			(e) => {
				clearTimeout(t);
				reject(e);
			},
		);
	});
}

export async function runRequest(rawDeps: RunnerDeps, input: RequestInput): Promise<RequestResult> {
	const ms = input.callTimeoutMs ?? 60_000;
	const deps: RunnerDeps = {
		...rawDeps,
		listFiles: () => limited(rawDeps.listFiles(), ms, 'listing the files'),
		readFile: (path) => limited(rawDeps.readFile(path), ms, `reading ${path}`),
		writeFile: (path, content) => limited(rawDeps.writeFile(path, content), ms, `saving ${path}`),
		deploy: () => limited(rawDeps.deploy(), ms * 3, 'refreshing the preview'),
		browserCheck: () => limited(rawDeps.browserCheck(), ms, 'the browser check'),
	};
	const active = new Set<string>();
	let deploying = false;
	const t0 = Date.now();
	const beat = setInterval(() => {
		const line = active.size ? `Working on ${[...active].join(', ')}` : deploying ? 'Refreshing the preview' : 'Working on your site';
		deps.emit('nova_progress', { line, seconds: Math.round((Date.now() - t0) / 1000) });
	}, input.heartbeatMs ?? 5_000);

	// One deploy at a time; asking while one runs shares the next one.
	let running: Promise<string | null> | null = null;
	let queued: Promise<string | null> | null = null;
	let previewUrl: string | undefined;
	const deploy = (): Promise<string | null> => {
		if (queued) return queued;
		const start = () => {
			deploying = true;
			running = deps
				.deploy()
				.then((url) => {
					if (url) previewUrl = url;
					return url;
				})
				.finally(() => {
					running = null;
					deploying = false;
				});
			return running;
		};
		if (!running) return start();
		queued = running
			.catch(() => null)
			.then(() => {
				queued = null;
				return start();
			});
		return queued;
	};

	const readSite = async (): Promise<{ path: string; content: string }[]> => {
		const paths = order((await deps.listFiles()).map((p) => p.replace(/^\/+/, '')).filter((p) => p.startsWith('public/') && TEXT_FILE.test(p)));
		return Promise.all(paths.map(async (path) => ({ path, content: await deps.readFile(path).catch(() => '') })));
	};

	const history = input.history?.length ? `\n\nTHE OWNER'S EARLIER REQUESTS ON THIS SITE (oldest first, context only):\n${input.history.map((h) => `- ${h}`).join('\n')}` : '';

	/**
	 * Turn an answer into the files it writes; one retry with the problems and the files as they
	 * are now. Throws (writing nothing) when the retry still has problems.
	 */
	const resolve = async (
		out: PhaseOutput,
		retry: (problems: string, current: string) => Promise<PhaseOutput>,
		expected: string[] = [],
	): Promise<{ writes: Map<string, string>; reply?: string; layout?: string }> => {
		for (let attempt = 0; ; attempt++) {
			const writes = new Map<string, string>();
			for (const f of out.files) writes.set(f.path, f.content);
			const problems: string[] = out.unterminated.map((p) => `The block for ${p} was cut off: write it again, whole.`);
			// A planned file the answer never wrote: the phase isn't done (seen 10 Oct: a page phase that
			// answered with one sentence and no file).
			const touched = new Set([...out.files.map((f) => f.path), ...out.edits.map((e) => e.path)]);
			for (const path of expected) if (!touched.has(path)) problems.push(`${path} is missing: write it now with a FILE block (or EDIT blocks if it exists).`);
			const byPath = new Map<string, { find: string; replace: string }[]>();
			for (const e of out.edits) byPath.set(e.path, [...(byPath.get(e.path) ?? []), e]);
			const current: { path: string; content: string }[] = [];
			const existing = byPath.size ? new Set((await deps.listFiles()).map((p) => p.replace(/^\/+/, ''))) : new Set<string>();
			for (const [path, edits] of byPath) {
				// Only a file that is there is read (reading one that isn't never answered, 10 Oct).
				const before = writes.get(path) ?? (existing.has(path) ? await deps.readFile(path).catch(() => null) : null);
				if (before === null) {
					problems.push(`${path} doesn't exist: write it whole with a FILE block.`);
					continue;
				}
				const r = applyEdits(before, edits);
				if (r.missed.length) {
					problems.push(...r.missed.map((m) => `In ${path} this FIND is not in the file exactly once:\n${m.find}`));
					current.push({ path, content: before });
				}
				writes.set(path, r.content);
			}
			// Never in a page: a builder marker (a slip that showed as ">>" in a nav, 10 Oct) or placeholder
			// text an owner's visitors would read ("[[PLACEHOLDER: phone]]").
			for (const [path, content] of writes) {
				if (/<<<|>>>/.test(content)) problems.push(`A builder marker (<<< or >>>) is inside ${path}: write that file again without it.`);
				if (/\.html?$/.test(path) && /\[\[[^\]]*\]\]/.test(content))
					problems.push(`${path} shows placeholder text like [[…]]: leave the missing fact out instead (never show placeholder text).`);
			}
			if (!problems.length) return { writes, reply: out.reply, layout: out.layout };
			deps.log?.(attempt >= 1 ? 'nova_phase_failed' : 'nova_phase_retry', { problems: problems.join('\n').slice(0, 2000) });
			if (attempt >= 1) throw new Problem(problems.join('\n'));
			// The retry answers only what was wrong or missing: it adds to the first answer (seen 10 Oct: a
			// look phase's stylesheet was dropped because its retry only brought the missing home page).
			out = mergeAnswers(out, await retry(problems.join('\n\n'), filesBlock(current)));
		}
	};

	/** vibesdk's phase shape, plus where it sits in the plan (the timeline and its estimate read these). */
	const phaseInfo = (name: string, files: string[], index: number, count: number, after: number[] = []) => ({
		name,
		description: name,
		files: files.map((path) => ({ path, purpose: name, changes: null })),
		index,
		count,
		after,
	});

	/** What the site has so far (a deploy before there is a styled page shows nothing worth seeing). */
	const has = { page: false, css: false, known: false };
	const learn = async () => {
		if (has.known) return;
		const paths = (await deps.listFiles()).map((p) => p.replace(/^\/+/, ''));
		has.page = paths.some((p) => /^public\/.+\.html?$/.test(p));
		// Only a stylesheet that is there counts: a brand-new site has no look yet (10 Oct: its pages went
		// to the preview unstyled because an empty site was taken for one that needs none).
		has.css = paths.includes('public/styles.css');
		has.known = true;
	};
	let skipped = false;

	/** Write a phase's files all together, deploy (once there is a styled page to show), say so on the socket. */
	const commitPhase = async (name: string, writes: Map<string, string>, index: number, count: number) => {
		await learn();
		for (const [path, content] of writes) {
			await deps.writeFile(path, content);
			deps.emit('file_generated', { message: `Updated ${path}`, file: { filePath: path, filePurpose: name }, phaseIndex: index });
			if (/^public\/.+\.html?$/.test(path)) has.page = true;
			if (path === 'public/styles.css') has.css = true;
		}
		// A new site's pages and look are written side by side: no preview of a page without its look,
		// and none of a look without a page. A deploy held back goes out with the next one (or at the end).
		if (has.page && (has.css || !needsCss)) {
			skipped = false;
			await deploy();
		} else if (writes.size) skipped = true;
		deps.emit('phase_implemented', { message: name, phase: phaseInfo(name, [...writes.keys()], index, count) });
	};

	let needsCss = false;
	/** Classes already unstyled before this request: the style pass is only for ones it adds. */
	let unstyledBefore = new Set<string>();
	const noteUnstyled = (site: { path: string; content: string }[]) => {
		const css = site.find((f) => f.path === 'public/styles.css');
		if (css) unstyledBefore = new Set(unstyledClasses(site.filter((f) => /\.html?$/.test(f.path)), css.content));
	};
	const failed: RequestResult['failed'] = [];
	const replies: string[] = [];
	let changed = false;
	let plan: Plan | undefined = input.resume?.plan;
	let title: string | undefined;

	try {
		if (!plan) {
			const site = await readSite();
			noteUnstyled(site);
			active.add('your request');
			const firstPrompt = `THE OWNER'S REQUEST:\n${withoutReference(input.request)}${history}\n\nTHE SITE'S FILES NOW:\n${filesBlock(site)}`;
			const answer = await deps.model([{ role: 'system', content: FIRST_SYSTEM }, { role: 'user', content: firstPrompt }], { label: 'first' });
			active.delete('your request');
			const first = parseFirstAnswer(answer);
			if (first.kind === 'answer') return { reply: first.reply, changed: false, phases: [], failed: [] };
			if (first.kind === 'direct') {
				const files = [...new Set([...first.output.files.map((f) => f.path), ...first.output.edits.map((e) => e.path)])];
				deps.emit('phase_generated', { message: DIRECT_PHASE, phase: phaseInfo(DIRECT_PHASE, files, 0, 1) });
				deps.emit('phase_implementing', { message: DIRECT_PHASE, phase: phaseInfo(DIRECT_PHASE, files, 0, 1) });
				try {
					active.add(DIRECT_PHASE.toLowerCase());
					const done = await resolve(first.output, async (problems, current) =>
						parsePhaseOutput(
							await deps.model(
								[
									{ role: 'system', content: FIRST_SYSTEM },
									{ role: 'user', content: firstPrompt },
									{ role: 'assistant', content: answer },
									{ role: 'user', content: `Some of that couldn't be applied:\n${problems}\n\nTHE FILES AS THEY ARE NOW:\n${current}\n\nAnswer again with the corrected blocks only (and the REPLY).` },
								],
								{ label: 'retry' },
							),
						),
					);
					active.delete(DIRECT_PHASE.toLowerCase());
					await commitPhase(DIRECT_PHASE, done.writes, 0, 1);
					changed = done.writes.size > 0;
					if (done.reply) replies.push(done.reply);
				} catch (e) {
					failed.push({ phase: DIRECT_PHASE, error: e instanceof Error ? e.message : String(e) });
				}
			} else {
				plan = first.plan;
			}
		}

		if (plan) {
			const p = plan;
			title = p.title;
			deps.onPlan?.(p);
			if (p.reply && !input.resume) deps.emit('conversation_response', { message: p.reply, isStreaming: false });
			p.phases.forEach((ph, i) => deps.emit('phase_generated', { message: ph.name, phase: phaseInfo(ph.name, ph.files, i, p.phases.length, ph.after) }));
			const planText = JSON.stringify({ title: p.title, phases: p.phases }, null, 1);
			needsCss = p.phases.some((ph) => ph.files.includes('public/styles.css'));
			const shared = ['public/styles.css', 'public/index.html'];
			const result = await runPhases(
				p,
				async (i) => {
					const ph = p.phases[i];
					deps.emit('phase_implementing', { message: ph.name, phase: phaseInfo(ph.name, ph.files, i, p.phases.length) });
					for (const f of ph.files) deps.emit('file_generating', { message: `Writing ${f}`, filePath: f, filePurpose: ph.name, phaseIndex: i });
					active.add(ph.name);
					try {
						const site = await readSite();
						// Every page reads the real stylesheet AND the home page it was written with (Vincent, 10 Oct).
						const seen = site.filter((f) => shared.includes(f.path) || ph.files.includes(f.path));
						const others = site.filter((f) => !seen.includes(f)).map((f) => f.path);
						const prompt = `THE OWNER'S REQUEST:\n${ph.after.length ? withoutReference(input.request) : input.request}${history}\n\nTHE PLAN:\n${planText}\n\nTHIS PHASE: ${ph.name} (phase ${i + 1} of ${p.phases.length}; files: ${ph.files.join(', ') || 'as needed'})\n\n${p.classes ? `THE CLASSES (the only ones pages use; the stylesheet styles every one):\n${p.classes}\n\n` : ''}${p.layout ? `THE SHARED HEADER AND FOOTER (every page uses exactly this markup; mark the current page in the menu):\n${p.layout}\n\n` : ''}THE FILES IT BUILDS ON:\n${filesBlock(seen)}${others.length ? `\n\nOTHER FILES (not shown): ${others.join(', ')}` : ''}`;
						const msgs: ChatMessage[] = [{ role: 'system', content: PHASE_SYSTEM }, { role: 'user', content: prompt }];
						const label = ph.files.includes('public/styles.css') ? 'look' : `phase ${i + 1}`;
						const answer = await deps.model(msgs, { label });
						const done = await resolve(
							parsePhaseOutput(answer),
							async (problems, current) =>
								parsePhaseOutput(
									await deps.model(
										[...msgs, { role: 'assistant', content: answer }, { role: 'user', content: `Some of that couldn't be applied:\n${problems}\n\nTHE FILES AS THEY ARE NOW:\n${current || '(as above)'}\n\nAnswer again with the corrected or missing blocks only (and the REPLY). Write the blocks in your answer; you have no tools.` }],
										{ label: `${label} retry` },
									),
								),
							ph.files,
						);
						active.delete(ph.name);
						if (done.layout && !p.layout) {
							p.layout = done.layout;
							deps.onPlan?.(p);
						}
						await commitPhase(ph.name, done.writes, i, p.phases.length);
						if (done.writes.size) changed = true;
						if (done.reply) replies.push(done.reply);
						deps.onPhaseDone?.(i);
					} finally {
						active.delete(ph.name);
					}
				},
				input.concurrency ?? 4,
				new Set(input.resume?.done ?? []),
			);
			for (const f of result.failed) failed.push({ phase: p.phases[f.index].name, error: f.error });
			for (const s of result.skipped) failed.push({ phase: p.phases[s].name, error: 'skipped: a phase it waits for failed' });
		}

		// Pages and the look written side by side: every class a page uses gets a rule (one short pass).
		if (changed) {
			const site = await readSite().catch(() => [] as { path: string; content: string }[]);
			const css = site.find((f) => f.path === 'public/styles.css');
			const missing = css ? unstyledClasses(site.filter((f) => /\.html?$/.test(f.path)), css.content).filter((c) => !unstyledBefore.has(c)) : [];
			if (missing.length) {
				const STYLE_PHASE = 'Finishing the look';
				deps.emit('phase_generated', { message: STYLE_PHASE, phase: phaseInfo(STYLE_PHASE, ['public/styles.css'], 98, 1) });
				deps.emit('phase_implementing', { message: STYLE_PHASE, phase: phaseInfo(STYLE_PHASE, ['public/styles.css'], 98, 1) });
				active.add(STYLE_PHASE.toLowerCase());
				try {
					const answer = await deps.model(
						[
							{ role: 'system', content: STYLE_FIX_SYSTEM },
							{ role: 'user', content: `THE CLASSES WITH NO RULES:\n${missing.slice(0, 60).map((c) => `.${c}`).join('\n')}\n\nWHERE THEY ARE USED:\n${filesBlock(site.filter((f) => /\.html?$/.test(f.path)), 40_000)}\n\nTHE STYLESHEET:\n${filesBlock([css!], 40_000)}` },
						],
						{ label: 'style pass' },
					);
					const done = await resolve(parsePhaseOutput(answer), async () => {
						throw new Problem('the style pass could not be applied');
					});
					await commitPhase(STYLE_PHASE, done.writes, 98, 1);
				} catch (e) {
					failed.push({ phase: FIX_PHASE, error: e instanceof Error ? e.message : String(e) });
				} finally {
					active.delete(STYLE_PHASE.toLowerCase());
				}
			}
			if (skipped) await deploy();
		}

		if (changed && input.browserCheck) {
			const errors = await deps.browserCheck().catch(() => []);
			if (errors.length) {
				deps.emit('phase_generated', { message: FIX_PHASE, phase: phaseInfo(FIX_PHASE, [], 99, 1) });
				deps.emit('phase_implementing', { message: FIX_PHASE, phase: phaseInfo(FIX_PHASE, [], 99, 1) });
				active.add(FIX_PHASE.toLowerCase());
				try {
					const site = await readSite();
					const answer = await deps.model(
						[
							{ role: 'system', content: FIX_SYSTEM },
							{ role: 'user', content: `THE BROWSER SHOWS:\n${errors.slice(0, 20).join('\n')}\n\nTHE SITE'S FILES:\n${filesBlock(site)}` },
						],
						{ label: 'fix' },
					);
					const done = await resolve(parsePhaseOutput(answer), async () => {
						throw new Problem('the fix could not be applied');
					});
					await commitPhase(FIX_PHASE, done.writes, 99, 1);
				} catch (e) {
					// The pages work as they are; a fix that can't be applied is logged, never half-applied.
					failed.push({ phase: FIX_PHASE, error: e instanceof Error ? e.message : String(e) });
				} finally {
					active.delete(FIX_PHASE.toLowerCase());
				}
			}
		}
	} finally {
		clearInterval(beat);
	}

	const reply = replies.length ? replies.slice(-3).join(' ') : changed ? 'Done — take a look on the right.' : '';
	return {
		reply,
		changed,
		...(title ? { title } : {}),
		phases: plan ? plan.phases.map((ph) => ph.name) : changed ? [DIRECT_PHASE] : [],
		failed: failed.filter((f) => f.phase !== FIX_PHASE),
		...(previewUrl ? { previewUrl } : {}),
	};
}
