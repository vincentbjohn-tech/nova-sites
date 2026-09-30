/**
 * Nova Sites: changes the owner makes by hand, without the agent. Pure
 * functions over the site's source files, so they are fast (no model) and
 * testable; the behavior writes, commits and redeploys the result.
 */

export interface SourceFile {
	path: string;
	content: string;
}

export type TextEditResult =
	| { ok: true; path: string; content: string }
	| { ok: false; error: 'not_found' | 'ambiguous' | 'empty' };

/** Files a visible word can live in. Config, lockfiles and build output are never edited. */
export function isEditableSource(path: string): boolean {
	if (/(^|\/)(node_modules|dist|\.think|\.git)\//.test(path)) return false;
	return /\.(html?|jsx?|tsx?|css|md|json)$/.test(path) && !/(^|\/)(wrangler\.json|package(-lock)?\.json|tsconfig[^/]*\.json)$/.test(path);
}

const ENTITY_ALTERNATIVES: Record<string, string[]> = {
	'&': ['&', '&amp;'],
	'<': ['<', '&lt;'],
	'>': ['>', '&gt;'],
	'"': ['"', '&quot;', '&#34;', '\\\\"'],
	"'": ["'", '&#39;', '&apos;', '’', '&rsquo;', "\\\\'"],
	'’': ['’', '&rsquo;', "'", '&#39;', '&#8217;'],
	'‘': ['‘', '&lsquo;', "'", '&#8216;'],
	'“': ['“', '&ldquo;', '"', '&#8220;'],
	'”': ['”', '&rdquo;', '"', '&#8221;'],
	'—': ['—', '&mdash;', '&#8212;'],
	'–': ['–', '&ndash;', '&#8211;'],
	'…': ['…', '&hellip;', '...'],
	' ': [' ', '&nbsp;', ' '],
	'·': ['·', '&middot;', '&#183;'],
	'★': ['★', '&#9733;'],
};

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A pattern that matches the text as a browser shows it against the source it
 * came from: runs of whitespace match any whitespace (the browser collapses
 * line breaks), and typographic characters match their HTML entities.
 */
export function visibleTextPattern(text: string): RegExp {
	let source = '';
	for (const part of text.trim().split(/(\s+)/)) {
		if (!part) continue;
		if (/^\s+$/.test(part)) {
			source += '\\s+';
			continue;
		}
		for (const ch of part) {
			const alternatives = ENTITY_ALTERNATIVES[ch];
			source += alternatives
				? `(?:${alternatives.map((a) => (a.startsWith('\\\\') ? a : escapeRegExp(a))).join('|')})`
				: escapeRegExp(ch);
		}
	}
	return new RegExp(source, 'g');
}

/** Text written into HTML source: the characters that would break markup are escaped. */
function asSourceText(replace: string, path: string): string {
	if (!/\.html?$/.test(path)) return replace;
	return replace.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Replace one visible piece of text in the site's source. It must appear
 * exactly once across the editable files (or once in `path` when given):
 * zero is `not_found`, more than one is `ambiguous` (the owner is asked to
 * pick more of the sentence), never a guess.
 */
export function replaceVisibleText(
	files: SourceFile[],
	find: string,
	replace: string,
	path?: string,
): TextEditResult {
	if (!find.trim()) return { ok: false, error: 'empty' };
	const pattern = visibleTextPattern(find);
	const candidates = files.filter((f) => (path ? f.path === path : isEditableSource(f.path)));
	const hits: { file: SourceFile; index: number; length: number }[] = [];
	for (const file of candidates) {
		for (const match of file.content.matchAll(pattern)) {
			hits.push({ file, index: match.index ?? 0, length: match[0].length });
		}
	}
	if (hits.length === 0) return { ok: false, error: 'not_found' };
	if (hits.length > 1) return { ok: false, error: 'ambiguous' };
	const { file, index, length } = hits[0];
	const content = file.content.slice(0, index) + asSourceText(replace, file.path) + file.content.slice(index + length);
	return { ok: true, path: file.path, content };
}

export interface SiteMeta {
	title?: string;
	description?: string;
	iconUrl?: string;
	shareImageUrl?: string;
}

function attr(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function upsertTag(html: string, find: RegExp, tag: string): string {
	if (find.test(html)) return html.replace(find, tag);
	return html.replace(/<\/head>/i, `    ${tag}\n  </head>`);
}

/** Set the page's title, description, icon and share image in `<head>` (Google & sharing). */
export function setHeadMeta(html: string, meta: SiteMeta): string {
	let out = html;
	if (meta.title !== undefined) {
		const t = attr(meta.title);
		out = upsertTag(out, /<title>[\s\S]*?<\/title>/i, `<title>${t}</title>`);
		out = upsertTag(out, /<meta\s+property=["']og:title["'][^>]*>/i, `<meta property="og:title" content="${t}">`);
		out = upsertTag(out, /<meta\s+name=["']twitter:title["'][^>]*>/i, `<meta name="twitter:title" content="${t}">`);
	}
	if (meta.description !== undefined) {
		const d = attr(meta.description);
		out = upsertTag(out, /<meta\s+name=["']description["'][^>]*>/i, `<meta name="description" content="${d}">`);
		out = upsertTag(out, /<meta\s+property=["']og:description["'][^>]*>/i, `<meta property="og:description" content="${d}">`);
		out = upsertTag(out, /<meta\s+name=["']twitter:description["'][^>]*>/i, `<meta name="twitter:description" content="${d}">`);
	}
	if (meta.iconUrl === '') {
		out = out.replace(/\s*<link\s+rel=["'](?:shortcut )?icon["'][^>]*>/gi, '');
	} else if (meta.iconUrl !== undefined) {
		out = upsertTag(out, /<link\s+rel=["'](?:shortcut )?icon["'][^>]*>/i, `<link rel="icon" href="${attr(meta.iconUrl)}">`);
	}
	if (meta.shareImageUrl === '') {
		out = out.replace(/\s*<meta\s+(?:property|name)=["'](?:og:image|twitter:image|twitter:card)["'][^>]*>/gi, '');
	} else if (meta.shareImageUrl !== undefined) {
		const s = attr(meta.shareImageUrl);
		out = upsertTag(out, /<meta\s+property=["']og:image["'][^>]*>/i, `<meta property="og:image" content="${s}">`);
		out = upsertTag(out, /<meta\s+name=["']twitter:card["'][^>]*>/i, '<meta name="twitter:card" content="summary_large_image">');
		out = upsertTag(out, /<meta\s+name=["']twitter:image["'][^>]*>/i, `<meta name="twitter:image" content="${s}">`);
	}
	return out;
}

/** Commit messages for the owner's own changes start with this, so History can say "you". */
export const OWNER_COMMIT_PREFIX = 'you: ';

export interface HistoryEntry {
	hash: string;
	message: string;
	by: 'nova' | 'you';
	at: string;
}

/**
 * Git log → the History list: one entry per finished change (a request to
 * Nova, labelled with what was asked; an edit or restore by the owner), in
 * plain words, newest first. The agent's intermediate saves inside a turn are
 * not entries, so Undo always goes back one whole change.
 */
export function toHistory(
	log: { oid: string; message: string; author?: { timestamp?: number } }[],
	labels: Record<string, string>,
): HistoryEntry[] {
	return log
		.filter((c) => labels[c.oid] || c.message.trim().startsWith(OWNER_COMMIT_PREFIX))
		.map((c) => {
			const raw = c.message.trim();
			// The owner's own edits, and restores (only the owner restores).
			const byOwner = raw.startsWith(OWNER_COMMIT_PREFIX) || raw.startsWith('rollback:');
			const label = labels[c.oid] ?? (byOwner ? raw.slice(OWNER_COMMIT_PREFIX.length) : raw.replace(/^(chore|deploy|feat|fix|style|refactor)(\([^)]*\))?:\s*/, ''));
			const seconds = c.author?.timestamp ?? 0;
			return {
				hash: c.oid,
				message: label.charAt(0).toUpperCase() + label.slice(1),
				by: byOwner ? 'you' : 'nova',
				at: new Date(seconds * 1000).toISOString(),
			};
		});
}

/** The page's current icon and share image (Settings shows them after a reload). */
export function readHeadMeta(html: string): { iconUrl: string | null; shareImageUrl: string | null } {
	const icon = /<link\s+rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']*)["']/i.exec(html)?.[1] ?? null;
	const share = /<meta\s+property=["']og:image["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1] ?? null;
	return { iconUrl: icon && !icon.startsWith('data:') ? icon.replace(/&amp;/g, '&') : icon, shareImageUrl: share ? share.replace(/&amp;/g, '&') : null };
}
