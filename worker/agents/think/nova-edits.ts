import type { ModelMessage } from 'ai';
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
	/** The home-screen icon (180 px). `''` removes it. */
	appleTouchIconUrl?: string;
	/** The page's real address: `<link rel=canonical>` and `og:url`. `''` removes both. */
	canonical?: string;
	/** Nova's business block for Google (JSON text). `''` removes it; the owner's own JSON-LD is never touched. */
	jsonLd?: string;
}

function attr(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function unattr(value: string): string {
	return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** A `<meta>` or `<link>` tag with this attribute anywhere in it (attribute order varies by generator). */
function tagWith(tag: 'meta' | 'link', name: string, value: string, flags = 'i'): RegExp {
	return new RegExp(`<${tag}\\b[^>]*\\b${name}=["']${escapeRegExp(value)}["'][^>]*>`, flags);
}

function upsertTag(html: string, find: RegExp, tag: string): string {
	if (find.test(html)) return html.replace(find, tag);
	return html.replace(/<\/head>/i, `    ${tag}\n  </head>`);
}

function removeTag(html: string, find: RegExp): string {
	const all = new RegExp(`\\s*${find.source}`, find.flags.includes('g') ? find.flags : `${find.flags}g`);
	return html.replace(all, '');
}

const NOVA_JSON_LD = /<script\b[^>]*\bdata-nova=["']business["'][^>]*>[\s\S]*?<\/script>/i;

/** JSON text that is safe inside `<script>`: `<` is written as `\u003c`, so no `</script>` can end it early. */
function scriptJson(text: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error('invalid_json_ld');
	}
	if (!parsed || typeof parsed !== 'object') throw new Error('invalid_json_ld');
	return JSON.stringify(parsed).replace(/</g, '\\u003c');
}

/** Set the page's title, description, icon, share image, address and business block in `<head>` (Google & sharing). */
export function setHeadMeta(html: string, meta: SiteMeta): string {
	let out = html;
	if (meta.title !== undefined) {
		const t = attr(meta.title);
		out = upsertTag(out, /<title>[\s\S]*?<\/title>/i, `<title>${t}</title>`);
		out = upsertTag(out, tagWith('meta', 'property', 'og:title'), `<meta property="og:title" content="${t}">`);
		out = upsertTag(out, tagWith('meta', 'name', 'twitter:title'), `<meta name="twitter:title" content="${t}">`);
	}
	if (meta.description !== undefined) {
		const d = attr(meta.description);
		out = upsertTag(out, tagWith('meta', 'name', 'description'), `<meta name="description" content="${d}">`);
		out = upsertTag(out, tagWith('meta', 'property', 'og:description'), `<meta property="og:description" content="${d}">`);
		out = upsertTag(out, tagWith('meta', 'name', 'twitter:description'), `<meta name="twitter:description" content="${d}">`);
	}
	if (meta.iconUrl === '') {
		out = out.replace(/\s*<link\s+rel=["'](?:shortcut )?icon["'][^>]*>/gi, '');
	} else if (meta.iconUrl !== undefined) {
		out = upsertTag(out, /<link\s+rel=["'](?:shortcut )?icon["'][^>]*>/i, `<link rel="icon" href="${attr(meta.iconUrl)}">`);
	}
	if (meta.appleTouchIconUrl === '') {
		out = removeTag(out, tagWith('link', 'rel', 'apple-touch-icon'));
	} else if (meta.appleTouchIconUrl !== undefined) {
		out = upsertTag(out, tagWith('link', 'rel', 'apple-touch-icon'), `<link rel="apple-touch-icon" href="${attr(meta.appleTouchIconUrl)}">`);
	}
	if (meta.shareImageUrl === '') {
		out = out.replace(/\s*<meta\b[^>]*\b(?:property|name)=["'](?:og:image|twitter:image|twitter:card)["'][^>]*>/gi, '');
	} else if (meta.shareImageUrl !== undefined) {
		const s = attr(meta.shareImageUrl);
		out = upsertTag(out, tagWith('meta', 'property', 'og:image'), `<meta property="og:image" content="${s}">`);
		out = upsertTag(out, tagWith('meta', 'name', 'twitter:card'), '<meta name="twitter:card" content="summary_large_image">');
		out = upsertTag(out, tagWith('meta', 'name', 'twitter:image'), `<meta name="twitter:image" content="${s}">`);
		if (!tagWith('meta', 'property', 'og:type').test(out)) out = upsertTag(out, tagWith('meta', 'property', 'og:type'), '<meta property="og:type" content="website">');
	}
	if (meta.canonical === '') {
		out = removeTag(out, tagWith('link', 'rel', 'canonical'));
		out = removeTag(out, tagWith('meta', 'property', 'og:url'));
	} else if (meta.canonical !== undefined) {
		const c = attr(meta.canonical);
		out = upsertTag(out, tagWith('link', 'rel', 'canonical'), `<link rel="canonical" href="${c}">`);
		out = upsertTag(out, tagWith('meta', 'property', 'og:url'), `<meta property="og:url" content="${c}">`);
	}
	if (meta.jsonLd === '') {
		out = out.replace(new RegExp(`\\s*${NOVA_JSON_LD.source}`, 'i'), '');
	} else if (meta.jsonLd !== undefined) {
		const tag = `<script type="application/ld+json" data-nova="business">${scriptJson(meta.jsonLd)}</script>`;
		// A function replacement: `$` in the JSON must not be read as a replacement pattern.
		out = NOVA_JSON_LD.test(out) ? out.replace(NOVA_JSON_LD, () => tag) : out.replace(/<\/head>/i, () => `    ${tag}\n  </head>`);
	}
	return out;
}

export interface PageMeta {
	title: string | null;
	description: string | null;
	canonical: string | null;
	iconUrl: string | null;
	appleTouchIconUrl: string | null;
	shareImageUrl: string | null;
	/** Nova's business block, as JSON text (the owner's own JSON-LD is not included). */
	jsonLd: string | null;
}

function contentOf(html: string, find: RegExp, attrName: 'content' | 'href'): string | null {
	const tag = find.exec(html)?.[0];
	if (!tag) return null;
	const value = new RegExp(`\\b${attrName}=(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
	return value ? unattr(value[1] ?? value[2] ?? '') : null;
}

/** Everything Google & sharing shows for one page, read from its `<head>`. */
export function readPageMeta(html: string): PageMeta {
	const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
	const block = NOVA_JSON_LD.exec(html)?.[0];
	return {
		title: title !== undefined ? unattr(title.trim()) : null,
		description: contentOf(html, tagWith('meta', 'name', 'description'), 'content'),
		canonical: contentOf(html, tagWith('link', 'rel', 'canonical'), 'href'),
		iconUrl: contentOf(html, /<link\s+rel=["'](?:shortcut )?icon["'][^>]*>/i, 'href'),
		appleTouchIconUrl: contentOf(html, tagWith('link', 'rel', 'apple-touch-icon'), 'href'),
		shareImageUrl: contentOf(html, tagWith('meta', 'property', 'og:image'), 'content'),
		jsonLd: block ? block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '') : null,
	};
}

/** A page of the site that has a `<head>`: an HTML file (served from `public/`). */
export function isPagePath(path: string): boolean {
	return /\.html?$/i.test(path) && !/(^|\/)(node_modules|dist|\.think|\.git)\//.test(path);
}

export type MetaPlan = { ok: true; changes: SourceFile[] } | { ok: false; error: 'not_found'; path: string };

/**
 * Google & sharing for several pages in one change: `shared` goes on every listed
 * page (the icon, the share image), each page's own `meta` on top (its title,
 * description, address, business block). Only pages whose HTML actually changes
 * are returned; a page that isn't one of the site's HTML files is `not_found`.
 */
export function planMetaChanges(files: SourceFile[], shared: SiteMeta, pages: { path: string; meta: SiteMeta }[]): MetaPlan {
	const byPath = new Map(files.map((f) => [f.path.replace(/^\/+/, ''), f.content]));
	const changes: SourceFile[] = [];
	for (const page of pages) {
		const path = page.path.replace(/^\/+/, '');
		const html = byPath.get(path);
		if (html === undefined || !isPagePath(path)) return { ok: false, error: 'not_found', path };
		// Only the fields this page really carries sit on top of the shared ones (absent = undefined).
		const own = Object.fromEntries(Object.entries(page.meta).filter(([, v]) => v !== undefined)) as SiteMeta;
		const next = setHeadMeta(html, { ...shared, ...own });
		if (next !== html) changes.push({ path, content: next });
	}
	return { ok: true, changes };
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

/**
 * An earlier owner message is context, never an instruction for this turn.
 * Without the label the model sometimes answers (or redoes) an old request
 * instead of the newest one, especially after the owner undid it.
 */
export const EARLIER_REQUEST_LABEL =
	'[Earlier message from the owner, already handled in a previous turn. Context only: do not act on it, answer it or bring it up again unless the owner asks. If it was undone or left out, that was on purpose.]';

export function markEarlierRequests(messages: ModelMessage[]): ModelMessage[] {
	const lastUser = messages.map((message) => message.role).lastIndexOf('user');
	return messages.map((message, index) => {
		if (message.role !== 'user' || index >= lastUser) return message;
		if (typeof message.content === 'string') {
			return { ...message, content: `${EARLIER_REQUEST_LABEL}\n${message.content}` };
		}
		return { ...message, content: [{ type: 'text' as const, text: EARLIER_REQUEST_LABEL }, ...message.content] };
	});
}
