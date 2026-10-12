/**
 * The phased builder's model: one plain completion through Nova's model gateway (nova-agent's
 * OpenAI-compatible `/v1/chat/completions`, the Claude CLI route first). No tools, no streaming:
 * a phase is one answer. The model is `NOVA_PHASE_MODEL` (default `cli:claude-sonnet`, the fast
 * CLI model; the gateway falls back on its own when the CLI can't answer).
 */
import { resolveNovaGatewayModel } from '../think/nova-gateway';
import type { ChatMessage } from './runner';

export const NOVA_PHASE_DEFAULT_MODEL = 'cli:claude-sonnet';
/** Every first answer, above all a new site's plan (its outline is the contract every page builds): the strongest model. */
export const NOVA_PLAN_DEFAULT_MODEL = 'cli:claude-opus';
export const NOVA_NEW_PLAN_DEFAULT_EFFORT = 'high';
export const NOVA_PLAN_DEFAULT_EFFORT = 'low';
export const NOVA_PHASE_DEFAULT_EFFORT = 'medium';
export const NOVA_LOOK_DEFAULT_EFFORT = 'high';

export class GatewayError extends Error {}

export function phaseModel(env: unknown, fetcher: typeof fetch = (...a) => fetch(...a)) {
	const gw = resolveNovaGatewayModel(env);
	const model = ((env as { NOVA_PHASE_MODEL?: string }).NOVA_PHASE_MODEL ?? '').trim() || NOVA_PHASE_DEFAULT_MODEL;
	// The plan is quick (low: at the CLI's default a plan spent most of its output thinking, 10 Oct); a
	// page gets more care (medium: at low the pages came out thin).
	const e = env as { NOVA_PLAN_EFFORT?: string; NOVA_PHASE_EFFORT?: string };
	const planEffort = (e.NOVA_PLAN_EFFORT ?? '').trim() || NOVA_PLAN_DEFAULT_EFFORT;
	const phaseEffort = (e.NOVA_PHASE_EFFORT ?? '').trim() || NOVA_PHASE_DEFAULT_EFFORT;
	// The look and the home page set the whole site's quality: the most care (Vincent, 10 Oct).
	const lookEffort = ((env as { NOVA_LOOK_EFFORT?: string }).NOVA_LOOK_EFFORT ?? '').trim() || NOVA_LOOK_DEFAULT_EFFORT;
	const planModel = ((env as { NOVA_PLAN_MODEL?: string }).NOVA_PLAN_MODEL ?? '').trim() || NOVA_PLAN_DEFAULT_MODEL;
	const newPlanEffort = ((env as { NOVA_NEW_PLAN_EFFORT?: string }).NOVA_NEW_PLAN_EFFORT ?? '').trim() || NOVA_NEW_PLAN_DEFAULT_EFFORT;
	if (!gw) return null;
	return async (messages: ChatMessage[], opts?: { label?: string }): Promise<string> => {
		const newPlan = opts?.label === 'first-new';
		const effort = newPlan ? newPlanEffort : opts?.label === 'first' ? planEffort : opts?.label?.startsWith('look') ? lookEffort : phaseEffort;
		// Every first answer (the plan, a small change, a question) is the plan model's: a rebuild of a site that
		// has pages is planned as carefully as a new one, only with less effort.
		const use = newPlan || opts?.label === 'first' ? planModel : model;
		const r = await fetcher(`${gw.baseURL}/chat/completions`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${gw.apiKey}`, 'Content-Type': 'application/json' },
			// Plain text: the gateway's CLI route then writes the page as it is, not inside a JSON string.
			// Streamed: the gateway sends a keep-alive every few seconds while the model writes, so a long
			// page (look + home, 2-4 min) isn't cut off as an idle connection (10 Oct: every live call past
			// ~2 min was lost, the same call from outside ran 280 s fine).
			body: JSON.stringify({ model: use, messages, stream: true, response_format: { type: 'text' }, reasoning_effort: effort }),
		});
		if (!r.ok) throw new GatewayError(`the model gateway answered ${r.status}`);
		const raw = await r.text();
		const content = /^\s*(data:|:)/.test(raw) ? fromStream(raw) : fromJson(safeJson(raw));
		if (!content.trim()) throw new GatewayError('the model gateway answered with no words');
		return content;
	};
}

/** Is the phased builder on for this builder user? `NOVA_PHASIC=on`: everyone. `NOVA_PHASIC_USERS`: only
 *  the listed user ids (a test account tries it while everyone else keeps the think agent). */
export function phasicOn(env: unknown, userId?: string): boolean {
	const e = env as { NOVA_PHASIC?: string; NOVA_PHASIC_USERS?: string };
	if ((e.NOVA_PHASIC ?? '').trim().toLowerCase() === 'on') return true;
	const users = (e.NOVA_PHASIC_USERS ?? '').split(',').map((u) => u.trim()).filter(Boolean);
	return !!userId && users.includes(userId);
}

/** A real browser's capture of the preview → the problems worth a fix pass (never a favicon). */
export function browserProblems(capture: {
	logs: { level: string; text: string }[];
	pageErrors: { message: string }[];
	requestFailures: { url: string; failure: string; status?: number }[];
}): string[] {
	const out: string[] = [];
	for (const e of capture.pageErrors) out.push(`Page error: ${e.message}`);
	for (const l of capture.logs) if (l.level === 'error' && !/favicon/i.test(l.text)) out.push(`Console error: ${l.text}`);
	for (const f of capture.requestFailures) if (!/favicon/i.test(f.url)) out.push(`Failed to load ${f.url}: ${f.status ?? f.failure}`);
	return [...new Set(out)];
}

function safeJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

function fromJson(body: unknown): string {
	const content = (body as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
	return typeof content === 'string' ? content : '';
}

/** An OpenAI-style SSE stream → its text. Comments (keep-alives) are skipped; an error event is an error. */
export function fromStream(text: string): string {
	let out = '';
	for (const line of text.split('\n')) {
		if (!line.startsWith('data:')) continue;
		const data = line.slice(5).trim();
		if (!data || data === '[DONE]') continue;
		let chunk: { error?: { message?: string }; choices?: { delta?: { content?: unknown } }[] };
		try {
			chunk = JSON.parse(data);
		} catch {
			continue;
		}
		if (chunk.error) throw new GatewayError(chunk.error.message || 'the model gateway failed mid-answer');
		const piece = chunk.choices?.[0]?.delta?.content;
		if (typeof piece === 'string') out += piece;
	}
	return out;
}
