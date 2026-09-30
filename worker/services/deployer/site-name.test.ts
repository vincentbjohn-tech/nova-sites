import { describe, expect, it } from 'vitest';
import { resolveSiteScriptName } from './think-user-deploy';

describe('site address name', () => {
	const none = async () => null;
	it('keeps the address a site already has', async () => {
		expect(await resolveSiteScriptName({ appId: 'a', existing: 'kristi-grace', title: 'Other', ownerOf: none })).toBe('kristi-grace');
	});
	it('makes the title address-safe', async () => {
		expect(await resolveSiteScriptName({ appId: 'a', existing: null, title: 'Kristi Grace Hair!', ownerOf: none })).toBe('kristi-grace-hair');
	});
	it('numbers a name another app holds, and never takes a reserved one', async () => {
		const held = async (n: string) => (n === 'salon' ? { id: 'other' } : null);
		expect(await resolveSiteScriptName({ appId: 'a', existing: null, title: 'Salon', ownerOf: held })).toBe('salon-2');
		expect(await resolveSiteScriptName({ appId: 'a', existing: null, title: 'Builder', ownerOf: none })).toBe('builder-2');
	});
	it('reuses a name this same app already holds', async () => {
		const mine = async () => ({ id: 'a' });
		expect(await resolveSiteScriptName({ appId: 'a', existing: null, title: 'Salon', ownerOf: mine })).toBe('salon');
	});
});
