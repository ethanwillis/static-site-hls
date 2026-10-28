// Site layout: where static-site-hls keeps its data inside a site and what the
// files there are called. See docs/data-model.md for the folder structure.
import path from "node:path"
import { PLAYLIST, POSTER } from "./convert.js"

export { PLAYLIST, POSTER }
export const DEFAULT_DATA_DIR = "static-site-hls"
export const DEFAULT_VIDEOS_DIR = "videos"
export const INDEX_FILE = "index.json"
/**
 * The player script. Pages include it as `inlineJs <data-dir>/static-site-hls.js`;
 * later runs find that line by this file name to update or remove it.
 */
export const PLAYER_FILE = "static-site-hls.js"
export const HLS_JS_FILE = "hls.min.js"
export const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv", ".ogv", ".avi"])
export const HLS_MIME = "application/vnd.apple.mpegurl"

/**
 * Normalize a folder option to a POSIX path relative to the site, or throw.
 * @param {string} value
 * @param {string} flag option name for the error message
 */
export function siteFolder(value, flag) {
  const normalized = path.posix.normalize(String(value).replaceAll("\\", "/")).replace(/\/+$/, "")
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new Error(`${flag} must be a relative folder inside the site, got "${value}"`)
  }
  return normalized
}

/** Absolute filesystem path of `rel`, a POSIX path relative to the site root. */
export const sitePath = (root, rel) => path.join(root, ...rel.split("/"))
