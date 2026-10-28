// Source rewriting: work out the edits that point a .scroll file's video
// references at the HLS playlists (or back at the originals) and keep exactly
// one player line on pages that play HLS. Pure: no file access.
import path from "node:path"
import { HLS_MIME } from "./layout.js"
import { urlFor } from "./scroll.js"

const SOURCE_MIME = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska", ".ogv": "video/ogg", ".avi": "video/x-msvideo" }

/**
 * @param {import("./scan.js").PageScan} page
 * @param {{ index: import("./index-store.js").Index, playlists: Map<string, string>, playerPath: string }} context
 *   `playlists`: source → root-relative playlist path; `playerPath`: root-relative player file
 * @returns {{ edits: import("./scroll.js").SourceEdit[], sources: string[] }}
 *   `sources`: the converted videos the page plays, sorted
 */
export function pageEdits({ page, lines, refs, players }, { index, playlists, playerPath }) {
  const edits = []
  const sources = new Set()
  let firstTop = Infinity
  for (const ref of refs) {
    const playable = index.videos[ref.source]?.status === "converted"
    const target = playable ? playlists.get(ref.source) : ref.source
    if (playable) {
      sources.add(ref.source)
      firstTop = Math.min(firstTop, ref.top)
    }
    if (ref.current !== target) {
      // scroll's quick video line only matches video file extensions, so a playlist needs a `video` line.
      const url = urlFor(target, page, ref.absolute)
      edits.push({ line: ref.line, start: ref.start, end: ref.end, text: ref.kind === "quickVideo" ? `video ${url}` : url })
    }
    if (ref.type) {
      const type = playable ? HLS_MIME : SOURCE_MIME[path.posix.extname(ref.source).toLowerCase()]
      if (type && ref.type.value !== type && (playable || ref.type.value === HLS_MIME)) edits.push({ line: ref.line, start: ref.type.start, end: ref.type.end, text: type })
    }
  }

  // The player is inlined with scroll's `inlineJs <path>`, once per page that plays HLS.
  const playerSrc = urlFor(playerPath, page, false)
  if (!sources.size) for (const player of players) edits.push({ removeLine: player.line })
  else if (players.length) {
    const [first, ...duplicates] = players
    if (first.src !== playerSrc) edits.push({ line: first.line, start: first.start, end: lines[first.line].length, text: `inlineJs ${playerSrc}` })
    for (const player of duplicates) edits.push({ removeLine: player.line })
  } else edits.push({ insertBefore: firstTop, text: `inlineJs ${playerSrc}` })

  return { edits, sources: [...sources].sort() }
}
