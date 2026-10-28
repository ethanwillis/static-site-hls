// Runs Scroll to regenerate a site's HTML from its .scroll sources.
import { spawn } from "node:child_process"
import { mkdtemp, rm, rmdir, stat, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { sitePath } from "./layout.js"

export const SCROLL_INSTALL = "npm install -g https://github.com/breck7/scroll/archive/refs/heads/main.tar.gz"

const isFile = (file) => stat(file).then((s) => s.isFile(), () => false)

/**
 * Run `scroll build` on some .scroll files of one folder of the site, preferring
 * a site-local scroll install (node_modules/.bin/scroll) over the one on PATH.
 *
 * Scroll splits file paths on spaces and then writes the HTML to the wrong
 * place, so a folder whose path contains whitespace is built through a symlink
 * in the temp folder.
 * @param {string} root site root
 * @param {string} folder root-relative folder ("." for the root)
 * @param {string[]} files .scroll file names in that folder
 * @param {(line: string) => void} log
 */
export async function scrollBuild(root, folder, files, log) {
  const local = path.join(root, "node_modules", ".bin", "scroll")
  const bin = (await isFile(local)) ? local : "scroll"
  const dir = sitePath(root, folder)
  log(`scroll build in ${folder === "." ? "site root" : folder}/`)
  const linkParent = /\s/.test(dir) ? await mkdtemp(path.join(tmpdir(), "static-site-hls-")) : null
  const buildDir = linkParent ? path.join(linkParent, "site") : dir
  try {
    if (linkParent) await symlink(dir, buildDir, "dir")
    await new Promise((resolve, reject) => {
      const child = spawn(bin, ["build", ...files.map((file) => path.join(buildDir, file))], { cwd: dir, stdio: ["ignore", "inherit", "inherit"] })
      child.on("error", (error) => reject(error.code === "ENOENT"
        ? new Error(`\`scroll\` not found; install it with \`${SCROLL_INSTALL}\`, or pass --no-build and build the site yourself`)
        : error))
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`scroll build in ${dir} exited with ${code}`))))
    })
  } finally {
    if (linkParent) {
      await rm(buildDir, { force: true }) // unlinks the symlink only; never recurses into the site
      await rmdir(linkParent)
    }
  }
}
