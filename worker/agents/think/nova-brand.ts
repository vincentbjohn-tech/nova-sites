import type { SourceFile } from './nova-edits';

/*
 * The site's brand as the owner can change it from Settings (Vincent, 12 Oct: "it takes the logo's
 * colour as its main colour, but you should be able to swap both"): the main colour is the site's
 * `--primary` (every style in the library names it so), the logo is the element marked `logo` in the
 * header (or the header's first picture). Changing the colour rewrites `--primary` wherever it is
 * declared, moves its shades with it and keeps the text on it readable; changing the logo picture
 * swaps its address on every page. Pure, so it is tested; no model, so it is instant.
 */

export interface Brand {
	colour: string | null;
	/** The second colour (`--accent`) where the style has one: highlights, small marks, links. */
	accent: string | null;
	logo: { kind: 'image'; src: string; alt: string } | { kind: 'text'; text: string } | null;
}

const isPage = (path: string) => /\.html?$/i.test(path);
const isStyle = (path: string) => /\.css$/i.test(path);
/** `:root{…}` blocks, in a stylesheet or a page's own <style>. */
const ROOT_BLOCK = /:root\s*\{[^}]*\}/g;
const decl = (name: string) => new RegExp(`(${name.replace(/-/g, '\\-')}\\s*:\\s*)([^;}\\n]+)`, 'i');

function rootValue(files: SourceFile[], name: string): string | null {
	const ordered = [...files.filter((f) => isStyle(f.path)), ...files.filter((f) => isPage(f.path))];
	for (const f of ordered) {
		for (const block of f.content.match(ROOT_BLOCK) ?? []) {
			const m = block.match(decl(name));
			if (m) return m[2].trim();
		}
	}
	return null;
}

