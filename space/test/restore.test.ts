/**
 * Restore (History → go back) must put the old version's files back (17 Oct: Dr. Martha's
 * restore answered "done", committed nothing, and her draft kept the wrong stylesheet).
 */
import { describe, it, expect } from "vitest"
import { InMemoryFs } from "@cloudflare/shell"
import { createGit } from "@cloudflare/shell/git"
import { restoreWorkingTree } from "../src/space/restore"

const AUTHOR = { name: "Test", email: "test@vibesdk.local" }
const reserved = (p: string) => p === "/.git" || p.startsWith("/.git/") || p === "/.afs" || p.startsWith("/.afs/")

async function twoVersions() {
  const fs = new InMemoryFs()
  const git = createGit(fs)
  await git.init({ defaultBranch: "main" })
  await fs.writeFile("/public/assets/theme.css", ":root{--pink:#F42BA2}")
  await fs.writeFile("/public/index.html", "<nav>Media</nav>")
  await fs.writeFileBytes("/public/logo.png", new Uint8Array([0x89, 0x50, 0xff, 0x00, 0xfe]))
  await git.add({ filepath: "." })
  const good = (await git.commit({ message: "good", author: AUTHOR })).oid
  // (a different length: the in-memory test fs keeps no fine mtimes, so git add would skip a same-size change)
  await fs.writeFile("/public/assets/theme.css", ":root{--pink:#C96A7C;--ink:#2b2420}")
  await fs.writeFile("/public/index.html", "<nav>More</nav>")
  await fs.writeFile("/public/extra.html", "<h1>added later</h1>")
  await git.add({ filepath: "." })
  await git.commit({ message: "bad", author: AUTHOR })
  return { fs, git, good }
}

describe("restoreWorkingTree", () => {
  it("puts back the old version's files, byte for byte, and removes files added after it", async () => {
    const { fs, git, good } = await twoVersions()
    const done = await restoreWorkingTree(fs, fs, good, reserved)
    expect(await fs.readFile("/public/assets/theme.css")).toBe(":root{--pink:#F42BA2}")
    expect(await fs.readFile("/public/index.html")).toBe("<nav>Media</nav>")
    expect([...(await fs.readFileBytes("/public/logo.png"))]).toEqual([0x89, 0x50, 0xff, 0x00, 0xfe])
    expect(await fs.exists("/public/extra.html")).toBe(false)
    expect(done.changed).toBe(3)
    // …and committing it really makes a new version with the old look.
    await git.add({ filepath: "." })
    const { oid } = await git.commit({ message: "rollback", author: AUTHOR })
    expect(oid).toBeTruthy()
  })
});

describe("restoreWorkingTree on a version equal to now", () => {
  it("changes nothing and says so (changed: 0), so the caller can refuse instead of claiming a restore", async () => {
    const { fs, git } = await twoVersions()
    const head = (await git.log({ depth: 1 }))[0]!.oid
    const done = await restoreWorkingTree(fs, fs, head, reserved)
    expect(done.changed).toBe(0)
  })
})

describe("restoreWorkingTree after a workspace reset (Artifacts filesystem, no git index)", () => {
  it("still puts the old files back; checkout of the old commit refuses there", async () => {
    const { ArtifactsFileSystem } = await import("../src/space/artifacts-fs")
    const { createArtifactsBaseSource } = await import("../src/space/git-objects")
    const { globInfos } = await import("../src/space/fileinfo")
    const { fs: before, good } = await twoVersions()
    // A reset: a fresh overlay holding only git's objects and refs (no index, no working files).
    const overlay = new InMemoryFs()
    for (const i of await globInfos(before, "**/*")) {
      if (i.type === "file" && i.path.startsWith("/.git/") && i.path !== "/.git/index") await overlay.writeFileBytes(i.path, await before.readFileBytes(i.path))
    }
    const fs = new ArtifactsFileSystem(overlay, {
      source: createArtifactsBaseSource({ overlay, branch: "main", hasRemote: async () => true, fetchBranch: async () => true }),
      branch: "main",
    })
    await fs.ready()
    await fs.whenFullyMaterialized()
    await expect(createGit(fs).checkout({ ref: good })).rejects.toThrow(/overwritten by checkout/)
    const done = await restoreWorkingTree(fs, overlay, good, reserved)
    expect(done.changed).toBe(3)
    expect(await fs.readFile("/public/assets/theme.css")).toBe(":root{--pink:#F42BA2}")
    expect(await fs.exists("/public/extra.html")).toBe(false)
  })
})
