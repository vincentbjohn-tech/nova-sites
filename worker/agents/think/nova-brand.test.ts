import { describe, expect, it } from 'vitest';
import { contrastOf, planColour, planLogo, readBrand, readableInk } from './nova-brand';

const css = (root: string) => ({ path: 'public/styles.css', content: `:root{\n  ${root}\n}\nbody{color:var(--ink)}\n.btn{background:var(--primary)}\n` });
const page = (path: string, header: string) => ({
	path,
	content: `<!doctype html><html><head><title>x</title></head><body><header>${header}</header><main><img src="/a.jpg" alt="hair"></main></body></html>`,
});

describe('reading the brand: the main colour and the logo, as the site has them now', () => {
	it('the main colour is the --primary of the stylesheet', () => {
		const b = readBrand([css('--bg:#FBF6F4; --ink:#2A1720; --primary:#5C2340; --primary-ink:#FBF6F4;'), page('public/index.html', '')]);
		expect(b.colour).toBe('#5C2340');
	});
	it('the second colour is the --accent, where the style has one', () => {
		expect(readBrand([css('--primary:#5C2340; --accent:#D9707E;')]).accent).toBe('#D9707E');
		expect(readBrand([css('--primary:#5C2340;')]).accent).toBeNull();
	});
	it('a site with no --primary has no colour to change (null, never a guess)', () => {
		expect(readBrand([css('--bg:#fff; --ink:#111;')]).colour).toBeNull();
	});
	it('an image logo: the picture inside the element marked logo', () => {
		const b = readBrand([page('public/index.html', '<a class="logo" href="/"><img src="https://x/logo.png" alt="Kristi Grace"></a><nav></nav>')]);
		expect(b.logo).toEqual({ kind: 'image', src: 'https://x/logo.png', alt: 'Kristi Grace' });
	});
	it('a word logo: its words', () => {
		const b = readBrand([page('public/index.html', '<a class="logo" href="/" aria-label="home"><b>Kristi <i>Grace</i></b><span>Hair</span></a>')]);
		expect(b.logo).toEqual({ kind: 'text', text: 'Kristi Grace Hair' });
	});
	it('a logo in a top bar outside the <header> (the header is a thin info strip) is still found', () => {
		const html = '<header class="bar"><span>Austin, TX</span></header><nav class="main"><a class="logo" href="index.html"><b>Kristi <i>Grace</i></b><span>Hair Studio</span></a></nav>';
		expect(readBrand([{ path: 'public/index.html', content: html }]).logo).toEqual({ kind: 'text', text: 'Kristi Grace Hair Studio' });
	});
	it('no element marked logo: the first picture in the header, else nothing', () => {
		expect(readBrand([page('public/index.html', '<img src="/brand.svg" alt="Maple"><nav></nav>')]).logo).toEqual({ kind: 'image', src: '/brand.svg', alt: 'Maple' });
		expect(readBrand([page('public/index.html', '<nav><a href="/">Home</a></nav>')]).logo).toBeNull();
	});
});

