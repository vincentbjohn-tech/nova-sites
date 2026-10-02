/**
 * Nova Sites: file-changing tools (write, edit, delete) run one at a time per file.
 *
 * The model often sends several edits to the same file in one step, and the tools ran them in
 * parallel: each read the file as it was, changed it, and wrote it back, so the last write erased
 * the others (2 Oct: index.html went 168 → 193 → 167 lines; each edit had reported "replaced").
 * Edits to different files still run together.
 */
type Execute = (input: unknown, options: unknown) => unknown;

export function pathOf(input: unknown): string | null {
	if (!input || typeof input !== 'object') return null;
	const raw = (input as Record<string, unknown>).path ?? (input as Record<string, unknown>).file_path;
	if (typeof raw !== 'string' || !raw) return null;
	return `/${raw.replace(/^\.?\/+/, '').replace(/\/+/g, '/')}`;
}

export function serialByFile<T>(tool: T, queues: Map<string, Promise<unknown>>): T {
	const execute = (tool as { execute?: Execute }).execute;
	if (typeof execute !== 'function') return tool;
	return {
		...(tool as object),
		execute: (input: unknown, options: unknown) => {
			const key = pathOf(input);
			if (!key) return execute(input, options);
			const before = queues.get(key) ?? Promise.resolve();
			const run = before.catch(() => undefined).then(() => execute(input, options));
			const settled = run.catch(() => undefined);
			queues.set(key, settled);
			void settled.then(() => {
				if (queues.get(key) === settled) queues.delete(key);
			});
			return run;
		},
	} as T;
}
