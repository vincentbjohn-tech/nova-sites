/**
 * The phased builder's model: one plain completion through Nova's model gateway (nova-agent's
 * OpenAI-compatible `/v1/chat/completions`, the Claude CLI route first). No tools, no streaming:
 * a phase is one answer. The model is `NOVA_PHASE_MODEL` (default `cli:claude-sonnet`, the fast
 * CLI model; the gateway falls back on its own when the CLI can't answer).
 */
import { resolveNovaGatewayModel } from '../think/nova-gateway';
import type { ChatMessage } from './runner';

export const NOVA_PHASE_DEFAULT_MODEL = 'cli:claude-sonnet';
export const NOVA_PLAN_DEFAULT_EFFORT = 'low';
export const NOVA_PHASE_DEFAULT_EFFORT = 'medium';

export class GatewayError extends Error {}

export function phaseModel(env: unknown, fetcher: typeof fetch = (...a) => fetch(...a)) {
	const gw = resolveNovaGatewayModel(env);
	const model = ((env as { NOVA_PHASE_MODEL?: string }).NOVA_PHASE_MODEL ?? '').trim() || NOVA_PHASE_DEFAULT_MODEL;
	// The plan is quick (low: at the CLI's default a plan spent most of its output thinking, 10 Oct); a
	// page gets more care (medium: at low the pages came out thin).
	const e = env as { NOVA_PLAN_EFFORT?: string; NOVA_PHASE_EFFORT?: string };
	const planEffort = (e.NOVA_PLAN_EFFORT ?? '').trim() || NOVA_PLAN_DEFAULT_EFFORT;
	const phaseEffort = (e.NOVA_PHASE_EFFORT ?? '').trim() || NOVA_PHASE_DEFAULT_EFFORT;
	if (!gw) return null;
	return async (messages: ChatMessage[], opts?: { label?: string }): Promise<string> => {
		const effort = opts?.label === 'first' ? planEffort : phaseEffort;
		const r = await fetcher(`${gw.baseURL}/chat/completions`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${gw.apiKey}`, 'Content-Type': 'application/json' },
			// Plain text: the gateway's CLI route then writes the page as it is, not inside a JSON string.
			body: JSON.stringify({ model, messages, stream: false, response_format: { type: 'text' }, reasoning_effort: effort }),
		});
		if (!r.ok) throw new GatewayError(`the model gateway answered ${r.status}`);
		const body = (await r.json()) as { choices?: { message?: { content?: unknown } }[] };
		const content = body.choices?.[0]?.message?.content;
		if (typeof content !== 'string' || !content.trim()) throw new GatewayError('the model gateway answered with no words');
		return content;
	};
}

/** Is the phased builder switched on (`NOVA_PHASIC=on`)? Off: the think agent as before. */
export function phasicOn(env: unknown): boolean {
	return ((env as { NOVA_PHASIC?: string }).NOVA_PHASIC ?? '').trim().toLowerCase() === 'on';
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
