import { describe, expect, it } from 'vitest';
import { pathOf, serialByFile } from './serial-file-tools';

function fakeEditTool(files: Map<string, string>) {
	return {
		description: 'edit',
		execute: async (input: unknown) => {
			const { path, append } = input as { path: string; append: string };
			const before = files.get(path) ?? '';
			await new Promise((r) => setTimeout(r, 5)); // the read → write gap where edits used to race
			files.set(path, before + append);
			return { path, replaced: true };
		},
	};
}

describe('serialByFile', () => {
	it('parallel edits to one file all land (none erases another)', async () => {
		const files = new Map([['/public/index.html', '<h1>Hi</h1>']]);
		const edit = serialByFile(fakeEditTool(files), new Map());
		await Promise.all(['A', 'B', 'C'].map((x) => edit.execute!({ path: '/public/index.html', append: x }, {})));
		expect(files.get('/public/index.html')).toBe('<h1>Hi</h1>ABC');
	});

	it('without it, the same edits lose work (the bug)', async () => {
		const files = new Map([['/public/index.html', '<h1>Hi</h1>']]);
		const edit = fakeEditTool(files);
		await Promise.all(['A', 'B', 'C'].map((x) => edit.execute({ path: '/public/index.html', append: x })));
		expect(files.get('/public/index.html')).not.toBe('<h1>Hi</h1>ABC');
	});

	it('different files still run together, and one failing edit does not block the next', async () => {
		const files = new Map<string, string>();
		const queues = new Map<string, Promise<unknown>>();
		let calls = 0;
		const flaky = serialByFile(
			{
				execute: async (input: unknown) => {
					calls++;
					if (calls === 1) throw new Error('first fails');
					const { append } = input as { path: string; append: string };
					const path = pathOf(input)!;
					files.set(path, (files.get(path) ?? '') + append);
				},
			},
			queues,
		);
		const first = flaky.execute!({ path: 'a.css', append: 'x' }, {});
		await expect(first).rejects.toThrow('first fails');
		await flaky.execute!({ path: './a.css', append: 'y' }, {});
		await flaky.execute!({ path: '/b.css', append: 'z' }, {});
		expect(files.get('/a.css')).toBe('y');
		expect(files.get('/b.css')).toBe('z');
	});

	it('normalises paths so "./x", "x" and "/x" share one queue', () => {
		expect(pathOf({ path: './public//x.html' })).toBe('/public/x.html');
		expect(pathOf({ file_path: 'public/x.html' })).toBe('/public/x.html');
		expect(pathOf({})).toBeNull();
	});
});
