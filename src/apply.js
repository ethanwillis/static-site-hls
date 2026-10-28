// apply(): carries out a ScanPlan. Steps, in order:
// 1. moveVideosFolder   --videos-dir changed: move existing output
// 2. installPlayer      write the player (with its config) and hls.min.js
// 3. convertVideos      WASIX ffmpeg for new/changed/rebuild videos
// 4. removePosters      --no-posters: delete existing posters
// 5. removeOrphans      delete output of videos no page uses any more
// 6. rewriteSources     point .scroll files at playlists, keep one player line
// 7. writeIndex         validate and save the index (current version)
// 8. build              scroll build, if a source or the player changed
// The index is also saved after each converted video, so an interrupted run
// keeps the work it finished.
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { Wasmer } from "@wasmer/sdk/node"
import { openConverter } from "./convert.js"
import { CURRENT_INDEX_VERSION, writeIndex } from "./index-store.js"
import { PLAYER_FILE, POSTER, sitePath } from "./layout.js"
import { installPlayer } from "./player-install.js"
import { pageEdits } from "./rewrite.js"
import { applyEdits } from "./scroll.js"
import { scrollBuild } from "./scroll-build.js"

/** Where @wasmer/sdk caches the wasmer/ffmpeg package (about 40 MB). */
export const WASMER_CACHE_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache"), "static-site-hls")
const CONVERT_STATUSES = new Set(["new", "changed", "rebuild"])

/**
 * What apply() did, as source paths (videos) and .scroll paths (pages).
 * @typedef {object} ApplyResult
 * @property {string[]} converted
 * @property {string[]} unsupported
 * @property {string[]} failed conversion errors; the rest of the run continues
 * @property {string[]} removed orphaned videos whose output was deleted
 * @property {string[]} pages .scroll files that were rewritten
 * @property {number | null} indexMigratedFrom index version upgraded from, if any
 */

const exists = (file) => stat(file).then(() => true, () => false)

/**
 * @param {import("./scan.js").ScanPlan} plan from scan()
 * @param {{ log?: (line: string) => void, build?: boolean }} [options]
 * @returns {Promise<ApplyResult>}
 */
export async function apply(plan, { log = console.log, build = true } = {}) {
  const { root, index, dataDir, videosRoot } = plan
  const abs = (rel) => sitePath(root, rel)
  const save = () => writeIndex(abs(plan.indexPath), index)
  /** @type {ApplyResult} */
  const result = { converted: [], unsupported: [], failed: [], removed: [], pages: [], indexMigratedFrom: plan.indexMigratedFrom }

  await mkdir(abs(dataDir), { recursive: true })
  await moveVideosFolder(plan, abs, log)
  index.settings.videosDir = plan.videosDir
  index.settings.posters = plan.posters
  await save()
  if (plan.indexMigratedFrom !== null) log(`upgraded ${plan.indexPath} from version ${plan.indexMigratedFrom} to ${CURRENT_INDEX_VERSION}`)

  const { playerChanged } = await installPlayer(root, { dataDir, videosDir: plan.videosDir, posters: plan.posters })
  await convertVideos(plan, abs, save, result, log)
  if (!plan.posters) await removePosters(index, videosRoot, abs, log)
  await removeOrphans(plan, abs, result, log)
  await rewriteSources(plan, abs, result, log)
  await save()

  // Built pages hold a copy of the inlined player, so a changed player needs a rebuild too.
  if (build && (result.pages.length || (playerChanged && Object.keys(index.pages).length))) {
    const folders = Map.groupBy(plan.pages.map(({ page }) => page), (page) => path.posix.dirname(page))
    for (const [folder, pages] of folders) await scrollBuild(root, folder, pages.map((page) => path.posix.basename(page)), log)
  }
  return result
}

async function moveVideosFolder({ previousVideosRoot, videosRoot }, abs, log) {
  if (previousVideosRoot === videosRoot || !(await exists(abs(previousVideosRoot)))) return
  if (await exists(abs(videosRoot))) throw new Error(`can't move ${previousVideosRoot}/ to ${videosRoot}/: it already exists`)
  await mkdir(path.dirname(abs(videosRoot)), { recursive: true })
  await rename(abs(previousVideosRoot), abs(videosRoot))
  log(`moved ${previousVideosRoot}/ → ${videosRoot}/`)
}

async function convertVideos(plan, abs, save, result, log) {
  const todo = plan.videos.filter((video) => CONVERT_STATUSES.has(video.status))
  if (!todo.length) return
  log(`loading WASIX ffmpeg (package cache: ${WASMER_CACHE_DIR})`)
  const wasmer = new Wasmer({ cache: { directory: WASMER_CACHE_DIR } })
  try {
    const converter = await openConverter(wasmer)
    try {
      for (const video of todo) {
        const outDir = abs(path.posix.join(plan.videosRoot, video.id))
        log(`${video.source}: converting (${video.status})`)
        let converted
        try {
          converted = await converter.convert(await readFile(abs(video.source)), path.extname(video.source), { poster: plan.posters })
        } catch (error) {
          log(`${video.source}: failed: ${error.message}`)
          result.failed.push(video.source)
          continue
        }
        await rm(outDir, { recursive: true, force: true })
        if ("unsupported" in converted) {
          plan.index.videos[video.source] = { status: "unsupported", id: video.id, sha256: video.sha256, reason: converted.unsupported }
          log(`${video.source}: skipped: ${converted.unsupported}`)
          result.unsupported.push(video.source)
        } else {
          await mkdir(outDir, { recursive: true })
          for (const file of converted.files) await writeFile(path.join(outDir, file.name), file.bytes)
          plan.index.videos[video.source] = {
            status: "converted",
            id: video.id,
            sha256: video.sha256,
            convertedAt: new Date().toISOString(),
            hls: {
              segments: converted.segments,
              ...(converted.duration !== undefined && { duration: converted.duration }),
              codecs: converted.codecs,
            },
            ...(converted.poster && { poster: POSTER }),
          }
          log(`${video.source}: ${converted.segments} segment${converted.segments === 1 ? "" : "s"}${converted.poster ? " + poster" : ""} → ${video.playlist}`)
          result.converted.push(video.source)
        }
        await save()
      }
    } finally {
      await converter.close()
    }
  } finally {
    await wasmer.close()
  }
}

async function removePosters(index, videosRoot, abs, log) {
  for (const [source, entry] of Object.entries(index.videos)) {
    if (entry.status !== "converted" || !entry.poster) continue
    await rm(abs(path.posix.join(videosRoot, entry.id, entry.poster)), { force: true })
    delete entry.poster
    log(`${source}: removed its poster`)
  }
}

async function removeOrphans(plan, abs, result, log) {
  for (const source of plan.orphans) {
    await rm(abs(path.posix.join(plan.videosRoot, plan.index.videos[source].id)), { recursive: true, force: true })
    delete plan.index.videos[source]
    log(`${source}: no page uses it any more; removed its HLS output`)
    result.removed.push(source)
  }
}

async function rewriteSources(plan, abs, result, log) {
  const playlists = new Map(plan.videos.map((video) => [video.source, video.playlist]))
  const playerPath = path.posix.join(plan.dataDir, PLAYER_FILE)
  plan.index.pages = {}
  for (const page of plan.pages) {
    const { edits, sources } = pageEdits(page, { index: plan.index, playlists, playerPath })
    if (edits.length) {
      await writeFile(abs(page.page), applyEdits(page.lines, edits))
      log(`${page.page}: updated`)
      result.pages.push(page.page)
    }
    if (sources.length) plan.index.pages[page.page] = sources
  }
}
