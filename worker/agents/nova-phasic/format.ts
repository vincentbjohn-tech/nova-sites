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
	/** A small change's name in the owner's words ("Buttons to emerald"), for the timeline. */
	name?: string;
	/** Paths the answer tried to write outside `public/` (dropped). */
	dropped: string[];
	/** Paths whose block never ended (not written). */
	unterminated: string[];
	/** Paths with a block that holds nothing usable (an EDIT with no REPLACE): never "just words". */
	malformed: string[];
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

// `<<<FILE public/x.html>>>`, or the slip `<<<FILE>>> public/x.html`.
const OPEN = /<<<(FILE|EDIT|APPEND)(?: ([^>\n]+)>>>|>>> *([^\s<>]+)) *\n?/g;

export function parsePhaseOutput(text: string): PhaseOutput {
	const out: PhaseOutput = { files: [], edits: [], dropped: [], unterminated: [], malformed: [] };
	const reply = /<<<REPLY>>>\n?([\s\S]*?)<<<END REPLY>>>/.exec(text);
	if (reply) out.reply = reply[1].trim() || undefined;
	const name = /<<<NAME>>>\n?([\s\S]*?)<<<END NAME>>>/.exec(text);
	if (name) out.name = name[1].trim().slice(0, 60) || undefined;
	const layout = /<<<LAYOUT>>>\n?([\s\S]*?)<<<END LAYOUT>>>/.exec(text);
	if (layout) out.layout = layout[1].trim() || undefined;

	OPEN.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = OPEN.exec(text))) {
		const kind = m[1];
		const path = normalPath(m[2] ?? m[3]);
		const start = m.index + m[0].length;
		const endMarker = kind === 'FILE' ? '<<<END FILE>>>' : kind === 'APPEND' ? '<<<END APPEND>>>' : '<<<END EDIT>>>';
		const end = text.indexOf(endMarker, start);
		// Another block opening before this one ends: this one was cut off.
		const nextOpen = text.slice(start).search(/<<<(?:FILE|EDIT|APPEND)(?: [^>\n]+>>>|>>> *[^\s<>]+)/);
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
		// An EDIT written without its <<<FIND>>> line: the text before <<<REPLACE>>> is what it finds.
		const pairs = inner.includes('<<<FIND>>>') ? inner.split('<<<FIND>>>').slice(1) : inner.includes('<<<REPLACE>>>') ? [inner] : [];
		const had = out.edits.length;
		for (const pair of pairs) {
			const at = pair.indexOf('<<<REPLACE>>>');
			if (at < 0) continue;
			// A stray XML-style closer ("</FIND>", "</REPLACE>") on its own last line is a slip, not page text.
			const unclose = (t: string) => t.replace(/\n?[ \t]*<\/(?:FIND|REPLACE)>[ \t]*$/i, '');
			const find = unclose(body(pair.slice(0, at).replace(/^\n/, ''), false));
			const replace = unclose(body(pair.slice(at + '<<<REPLACE>>>'.length).replace(/^\n/, ''), false));
			if (find.trim()) out.edits.push({ path, find, replace });
		}
		if (out.edits.length === had) out.malformed.push(path);
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

/** Sections a full new page has (the old builder's pages, 10 Oct: home 6, the others 4). */
const MIN_SECTIONS: Record<string, number> = { 'public/index.html': 6 };
const DEFAULT_MIN_SECTIONS = 4;

/**
 * What a NEW page of a new site is missing to be a full page: enough sections, and a photo in the
 * section it opens with (Vincent, 11 Oct: "as rich as the old one"; a contact page had an empty hero).
 * Not for a 404 page, and never for edits to a page that exists. `counted` false: the plan's outline
 * decides how many sections a page has; only the photo it opens with is checked.
 */
export function pageShortfalls(path: string, html: string, counted = true): string[] {
	if (!/^public\/.+\.html?$/.test(path) || /(^|\/)404\.html?$/.test(path)) return [];
	const out: string[] = [];
	const sections = [...html.matchAll(/<section\b[^>]*>([\s\S]*?)<\/section>/gi)];
	const want = MIN_SECTIONS[path] ?? DEFAULT_MIN_SECTIONS;
	// A plan with an outline sets each page's sections (a short book-a-call page is short on purpose:
	// 12 Oct, two rebuilds refused for "5 sections; at least 6" and nothing was saved).
	if (counted && sections.length < want) out.push(`${path} has ${sections.length} sections; a full page here has at least ${want}`);
	const first = sections[0]?.[0] ?? '';
	if (!/<img\b|<picture\b|background(-image)?\s*:[^;"]*url\(/i.test(first))
		out.push(`${path} opens without a photo; its first section needs one (an <img> or a background image)`);
	return out;
}

/** An address of one of the site's own pages ("about.html", "/about", "/", "./index.html"). */
function isPageHref(href: string): boolean {
	if (/^(?:[a-z]+:|#|\/\/)/i.test(href)) return false;
	return /\.html?$/i.test(href) || /^\.?\/?[a-z0-9-]*\/?$/i.test(href);
}

/**
 * Add a new page to every menu of a page, by code (the model writes only the new page: rewriting every
 * page for one link took two minutes, 11 Oct). A menu is a run of two or more links to the site's own
 * pages, side by side (or each in its own <li>); the last link of the run is copied with the new address
 * and name, in the same address style, without a "current page" mark. Never twice; a lone link in a
 * sentence is not a menu.
 */
export function addMenuLink(html: string, newPath: string, label: string): string {
	const base = newPath.replace(/^public\//, '').replace(/\.html?$/i, '');
	const already = new RegExp(`href="(?:\\.?\\/)?${base}(?:\\.html?)?\\/?"`, 'i');
	if (already.test(html)) return html;
	const anchors = [...html.matchAll(/<a\b([^>]*)\bhref="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/gi)].map((m) => ({
		start: m.index!,
		end: m.index! + m[0].length,
		before: m[1],
		href: m[2],
		after: m[3],
		page: isPageHref(m[2]),
	}));
	const inserts: { at: number; text: string }[] = [];
	let run: typeof anchors = [];
	const close = () => {
		if (run.length >= 2) {
			const last = run[run.length - 1];
			const href = /\.html?$/i.test(last.href) ? last.href.replace(/[^/]*\.html?$/i, `${base}.html`) : `${last.href.startsWith('/') ? '/' : ''}${base}`;
			const attrs = (last.before + last.after)
				.replace(/\s*aria-current="[^"]*"/gi, '')
				.replace(/class="([^"]*)"/i, (_m, c: string) => {
					const kept = c.split(/\s+/).filter((x) => x && !/^(?:on|active|current|is-active|is-current|selected)$/i.test(x));
					return kept.length ? `class="${kept.join(' ')}"` : '';
				})
				.replace(/\s{2,}/g, ' ')
				.trimEnd();
			const link = `<a href="${href}"${attrs ? ` ${attrs.trim()}` : ''}>${label}</a>`;
			const tail = /^\s*<\/li>/i.exec(html.slice(last.end));
			if (tail) {
				const open = /<li\b[^>]*>\s*$/i.exec(html.slice(0, last.start));
				inserts.push({ at: last.end + tail[0].length, text: `${open ? open[0].trim() : '<li>'}${link}</li>` });
			} else inserts.push({ at: last.end, text: link });
		}
		run = [];
	};
	for (const a of anchors) {
		if (!a.page) {
			close();
			continue;
		}
		const prev = run[run.length - 1];
		if (prev && !/^\s*(?:<\/li>\s*<li\b[^>]*>\s*)?$/i.test(html.slice(prev.end, a.start))) close();
		run.push(a);
	}
	close();
	let out = html;
	for (const i of inserts.sort((x, y) => y.at - x.at)) out = out.slice(0, i.at) + i.text + out.slice(i.at);
	return out;
}
