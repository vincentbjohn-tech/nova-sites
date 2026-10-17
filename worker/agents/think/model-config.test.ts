import { describe, expect, it } from 'vitest';
import { NOVA_PHASE_DEFAULT_MODEL, NOVA_PLAN_DEFAULT_MODEL } from '../nova-phasic/gateway';
import { THINK_MODEL_CONFIG, THINK_MODEL_ID } from './model-config';
import { NOVA_GATEWAY_DEFAULT_MODEL } from './nova-gateway';

// Vincent, 2026-10-17: "for everything AI use Claude, of course." Every model a Nova site is built
// with by default (the gateway's routes, the phased builder's plan and pages, and the think agent's
// fallback when the gateway isn't set) must be Claude. Fails the build if any default names another vendor.
describe('the builder uses Claude only by default', () => {
	it('the gateway, plan and page models are Claude routes', () => {
		for (const model of [NOVA_GATEWAY_DEFAULT_MODEL, NOVA_PHASE_DEFAULT_MODEL, NOVA_PLAN_DEFAULT_MODEL]) {
			expect(model).toMatch(/^cli:claude(-(sonnet|opus|haiku))?$/);
		}
	});

	it("the think agent's fallback model is Claude", () => {
		expect(THINK_MODEL_ID).toMatch(/^anthropic\/claude-/);
		expect(THINK_MODEL_CONFIG.provider).toBe('anthropic');
	});
});
