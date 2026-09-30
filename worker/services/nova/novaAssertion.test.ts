import { describe, expect, it } from 'vitest';
import { signNovaAssertion, verifyNovaAssertion } from './novaAssertion';

const SECRET = 'n'.repeat(40);
const NOW = 1_800_000_000;
const owner = { email: 'VincentBJohn@gmail.com', name: 'Vincent John', novaUserId: 'u_1', exp: NOW + 120 };

describe('Nova OS sign-in assertion', () => {
	it('accepts a fresh assertion signed with the shared secret', async () => {
		const a = await signNovaAssertion(owner, SECRET);
		expect(await verifyNovaAssertion(a, SECRET, NOW)).toEqual({ ...owner, email: 'vincentbjohn@gmail.com' });
	});
	it('refuses another secret, a tampered payload, and a missing secret', async () => {
		const a = await signNovaAssertion(owner, SECRET);
		expect(await verifyNovaAssertion(a, 'x'.repeat(40), NOW)).toBeNull();
		const [body, sig] = a.split('.');
		const forged = btoa(JSON.stringify({ ...owner, email: 'someone@else.com' })).replace(/=+$/, '');
		expect(await verifyNovaAssertion(`${forged}.${sig}`, SECRET, NOW)).toBeNull();
		expect(await verifyNovaAssertion(`${body}.`, SECRET, NOW)).toBeNull();
		expect(await verifyNovaAssertion(a, undefined, NOW)).toBeNull();
		expect(await verifyNovaAssertion(a, 'short', NOW)).toBeNull();
	});
	it('refuses expired and too-long-lived assertions', async () => {
		expect(await verifyNovaAssertion(await signNovaAssertion({ ...owner, exp: NOW - 1 }, SECRET), SECRET, NOW)).toBeNull();
		expect(await verifyNovaAssertion(await signNovaAssertion({ ...owner, exp: NOW + 3600 }, SECRET), SECRET, NOW)).toBeNull();
	});
});