const words = (html: string) =>
	html
		.replace(/<[^>]*>/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&nbsp;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'))?.slice(2).find((v) => v !== undefined) ?? '';

export function readBrand(files: SourceFile[]): Brand {
	const raw = rootValue(files, '--primary');
	const colour = raw && hex(raw) ? raw : null;
	const rawAccent = rootValue(files, '--accent');
	const accent = rawAccent && hex(rawAccent) ? rawAccent : null;
	const home = files.find((f) => /(^|\/)index\.html?$/i.test(f.path)) ?? files.find((f) => isPage(f.path));
	let logo: Brand['logo'] = null;
	if (home) {
		const header = home.content.match(/<header\b[\s\S]*?<\/header>/i)?.[0] ?? '';
		// The element marked logo (or brand), wherever the page's top bar puts it (a <header>, or a
		// bar of its own after it): <a class="logo">…</a>, <div class="brand">…</div>.
		const marked = home.content.match(/<(a|div|span|p)\b[^>]*class\s*=\s*["'][^"']*\b(logo|brand)\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i);
		const img = (marked ? marked[3] : header).match(/<img\b[^>]*>/i)?.[0];
		if (img) logo = { kind: 'image', src: attr(img, 'src'), alt: attr(img, 'alt') };
		else if (marked && words(marked[3])) logo = { kind: 'text', text: words(marked[3]) };
	}
	return { colour, accent, logo };
}

// ---- colours -------------------------------------------------------------------------------

type RGB = [number, number, number];

/** "#abc", "#AABBCC" → "#AABBCC"; anything else → null (no injection through a colour). */
export function hex(value: string): string | null {
	const v = value.trim();
	const short = v.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
	if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toUpperCase();
	return /^#[0-9a-f]{6}$/i.test(v) ? v.toUpperCase() : null;
}
const rgb = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const toHex = (c: RGB) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

function luminance(h: string): number {
	const [r, g, b] = rgb(h).map((v) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export const contrastOf = (a: string, b: string) => contrast(a, b);
const contrast = (a: string, b: string) => {
	const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
	return (x + 0.05) / (y + 0.05);
};

/** Text for on top of `bg`: the first candidate that reads (4.5:1), else whichever of white and near-black reads best. */
export function readableInk(bg: string, candidates: string[]): string {
	for (const c of candidates.map(hex).filter((c): c is string => !!c)) if (contrast(bg, c) >= 4.5) return c;
	return contrast(bg, '#FFFFFF') >= contrast(bg, '#111111') ? '#FFFFFF' : '#111111';
}

function hsl([r, g, b]: RGB): RGB {
	const [R, G, B] = [r / 255, g / 255, b / 255];
	const max = Math.max(R, G, B);
	const min = Math.min(R, G, B);
	const l = (max + min) / 2;
	if (max === min) return [0, 0, l];
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
	return [h * 60, s, l];
}
function fromHsl([h, s, l]: RGB): RGB {
	const k = (n: number) => (n + h / 30) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return [f(0) * 255, f(8) * 255, f(4) * 255];
}
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** A shade that was `shade` next to `from` becomes the same shade next to `to` (hue, saturation and lightness moved by the same amount). */
function moveShade(shade: string, from: string, to: string): string {
	const [h0, s0, l0] = hsl(rgb(from));
	const [h1, s1, l1] = hsl(rgb(shade));
	const [h2, s2, l2] = hsl(rgb(to));
	return toHex(fromHsl([(h2 + (h1 - h0) + 360) % 360, clamp01(s2 + (s1 - s0)), clamp01(l2 + (l1 - l0))]));
}

export type ColourPlan = { ok: true; from: string; files: SourceFile[] } | { ok: false; error: 'bad_colour' | 'no_colour' | 'same' };

/** `fg` darkened or lightened (keeping its hue) until it reads on `bg` at 4.5:1. */
function readableOn(fg: string, bg: string): string {
	if (contrast(fg, bg) >= 4.5) return fg;
	const [h, sat, l] = hsl(rgb(fg));
	const darker = luminance(bg) > 0.4;
	for (let step = 1; step <= 20; step += 1) {
		const c = toHex(fromHsl([h, sat, clamp01(l + (darker ? -0.04 : 0.04) * step)]));
		if (contrast(c, bg) >= 4.5) return c;
	}
	return readableInk(bg, []);
}

/**
 * A new colour for `name` (`--primary`, the main colour, or `--accent`, the second one) wherever a
 * `:root` declares it. Its shades (`<name>-hover`, `-tint`, …) move with it; `<name>-ink` (text on
 * it) and `<name>-text` (it as text on the page) are kept readable.
 */
export function planColour(files: SourceFile[], wanted: string, name: '--primary' | '--accent' = '--primary'): ColourPlan {
	const to = hex(wanted);
	if (!to) return { ok: false, error: 'bad_colour' };
	const fromRaw = rootValue(files, name);
	const from = fromRaw ? hex(fromRaw) : null;
	if (!from) return { ok: false, error: 'no_colour' };
	if (from === to) return { ok: false, error: 'same' };
	const inkNow = rootValue(files, `${name}-ink`);
	const ink = readableInk(to, [inkNow ?? '', rootValue(files, '--bg') ?? '', rootValue(files, '--ink') ?? '']);
	const page = hex(rootValue(files, '--bg') ?? '') ?? '#FFFFFF';
	const pattern = new RegExp(`(${name}(-[a-z0-9-]+)?\\s*:\\s*)([^;}\\n]+)`, 'gi');
	const out: SourceFile[] = [];
	for (const f of files) {
		if (!isStyle(f.path) && !isPage(f.path)) continue;
		const content = f.content.replace(ROOT_BLOCK, (block) =>
			block.replace(pattern, (all, head: string, suffix: string | undefined, value: string) => {
				if (!suffix) return `${head}${to}`;
				if (suffix.toLowerCase() === '-ink') return `${head}${ink}`;
				const shade = hex(value);
				if (!shade) return all;
				const moved = moveShade(shade, from, to);
				return `${head}${suffix.toLowerCase() === '-text' ? readableOn(moved, page) : moved}`;
			}),
		);
		if (content !== f.content) out.push({ path: f.path, content });
	}
	return out.length ? { ok: true, from, files: out } : { ok: false, error: 'no_colour' };
}

/** The logo picture `from` becomes `to` wherever a page uses it as a picture address. */
export function planLogo(files: SourceFile[], from: string, to: string): SourceFile[] {
	const out: SourceFile[] = [];
	for (const f of files) {
		if (!isPage(f.path)) continue;
		let content = f.content;
		for (const q of ['"', "'"]) content = content.split(`src=${q}${from}${q}`).join(`src=${q}${to}${q}`);
		if (content !== f.content) out.push({ path: f.path, content });
	}
	return out;
}
