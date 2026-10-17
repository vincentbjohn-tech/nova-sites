import type { FileSystem } from "@cloudflare/shell"
import { readBlobBytes, walkTreeFiles } from "./git-objects"
import { globInfos } from "./fileinfo"

/**
 * Put the working tree back to exactly the files of `targetOid`, read straight from git's own
 * objects (the target commit's tree and its blobs, as raw bytes).
 *
 * Why not `git.checkout({ ref: <old commit> })` and then copy the working tree, as this used to:
 * @cloudflare/shell's checkout of an older commit returns without error and leaves every file as
 * it was (proved in test/restore.test.ts). The copy then held today's files, the commit was a
 * no-op, and Restore said "done" while nothing went back (17 Oct, Dr. Martha's site).
 *
 * `fs` is the git-backed filesystem (objects under /.git); `tree` lists the working files (after
 * the Artifacts base is materialized, the overlay). Returns how many files it changed.
 */
export async function restoreWorkingTree(
  fs: FileSystem,
  tree: FileSystem,
  targetOid: string,
  isReserved: (path: string) => boolean,
): Promise<{ changed: number; files: number }> {
  const target = await walkTreeFiles(fs, targetOid)
  let changed = 0
  for (const info of await globInfos(tree, "**/*")) {
    if (info.type !== "file" || isReserved(info.path)) continue
    if (!target.has(info.path)) {
      await fs.rm(info.path, { force: true })
      changed++
    }
  }
  for (const [path, entry] of target) {
    if (isReserved(path)) continue
    const bytes = await readBlobBytes(fs, entry.oid)
    const now = (await fs.exists(path)) ? await fs.readFileBytes(path) : null
    if (now && sameBytes(now, bytes)) continue
    await fs.writeFileBytes(path, bytes)
    changed++
  }
  return { changed, files: target.size }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
