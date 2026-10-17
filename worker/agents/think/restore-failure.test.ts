import { describe, expect, it } from 'vitest';
import { restoreFailure } from './nova-edits';

describe('a restore that did not happen is never "done" (17 Oct, Dr. Martha)', () => {
	it('the old answer for a restore that made no version, and an {error}, are failures', () => {
		// What the old SpaceDO.rollbackToCommit could answer while nothing went back: a deploy result only.
		expect(restoreFailure({ ok: true, preview_url: '/space/x/preview/main/' })).toBe('the workspace did not say it restored anything');
		expect(restoreFailure({ error: 'Commit abc not found on branch "main"' })).toBe('Commit abc not found on branch "main"');
		expect(restoreFailure(undefined)).toBe('no answer from the workspace');
	});
	it('a real restore passes, even when only the preview rebuild failed', () => {
		expect(restoreFailure({ restored: 'af57190f', head: 'beef', changed: 47 })).toBeNull();
		expect(restoreFailure({ restored: 'af57190f', head: 'beef', changed: 47, error: 'deploy failed' })).toBeNull();
	});
});
