#!/usr/bin/env node
// Dependency updates for static-site-hls.
//
//   npm run deps:check     list available updates; changes nothing
//   npm run deps:update    update everything, then run the tests
//
// Two kinds of dependencies:
// - npm packages in package.json. Exact pins stay exact: @wasmer/sdk is pre-1.0
//   and changes its API between minors, and hls.js is copied into every site as
//   hls.min.js, so its version should only move deliberately. Ranges (^) are
//   moved to the latest version, including across majors (flagged below).
// - the wasmer/ffmpeg WASIX package, pinned as FFMPEG_PACKAGE in src/convert.js
//   and downloaded from the Wasmer registry when a site is converted.
//
// After updating, test/convert.test.js converts real fixtures with the pinned
// wasmer/ffmpeg through the pinned @wasmer/sdk, so a broken pair fails here.
import { spawnSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import semver from "semver"

const ROOT = new URL("../", import.meta.url)
const CONVERT_JS = new URL("src/convert.js", ROOT)
const FFMPEG_PIN = /(FFMPEG_PACKAGE = "wasmer\/ffmpeg@=)([^"]+)(")/

const { values } = parseArgs({ options: { check: { type: "boolean" } } })

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" })
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed${capture ? `:\n${result.stderr}` : ""}`)
  return result.stdout
}

async function latestWasmerPackage(name) {
  const response = await fetch("https://registry.wasmer.io/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: `{ getPackage(name: ${JSON.stringify(name)}) { lastVersion { version } } }` }),
  })
  if (!response.ok) throw new Error(`Wasmer registry: HTTP ${response.status}`)
  const version = (await response.json()).data?.getPackage?.lastVersion?.version
  if (!version) throw new Error(`Wasmer registry has no ${name}`)
  return version
}

const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"))
const updates = []
for (const [field, dev] of [["dependencies", false], ["devDependencies", true]]) {
  for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
    const latest = run("npm", ["view", name, "version"], { capture: true }).trim()
    const exact = semver.valid(spec) !== null
    const current = exact ? spec : semver.minVersion(spec).version
    if (semver.gt(latest, current)) updates.push({ name, kind: dev ? "npm (dev)" : "npm", dev, exact, current: spec, latest, major: semver.major(latest) > semver.major(current) })
  }
}
const convertSource = await readFile(CONVERT_JS, "utf8")
const ffmpegPinned = convertSource.match(FFMPEG_PIN)?.[2]
if (!ffmpegPinned) throw new Error(`no FFMPEG_PACKAGE pin found in ${CONVERT_JS.pathname}`)
const ffmpegLatest = await latestWasmerPackage("wasmer/ffmpeg")
if (semver.gt(ffmpegLatest, ffmpegPinned)) {
  updates.push({ name: "wasmer/ffmpeg", kind: "wasmer", current: `=${ffmpegPinned}`, latest: ffmpegLatest, major: semver.major(ffmpegLatest) > semver.major(ffmpegPinned) })
}

if (!updates.length) {
  console.log("Everything is up to date.")
  process.exit(0)
}
console.log("Available updates:")
for (const u of updates) console.log(`  ${u.name.padEnd(16)} ${u.kind.padEnd(10)} ${u.current.padEnd(10)} → ${u.latest}${u.major ? "   MAJOR: read the changelog" : ""}`)
if (values.check) process.exit(0)

for (const u of updates.filter((u) => u.kind !== "wasmer")) {
  run("npm", ["install", `${u.name}@${u.latest}`, ...(u.dev ? ["--save-dev"] : []), ...(u.exact ? ["--save-exact"] : [])])
}
if (updates.some((u) => u.kind === "wasmer")) {
  await writeFile(CONVERT_JS, convertSource.replace(FFMPEG_PIN, `$1${ffmpegLatest}$3`))
  console.log(`src/convert.js: wasmer/ffmpeg pinned to =${ffmpegLatest}`)
}

console.log("\nRunning the tests against the updated dependencies…")
run("npm", ["test"])
console.log(`
Updated and tested. Before committing:
- review the diff (package.json, package-lock.json, src/convert.js);
- try it on a real site: npm run try -- scan <site> && npm run try -- <site>;
  a new hls.js changes every site's hls.min.js on its next convert.`)
