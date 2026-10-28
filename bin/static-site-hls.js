#!/usr/bin/env node
import { readFileSync } from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline/promises"
import { parseArgs } from "node:util"

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

const HELP = `static-site-hls ${pkg.version}
Convert the local videos used by a Scroll site (https://scroll.pub) to HLS with
WASIX ffmpeg (stream copy), point the .scroll sources at the HLS playlists, and
rebuild the HTML with \`scroll build\`.

Usage
  static-site-hls [convert] [site-root] [options]
  static-site-hls scan [site-root] [options]
  static-site-hls serve [site-root] [--port <n>]

Commands
  convert   Scan the .scroll files, convert new or changed videos, rewrite the
            sources, update the index, and run scroll build (default)
  scan      Print the page → video map and what convert would do; writes nothing
  serve     Serve the site on localhost with HLS content types, for testing

Arguments
  site-root  The Scroll site's root folder. Asked for interactively if
             omitted; required when not running in a terminal.

Options
  --data-dir <dir>    Folder inside the site that holds all static-site-hls data:
                      index.json, the player script, hls.min.js and the videos
                      folder. Default: static-site-hls
  --videos-dir <dir>  Folder, relative to --data-dir, that the HLS videos are
                      served from. Saved in the index; passing a new value moves
                      the existing videos and rewrites the sources.
                      Default: the saved value, else "videos"
  --no-posters        Don't make posters. By default each video gets a poster.jpg
                      of its first frame, shown until the first segment loads.
                      Saved in the index; --posters turns them back on.
                      Default: the saved value, else on
  --no-build          Don't run \`scroll build\` after rewriting sources
  -y, --yes           Don't ask for confirmation before converting
  -p, --port <n>      Port for serve. Default: 8080
  -h, --help          Show this help
  -v, --version       Show the version

Examples
  static-site-hls                                  interactive
  static-site-hls scan ./site
  static-site-hls ./site --yes
  static-site-hls ./site --videos-dir streams      serve from static-site-hls/streams/
  static-site-hls ./site --no-posters              remove posters, stop making them
  static-site-hls serve ./site                     http://localhost:8080/
`

const STATUS = {
  new: "convert (new)",
  changed: "convert (source changed)",
  rebuild: "convert (HLS output or poster missing)",
  unchanged: "up to date",
  missing: "source file missing; keeping existing HLS",
}

const [major] = process.versions.node.split(".").map(Number)
if (major < 24) {
  console.error(`static-site-hls needs Node.js 24 or newer (this is ${process.version}): the Wasmer registry serves packages zstd-encoded, which older Node fetch can't decode.`)
  process.exit(1)
}

let rl
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: {
      "data-dir": { type: "string" },
      "videos-dir": { type: "string" },
      posters: { type: "boolean" },
      build: { type: "boolean", default: true },
      yes: { type: "boolean", short: "y" },
      port: { type: "string", short: "p" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  })
  if (values.help) {
    process.stdout.write(HELP)
    process.exit(0)
  }
  if (values.version) {
    console.log(pkg.version)
    process.exit(0)
  }

  const command = ["scan", "convert", "serve"].includes(positionals[0]) ? positionals.shift() : "convert"
  if (positionals.length > 1) throw new Error(`unexpected arguments: ${positionals.slice(1).join(" ")} (see --help)`)
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  if (interactive) rl = createInterface({ input: process.stdin, output: process.stdout })

  let root = positionals[0]
  if (!root) {
    if (!interactive) throw new Error("site-root is required when not running in a terminal (see --help)")
    root = (await rl.question("Scroll site root folder (.): ")).trim() || "."
  }

  if (command === "serve") await runServe(root, values)
  else await runScanOrConvert(command, root, values, interactive)
} catch (error) {
  console.error(`static-site-hls: ${error.message}`)
  process.exitCode = 1
} finally {
  rl?.close()
}

async function runServe(root, values) {
  const port = values.port === undefined ? 8080 : Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be a port number, got "${values.port}"`)
  const { serve } = await import("../src/serve.js")
  const server = await serve(root, { port })
  // The listening server keeps the process running until Ctrl+C.
  console.log(`Serving ${path.resolve(root)} at http://localhost:${server.address().port}/  (Ctrl+C to stop)`)
}

async function runScanOrConvert(command, root, values, interactive) {
  const { scan, apply, CURRENT_INDEX_VERSION } = await import("../src/index.js")
  const plan = await scan(root, { dataDir: values["data-dir"], videosDir: values["videos-dir"], posters: values.posters })

  console.log(`\nSite:   ${plan.root}`)
  console.log(`Data:   ${plan.dataDir}/   videos served from ${plan.videosRoot}/   posters ${plan.posters ? "on" : "off"}`)
  const indexState = !plan.indexExists ? "new"
    : plan.indexMigratedFrom !== null ? `version ${plan.indexMigratedFrom}; convert upgrades it to version ${CURRENT_INDEX_VERSION}`
    : `version ${CURRENT_INDEX_VERSION}`
  console.log(`Index:  ${plan.indexPath} (${indexState})`)
  if (plan.previousVideosRoot !== plan.videosRoot && plan.orphans.length + plan.videos.length) {
    console.log(`Move:   ${plan.previousVideosRoot}/ → ${plan.videosRoot}/`)
  }
  const byPage = plan.pages.filter((page) => page.refs.length)
  if (!byPage.length) console.log("\nNo .scroll file references a local video.")
  const videos = new Map(plan.videos.map((video) => [video.source, video]))
  for (const { page, refs } of byPage) {
    console.log(`\n${page}`)
    for (const source of new Set(refs.map((ref) => ref.source))) {
      const video = videos.get(source)
      if (video.status === "unsupported") console.log(`  ${source}  [not convertible: ${plan.index.videos[source].reason}]`)
      else console.log(`  ${source} → ${video.playlist}  [${STATUS[video.status]}]`)
    }
  }
  for (const source of plan.orphans) console.log(`\n${source}: no page uses it any more; its HLS output will be removed`)

  const toConvert = plan.videos.filter((video) => ["new", "changed", "rebuild"].includes(video.status)).length
  console.log(`\n${plan.videos.length} video(s) on ${byPage.length} page(s); ${toConvert} to convert`)

  if (command !== "convert" || !(byPage.length || plan.orphans.length || plan.pages.some((page) => page.players.length))) return
  const answer = values.yes || !interactive ? "y" : (await rl.question("Convert videos and update sources? (Y/n) ")).trim().toLowerCase()
  if (answer && answer !== "y" && answer !== "yes") return console.log("Nothing changed.")
  console.log()
  const result = await apply(plan, { build: values.build })
  console.log(`\nDone: ${result.converted.length} converted, ${result.unsupported.length} not convertible, ${result.failed.length} failed, ${result.removed.length} removed, ${result.pages.length} source(s) updated.`)
  if (result.failed.length) process.exitCode = 1
}
