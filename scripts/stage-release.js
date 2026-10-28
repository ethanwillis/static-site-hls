#!/usr/bin/env node
// Stage a new version of @lessconversation/static-site-hls on npm. Staging needs
// no 2FA; the version only goes live once a maintainer approves it with 2FA
// (`npm stage approve <stage-id>` or the "Staged Packages" tab on npmjs.com).
// See https://docs.npmjs.com/staged-publishing.
//
//   npm run release:stage -- patch|minor|major [--dry-run]
//   npm run release:stage -- prepatch|preminor|premajor|prerelease [--preid beta] [--tag next] [--dry-run]
//   npm run release:stage -- 1.2.3 [--tag latest]
//
// Steps: check the git tree is clean and npm can stage → run the tests → bump
// the version in package.json and package-lock.json → `npm stage publish` →
// commit "release: v<version>" and tag v<version>. If staging fails, the version
// bump is undone. --dry-run runs the checks, tests and `npm pack --dry-run` and
// changes nothing.
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import semver from "semver"

const ROOT = new URL("../", import.meta.url)
const MIN_NPM = "11.15.0" // first npm with `npm stage`
const BUMPS = ["patch", "minor", "major", "prepatch", "preminor", "premajor", "prerelease"]

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tag: { type: "string" },
    preid: { type: "string", default: "beta" },
    "dry-run": { type: "boolean" },
  },
})
const dryRun = Boolean(values["dry-run"])

function run(command, args, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" })
  if (result.status !== 0 && !allowFailure) throw new Error(`${command} ${args.join(" ")} failed${capture ? `:\n${result.stderr.trim()}` : ""}`)
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() }
}
const step = (text) => console.log(`\n▸ ${text}`)

try {
  const [bump] = positionals
  if (!bump || positionals.length > 1) throw new Error(`usage: npm run release:stage -- <${BUMPS.join("|")}|x.y.z> [--preid beta] [--tag <dist-tag>] [--dry-run]`)
  const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"))
  const version = BUMPS.includes(bump) ? semver.inc(pkg.version, bump, values.preid) : semver.valid(bump)
  if (!version) throw new Error(`"${bump}" is neither a bump (${BUMPS.join(", ")}) nor a version`)
  if (!semver.gt(version, pkg.version)) throw new Error(`${version} is not newer than the current ${pkg.version}`)
  // npm requires an explicit dist-tag for prereleases; never let one become `latest` by accident.
  const tag = values.tag ?? (semver.prerelease(version) ? "next" : "latest")
  if (semver.prerelease(version) && tag === "latest") throw new Error(`refusing to tag prerelease ${version} as latest`)
  console.log(`${pkg.name}: ${pkg.version} → ${version} (dist-tag ${tag})${dryRun ? "  [dry run]" : ""}`)

  step("Checking prerequisites")
  const npmVersion = run("npm", ["--version"], { capture: true }).stdout
  if (semver.lt(npmVersion, MIN_NPM)) throw new Error(`npm ${npmVersion} can't stage packages; npm ${MIN_NPM} or newer is needed (npm install -g npm@latest)`)
  if (!run("git", ["rev-parse", "HEAD"], { capture: true, allowFailure: true }).ok) throw new Error("the repository has no commits yet; commit the package first")
  const dirty = run("git", ["status", "--porcelain"], { capture: true }).stdout
  if (dirty) throw new Error(`the git working tree has uncommitted changes; commit or stash them first:\n${dirty}`)
  if (run("git", ["rev-parse", "-q", "--verify", `refs/tags/v${version}`], { capture: true, allowFailure: true }).ok) throw new Error(`git tag v${version} already exists`)
  const published = run("npm", ["view", `${pkg.name}@${version}`, "version"], { capture: true, allowFailure: true })
  if (published.ok && published.stdout) throw new Error(`${pkg.name}@${version} is already on npm`)
  const user = run("npm", ["whoami"], { capture: true, allowFailure: true })
  if (!user.ok && !dryRun) throw new Error("not logged in to npm; run `npm login` first")
  console.log(`npm ${npmVersion}, ${user.ok ? `logged in as ${user.stdout}` : "not logged in (needed to stage)"}, git tree clean`)

  step("Running the tests")
  run("npm", ["test"])

  if (dryRun) {
    step("Package contents (npm pack --dry-run)")
    run("npm", ["pack", "--dry-run"])
    console.log(`\nDry run: nothing changed. Without --dry-run this would bump to ${version}, run \`npm stage publish --tag ${tag}\`, then commit and tag v${version}.`)
    process.exit(0)
  }

  step(`Bumping the version to ${version}`)
  run("npm", ["version", version, "--no-git-tag-version"])

  step("Staging on npm (no 2FA needed)")
  const staged = run("npm", ["stage", "publish", "--tag", tag], { allowFailure: true })
  if (!staged.ok) {
    run("git", ["checkout", "--", "package.json", "package-lock.json"])
    throw new Error("npm stage publish failed; the version bump was undone")
  }

  step(`Committing and tagging v${version}`)
  run("git", ["commit", "-q", "-m", `release: v${version}`, "--", "package.json", "package-lock.json"])
  run("git", ["tag", "-a", `v${version}`, "-m", `v${version}`])

  step("Staged versions of this package")
  run("npm", ["stage", "list", pkg.name], { allowFailure: true })

  console.log(`
${pkg.name}@${version} is staged, not yet public. To publish it, approve it with 2FA:
  npm stage approve <stage-id>        (stage id from the list above)
or open npmjs.com → ${pkg.name} → Staged Packages → Approve.

Inspect it first if you like:  npm stage view <stage-id>  /  npm stage download <stage-id>
After approving:               git push --follow-tags
To abandon it instead:         npm stage reject <stage-id>   then   git tag -d v${version} && git reset --soft HEAD~1`)
} catch (error) {
  console.error(`\nrelease:stage: ${error.message}`)
  process.exitCode = 1
}
