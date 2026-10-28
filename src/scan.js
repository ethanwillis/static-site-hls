// scan(): the read-only planning step. Reads the index (migrating it in memory),
// finds every video reference in the site's .scroll files, hashes the sources,
// and decides what convert has to do. Writes nothing.
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { readIndex } from "./index-store.js"
import { DEFAULT_DATA_DIR, INDEX_FILE, PLAYLIST, POSTER, siteFolder, sitePath, VIDEO_EXTENSIONS } from "./layout.js"
import { analyzeScroll, findScrollFiles, resolveUrl } from "./scroll.js"

/**
 * Status of a video in a plan:
 * - `new`: never converted
 * - `changed`: the source's content changed since it was converted
 * - `rebuild`: HLS output or (with posters on) poster missing
 * - `unchanged`: nothing to do
 * - `unsupported`: can't be stream-copied; pages keep the original file
 * - `missing`: the source file is gone; existing HLS output is kept
 * @typedef {"new" | "changed" | "rebuild" | "unchanged" | "unsupported" | "missing"} VideoStatus
 */
/**
 * One source video used by the site.
 * @typedef {object} VideoPlan
 * @property {string} source path relative to the site root
 * @property {string[]} pages .scroll files that use it
 * @property {string} id output folder, relative to the videos folder
 * @property {string} playlist root-relative path of its index.m3u8
 * @property {string | null} sha256 null when the source is missing
 * @property {VideoStatus} status
 */
/**
 * One .scroll file: its lines and the references that resolve to local videos.
 * @typedef {object} PageScan
 * @property {string} page path relative to the site root
 * @property {string[]} lines
 * @property {(import("./scroll.js").VideoRef & { source: string, current: string, absolute: boolean })[]} refs
 *   `source`: the video it stands for; `current`: the path it points at now
 *   (the source, or its playlist if already rewritten); `absolute`: written root-absolute
 * @property {import("./scroll.js").PlayerLine[]} players
 */
/**
 * Everything apply() needs, as decided by scan().
 * @typedef {object} ScanPlan
 * @property {string} root absolute site root
 * @property {string} dataDir
 * @property {string} videosDir the videos folder to use (may differ from the saved one)
 * @property {string} videosRoot dataDir/videosDir
 * @property {string} previousVideosRoot dataDir/<videosDir saved in the index>
 * @property {boolean} posters
 * @property {string} indexPath root-relative path of index.json
 * @property {import("./index-store.js").Index} index migrated to the current version
 * @property {number | null} indexMigratedFrom version read from disk if it was older
 * @property {boolean} indexExists
 * @property {PageScan[]} pages every .scroll file
 * @property {VideoPlan[]} videos every local video the pages use
 * @property {string[]} orphans indexed sources no page uses any more
 */

const isFile = (file) => stat(file).then((s) => s.isFile(), () => false)

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    createReadStream(file).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")))
  })
}

/** Output folder for a new source: its path without extension, made unique. */
function uniqueId(source, taken) {
  const ext = path.posix.extname(source)
  const base = source.slice(0, -ext.length || undefined)
  let id = taken.has(base) ? `${base}-${ext.slice(1)}` : base
  for (let n = 2; taken.has(id); n++) id = `${base}-${ext.slice(1)}-${n}`
  return id
}

/**
 * @param {string} root site root folder
 * @param {{ dataDir?: string, videosDir?: string, posters?: boolean }} [options]
 *   `videosDir` and `posters` default to the index settings
 * @returns {Promise<ScanPlan>}
 */
export async function scan(root, { dataDir = DEFAULT_DATA_DIR, videosDir, posters } = {}) {
  root = path.resolve(root)
  if (!(await stat(root).catch(() => null))?.isDirectory()) throw new Error(`${root} is not a folder`)
  dataDir = siteFolder(dataDir, "--data-dir")
  const abs = (rel) => sitePath(root, rel)
  const indexPath = path.posix.join(dataDir, INDEX_FILE)
  const { index, migratedFrom, exists } = await readIndex(abs(indexPath))
  const previousVideosRoot = path.posix.join(dataDir, index.settings.videosDir)
  videosDir = siteFolder(videosDir ?? index.settings.videosDir, "--videos-dir")
  const videosRoot = path.posix.join(dataDir, videosDir)
  posters ??= index.settings.posters

  // Pages already rewritten point at playlists; map those back to their sources.
  const bySourcePlaylist = new Map(Object.entries(index.videos).map(([source, entry]) => [path.posix.join(previousVideosRoot, entry.id, PLAYLIST), source]))
  const fileCache = new Map()
  const isVideoFile = async (rel) => {
    if (!VIDEO_EXTENSIONS.has(path.posix.extname(rel).toLowerCase())) return false
    if (!fileCache.has(rel)) fileCache.set(rel, await isFile(abs(rel)))
    return fileCache.get(rel)
  }

  /** @type {PageScan[]} */
  const pages = []
  /** @type {Map<string, VideoPlan>} */
  const videos = new Map()
  for (const page of await findScrollFiles(root, [dataDir])) {
    const { lines, refs, players } = analyzeScroll(await readFile(abs(page), "utf8"))
    const found = []
    for (const ref of refs) {
      const resolved = resolveUrl(ref.url, page)
      if (!resolved) continue
      const source = bySourcePlaylist.get(resolved.path) ?? ((await isVideoFile(resolved.path)) ? resolved.path : null)
      if (!source) continue
      found.push({ ...ref, source, current: resolved.path, absolute: resolved.absolute })
      if (!videos.has(source)) videos.set(source, { source, pages: [] })
      if (!videos.get(source).pages.includes(page)) videos.get(source).pages.push(page)
    }
    pages.push({ page, lines, refs: found, players })
  }
  if (!pages.length) throw new Error(`no .scroll files in ${root}; static-site-hls works on Scroll sites (https://scroll.pub)`)

  const taken = new Set(Object.values(index.videos).map((entry) => entry.id))
  for (const video of videos.values()) {
    const entry = index.videos[video.source]
    video.id = entry?.id ?? uniqueId(video.source, taken)
    taken.add(video.id)
    video.playlist = path.posix.join(videosRoot, video.id, PLAYLIST)
    video.sha256 = (await isFile(abs(video.source))) ? await sha256(abs(video.source)) : null
    const output = (name) => abs(path.posix.join(previousVideosRoot, video.id, name))
    if (!video.sha256) video.status = "missing"
    else if (!entry) video.status = "new"
    else if (entry.sha256 !== video.sha256) video.status = "changed"
    else if (entry.status === "unsupported") video.status = "unsupported"
    else if (!(await isFile(output(PLAYLIST)))) video.status = "rebuild"
    else if (posters && !(await isFile(output(POSTER)))) video.status = "rebuild"
    else video.status = "unchanged"
  }

  return {
    root,
    dataDir,
    videosDir,
    videosRoot,
    previousVideosRoot,
    posters,
    indexPath,
    index,
    indexMigratedFrom: migratedFrom,
    indexExists: exists,
    pages,
    videos: [...videos.values()],
    orphans: Object.keys(index.videos).filter((source) => !videos.has(source)),
  }
}
