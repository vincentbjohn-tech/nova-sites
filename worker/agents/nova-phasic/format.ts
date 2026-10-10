/**
 * The answer format of one builder phase (vibesdk's phase implementation, in a shape a model writes
 * reliably in one plain completion, with no tool calls):
 *
 *   <<<FILE public/index.html>>>        a whole new (or rewritten) file
 *   …
 *   <<<END FILE>>>
 *   <<<EDIT public/services.html>>>     find/replace pairs on an existing file
 *   <<<FIND>>>
 *   …
 *   <<<REPLACE>>>
 *   …
 *   <<<END EDIT>>>
 *   <<<LAYOUT>>>                        the look phase only: the header and footer every page copies
 *   …
 *   <<<END LAYOUT>>>
 *   <<<REPLY>>>                         one or two sentences for the owner
 *   …
 *   <<<END REPLY>>>
 *
 * Pure, so it is tested. A block without its end marker (the answer was cut off) is never written,
 * and only files under `public/` are ever written: a phase can't touch the site's config or code.
 */

export interface FileOut {
	path: string;
	content: string;
}

export interface EditOut {
	path: string;
	find: string;
	replace: string;
}

export interface PhaseOutput {
	files: FileOut[];
	edits: EditOut[];
	reply?: string;
	/** The shared header and footer markup every page copies (the look phase gives it; never a file). */
	layout?: string;
	/** Paths the answer tried to write outside `public/` (dropped). */
	dropped: string[];
	/** Paths whose block never ended (not written). */
	unterminated: string[];
}

/** `public/…` with no way out of it. */
export function isWritablePath(path: string): boolean {
	return /^public\/[^\s]+$/.test(path) && !path.split('/').some((p) => p === '..' || p === '.' || p === '');
}

const normalPath = (raw: string) => raw.trim().replace(/^\/+/, '');

/** A block's body without the one newline before its end marker, and without a markdown fence around it. */
function body(raw: string, keepTrailingNewline: boolean): string {
	let text = raw;
	const fenced = /^```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(text.trim() + '\n');
	if (fenced) text = fenced[1] + '\n';
	if (!keepTrailingNewline) text = text.replace(/\n$/, '');
	return text;
}

const OPEN = /<<<(FILE|EDIT|APPEND) ([^>\n]+)>>>\n?/g;

export function parsePhaseOutput(text: string): PhaseOutput {
	const out: PhaseOutput = { files: [], edits: [], dropped: [], unterminated: [] };
	const reply = /<<<REPLY>>>\n?([\s\S]*?)<<<END REPLY>>>/.exec(text);
	if (reply) out.reply = reply[1].trim() || undefined;
	const layout = /<<<LAYOUT>>>\n?([\s\S]*?)<<<END LAYOUT>>>/.exec(text);
	if (layout) out.layout = layout[1].trim() || undefined;

	OPEN.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = OPEN.exec(text))) {
		const kind = m[1];
		const path = normalPath(m[2]);
		const start = m.index + m[0].length;
		const endMarker = kind === 'FILE' ? '<<<END FILE>>>' : kind === 'APPEND' ? '<<<END APPEND>>>' : '<<<END EDIT>>>';
		const end = text.indexOf(endMarker, start);
		// Another block opening before this one ends: this one was cut off.
		const nextOpen = text.slice(start).search(/<<<(?:FILE|EDIT|APPEND) [^>\n]+>>>/);
		if (end < 0 || (nextOpen >= 0 && start + nextOpen < end)) {
			out.unterminated.push(path);
			continue;
		}
		OPEN.lastIndex = end + endMarker.length;
		if (!isWritablePath(path)) {
			out.dropped.push(path);
			continue;
		}
		const inner = text.slice(start, end);
		if (kind === 'FILE') {
			out.files.push({ path, content: body(inner, true) });
			continue;
		}
		if (kind === 'APPEND') {
			const added = body(inner, false);
			if (added.trim()) out.edits.push({ path, find: '', replace: added });
			continue;
		}
		for (const pair of inner.split('<<<FIND>>>').slice(1)) {
			const at = pair.indexOf('<<<REPLACE>>>');
			if (at < 0) continue;
			const find = body(pair.slice(0, at).replace(/^\n/, ''), false);
			const replace = body(pair.slice(at + '<<<REPLACE>>>'.length).replace(/^\n/, ''), false);
			if (find.trim()) out.edits.push({ path, find, replace });
		}
	}
	return out;
}

/** Where `find` is in `content`, ignoring how whitespace runs are spelled (and leading/trailing space). */
function looseRange(content: string, find: string): [number, number][] {
	const tokens = find.trim().split(/\s+/).filter(Boolean);
	if (!tokens.length) return [];
	const esc = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
	const re = new RegExp(esc.join('\\s*'), 'g');
	const hits: [number, number][] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(content))) {
		hits.push([m.index, m.index + m[0].length]);
		if (m[0].length === 0) re.lastIndex += 1;
	}
	return hits;
}

/**
 * Apply find/replace edits in order. Each must match exactly once: exactly first, then ignoring
 * whitespace; none or more than once → reported in `missed`, the file unchanged by it.
 */
export function applyEdits(content: string, edits: { find: string; replace: string }[]): { content: string; missed: { find: string; replace: string }[] } {
	let text = content;
	const missed: { find: string; replace: string }[] = [];
	for (const e of edits) {
		// An APPEND: added after the file, on its own line.
		if (e.find === '') {
			text = `${text.replace(/\n*$/, '')}\n${e.replace.replace(/\n*$/, '')}\n`;
			continue;
		}
		const first = text.indexOf(e.find);
		if (first >= 0) {
			if (text.indexOf(e.find, first + 1) >= 0) {
				missed.push(e);
				continue;
			}
			text = text.slice(0, first) + e.replace + text.slice(first + e.find.length);
			continue;
		}
		const hits = looseRange(text, e.find);
		if (hits.length !== 1) {
			missed.push(e);
			continue;
		}
		const [a, b] = hits[0];
		text = text.slice(0, a) + e.replace + text.slice(b);
	}
	return { content: text, missed };
}

const STATE_CLASS = /^(?:is|has|js)-|^(?:active|open|current|visible|hidden|selected|disabled|sr-only)$/;

/**
 * Classes the pages use that no stylesheet rule mentions (the shared stylesheet, or the page's own
 * <style>), ignoring state classes scripts toggle. Pages and the look are written side by side from the
 * plan's class list; this is the check that they met, and the input of one short pass that adds rules.
 */
export function unstyledClasses(pages: { path: string; content: string }[], css: string): string[] {
	const styled = (sheet: string) => new Set([...sheet.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]));
	const shared = styled(css);
	const missing = new Set<string>();
	for (const page of pages) {
		const own = styled([...page.content.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n'));
		for (const m of page.content.matchAll(/\sclass="([^"]*)"/g)) {
			for (const c of m[1].split(/\s+/)) {
				if (c && !shared.has(c) && !own.has(c) && !STATE_CLASS.test(c)) missing.add(c);
			}
		}
	}
	return [...missing].sort();
}