describe('changing the main colour: every --primary on the site, its shades moved with it, text on it kept readable', () => {
	it('sets --primary everywhere it is declared (stylesheet and a page with its own :root)', () => {
		const inline = { path: 'public/about.html', content: '<style>:root{--primary:#5C2340}</style><p>x</p>' };
		const plan = planColour([css('--primary:#5C2340; --primary-ink:#FBF6F4; --bg:#FBF6F4; --ink:#2A1720;'), inline], '#1F7A5A');
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.files.map((f) => f.path).sort()).toEqual(['public/about.html', 'public/styles.css']);
		for (const f of plan.files) expect(f.content).toMatch(/--primary:\s*#1F7A5A/);
		expect(plan.from).toBe('#5C2340');
	});
	it('the text on buttons stays readable: a light colour gets dark text, a dark colour light text', () => {
		const base = '--primary:#5C2340; --primary-ink:#FBF6F4; --bg:#FBF6F4; --ink:#2A1720;';
		const light = planColour([css(base)], '#F4D35E');
		const dark = planColour([css(base)], '#123456');
		if (!light.ok || !dark.ok) throw new Error('no plan');
		expect(light.files[0].content).toMatch(/--primary-ink:\s*#2A1720/);
		expect(dark.files[0].content).toMatch(/--primary-ink:\s*#FBF6F4/);
	});
	it('its shades (hover, tint, deep) keep their relation to the main colour', () => {
		const plan = planColour([css('--primary:#336699; --primary-hover:#29527A; --primary-tint:#D6E0EB; --bg:#fff; --ink:#111;')], '#993333');
		if (!plan.ok) throw new Error('no plan');
		const c = plan.files[0].content;
		const hover = c.match(/--primary-hover:\s*(#[0-9A-F]{6})/i)?.[1];
		const tint = c.match(/--primary-tint:\s*(#[0-9A-F]{6})/i)?.[1];
		expect(hover).toBeDefined();
		expect(tint).toBeDefined();
		// Hover stays darker than the new colour, the tint lighter; both now reddish.
		const lum = (h: string) => parseInt(h.slice(1, 3), 16) + parseInt(h.slice(3, 5), 16) + parseInt(h.slice(5, 7), 16);
		expect(lum(hover!)).toBeLessThan(lum('#993333'));
		expect(lum(tint!)).toBeGreaterThan(lum('#993333'));
		expect(parseInt(hover!.slice(1, 3), 16)).toBeGreaterThan(parseInt(hover!.slice(5, 7), 16));
	});
	it('accepts #abc and any case; refuses what is not a colour', () => {
		const ok = planColour([css('--primary:#5C2340;')], '#0a0');
		expect(ok.ok && ok.files[0].content).toMatch(/--primary:\s*#00AA00/);
		expect(planColour([css('--primary:#5C2340;')], 'green; } body{display:none')).toEqual({ ok: false, error: 'bad_colour' });
	});
	it('no --primary anywhere: says so (the change then goes to Nova)', () => {
		expect(planColour([css('--bg:#fff;')], '#123456')).toEqual({ ok: false, error: 'no_colour' });
	});
	it('the same colour again changes nothing', () => {
		expect(planColour([css('--primary:#5C2340;')], '#5c2340')).toEqual({ ok: false, error: 'same' });
	});
});

describe('changing the second colour (--accent): only it and its shades, its text form kept readable', () => {
	it('moves --accent and --accent-text, leaves --primary alone', () => {
		const plan = planColour([css('--bg:#FBF6F4; --primary:#5C2340; --accent:#D9707E; --accent-text:#B4445A;')], '#F4D35E', '--accent');
		if (!plan.ok) throw new Error('no plan');
		const c = plan.files[0].content;
		expect(c).toMatch(/--accent:\s*#F4D35E/);
		expect(c).toMatch(/--primary:\s*#5C2340/);
		// A yellow accent's text form is darkened until it reads on the light page.
		const text = c.match(/--accent-text:\s*(#[0-9A-F]{6})/i)?.[1];
		expect(text).toBeDefined();
		expect(contrastOf(text!, '#FBF6F4')).toBeGreaterThanOrEqual(4.5);
	});
});

describe('changing the logo picture: the same picture on every page', () => {
	it('replaces the logo picture wherever it is used, nothing else', () => {
		const files = [
			page('public/index.html', '<a class="logo"><img src="https://x/old.png" alt="K"></a>'),
			page('public/services.html', '<a class="logo"><img src="https://x/old.png" alt="K"></a>'),
			page('public/about.html', '<a class="logo">K</a>'),
		];
		const plan = planLogo(files, 'https://x/old.png', 'https://x/new.png');
		expect(plan.map((f) => f.path)).toEqual(['public/index.html', 'public/services.html']);
		for (const f of plan) {
			expect(f.content).toContain('src="https://x/new.png"');
			expect(f.content).toContain('src="/a.jpg"');
		}
	});
	it('only in pages, and only as a picture address (not in words that happen to match)', () => {
		const files = [{ path: 'public/index.html', content: '<p>old.png</p><img src="old.png">' }, { path: 'public/app.js', content: 'const a="old.png"' }];
		const plan = planLogo(files, 'old.png', 'new.png');
		expect(plan).toHaveLength(1);
		expect(plan[0].content).toBe('<p>old.png</p><img src="new.png">');
	});
});

describe('readable text on a colour', () => {
	it('picks the candidate with enough contrast, in the order given', () => {
		expect(readableInk('#FFFFFF', ['#FBF6F4', '#2A1720'])).toBe('#2A1720');
		expect(readableInk('#000000', ['#FBF6F4', '#2A1720'])).toBe('#FBF6F4');
		expect(readableInk('#777777', [])).toMatch(/^#(FFFFFF|111111)$/);
	});
});
