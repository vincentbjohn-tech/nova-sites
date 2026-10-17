import { ModelSize, type AIModelConfig } from '../inferutils/config.types';

/**
 * The think agent's model when Nova's model gateway is NOT configured (NOVA_GATEWAY_URL/KEY unset).
 * Live, the gateway is always set and this is never used; it is Claude anyway, so no setting can
 * quietly send an owner's site to another vendor (Vincent, 2026-10-17: "for everything AI use Claude,
 * of course"). Sonnet 5.5: the same model the gateway falls back to.
 */
export const THINK_MODEL_ID = 'anthropic/claude-sonnet-5-5';

export const THINK_MODEL_CONFIG: AIModelConfig = {
	name: 'Claude Sonnet 5.5',
	size: ModelSize.LARGE,
	provider: 'anthropic',
	creditCost: 8, // $2.00 per million input tokens
	contextSize: 200_000,
};
