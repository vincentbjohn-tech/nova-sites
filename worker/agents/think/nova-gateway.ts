/**
 * Nova's model gateway: an OpenAI-compatible `/v1/chat/completions` that
 * answers with the Claude CLI first and falls back to API routes (it lives in
 * nova-agent, `nova.services.model_gateway`). When `NOVA_GATEWAY_URL` and
 * `NOVA_GATEWAY_KEY` are set, the Think agent's model is resolved here instead
 * of through Cloudflare AI Gateway; prompts, tools and flow are unchanged.
 */

/** The gateway's model id: `cli:claude` is the Claude CLI route first, then the fallbacks. */
export const NOVA_GATEWAY_DEFAULT_MODEL = 'cli:claude';

/** Claude's context window; the gateway's fallbacks are at least as large. */
const NOVA_GATEWAY_CONTEXT_SIZE = 200_000;

export interface NovaGatewayModel {
	baseURL: string;
	apiKey: string;
	modelName: string;
	contextSize: number;
}

interface NovaGatewayEnv {
	NOVA_GATEWAY_URL?: string;
	NOVA_GATEWAY_KEY?: string;
	NOVA_GATEWAY_MODEL?: string;
}

export function resolveNovaGatewayModel(env: unknown): NovaGatewayModel | null {
	const { NOVA_GATEWAY_URL, NOVA_GATEWAY_KEY, NOVA_GATEWAY_MODEL } = env as NovaGatewayEnv;
	const baseURL = NOVA_GATEWAY_URL?.trim();
	const apiKey = NOVA_GATEWAY_KEY?.trim();
	if (!baseURL || !apiKey) return null;
	return {
		baseURL: baseURL.replace(/\/+$/, ''),
		apiKey,
		modelName: NOVA_GATEWAY_MODEL?.trim() || NOVA_GATEWAY_DEFAULT_MODEL,
		contextSize: NOVA_GATEWAY_CONTEXT_SIZE,
	};
}
