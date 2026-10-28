// Scroll side: find a site's .scroll sources and the video references in them,
// and splice replacements into the source lines. HTML is never parsed; the
// HTML is regenerated afterwards with `scroll build`.
//
// Particle syntax: a line's children are the following lines indented by more
// spaces; any line with less or equal indentation (including an empty line)
// ends the block. References are found in:
//   video clip.mp4            scroll's video parser (the URL atom)
//   clip.mp4                  scroll's quick video line
//   script …                  string literals in script blocks
//   <video src=…> / html …    src of <video>/<source> tags in inline HTML
// Blocks whose content is raw text (code, css, comments, …) are skipped.
import { readdir } from "node:fs/promises"
import path from "node:path"
import { PLAYER_FILE } from "./layout.js"

/**
 * A video reference found in a .scroll source: columns [start, end) of `line`
 * hold `url`. `top` is the line of its top-level particle, where the player
 * line is inserted. html refs on <source> tags carry the span of their `type`.
 * @typedef {object} VideoRef
 * @property {"video" | "quickVideo" | "script" | "html"} kind
 * @property {number} line
 * @property {number} start
 * @property {number} end
 * @property {string} url
 * @property {number} top
 * @property {{ value: string, start: number, end: number } | null} [type]
 */
/**
 * An `inlineJs …/static-site-hls.js` line; `src` is the path as written.
 * @typedef {{ line: number, start: number, src: string }} PlayerLine
 */
/**
 * A change to source lines: replace columns, insert a line, or remove one.
 * @typedef {{ line: number, start: number, end: number, text: string }
 *   | { insertBefore: number, text: string }
 *   | { removeLine: number }} SourceEdit
 */

// quickVideoParser's pattern in scroll's parsers/video.parsers.
const QUICK_VIDEO = /^[^\s]+\.(mp4|webm|avi|mov)(?:\?[^\s]*)?$/
// Cues of scroll parsers (v180.2.0) whose children are raw text, not scroll.
// `script` and `html` are handled separately.
const RAW_CUES = new Set([
  "assert", "assertBuildEndsWith", "assertBuildIncludes", "assertHtmlEquals", "assertHtmlExcludes",
  "assertHtmlIncludes", "assertHtmlMatches", "chat", "code", "codeFromFile", "codeWithHeader",
  "codeWithLanguage", "comment", "//", "!", "thanksTo", "css", "dashboard", "debugParsers",
  "debugSourceMap", "dumpConcept", "example", "inlineCss", "inlineJs", "javascript", "katex",
  "plainText", "plainTextOnly", "prism", "prismFromFile", "quote", "string",
])
const LITERAL = /(["'`])((?:(?!\1)[^\\])*)\1/g
const MEDIA_TAG = /<(video|source)\b[^>]*>/gi
const attribute = (name) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i")
const SRC = attribute("src")
const TYPE = attribute("type")

/**
 * All .scroll files under `root` as sorted POSIX paths relative to it.
 * Skips dot-folders, node_modules, symlinks and the `exclude` folders.
 */
export async function findScrollFiles(root, exclude = []) {
  const skip = new Set(exclude.map((dir) => path.posix.normalize(dir)))
  const files = []
  const walk = async (rel) => {
    for (const entry of await readdir(path.join(root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && entry.name !== "node_modules" && !skip.has(child)) await walk(child)
      } else if (entry.isFile() && entry.name.endsWith(".scroll")) {
        files.push(child)
      }
    }
  }
  await walk("")
  return files.sort()
}

/**
 * Resolve a URL used by `file` (whose HTML is built next to it) to a POSIX path
 * relative to the site root. Null for external, data/blob, fragment-only URLs
 * and paths escaping the root.
 */
export function resolveUrl(url, file) {
  const value = url.trim()
  if (!value || value.startsWith("#") || value.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(value)) return null
  let pathname = value.split(/[?#]/, 1)[0]
  try {
    pathname = decodeURIComponent(pathname)
  } catch {
    return null
  }
  const absolute = pathname.startsWith("/")
  const rel = absolute ? path.posix.normalize(pathname.slice(1)) : path.posix.join(path.posix.dirname(file), pathname)
  if (!rel || rel === "." || rel === ".." || rel.startsWith("../")) return null
  return { path: rel, absolute }
}

/**
 * URL of `target` (root-relative path) as written in `file`: root-absolute or
 * relative like the reference it replaces. Percent-encoded, quotes included,
 * so it is safe inside any string literal or attribute and as a scroll atom.
 */
export function urlFor(target, file, absolute) {
  const rel = absolute ? target : path.posix.relative(path.posix.dirname(file), target)
  const encoded = rel.split("/").map((part) => encodeURIComponent(part).replaceAll("'", "%27")).join("/")
  return absolute ? `/${encoded}` : encoded
}

const indentOf = (line) => line.length - line.trimStart().length

/**
 * Locate video references and previously inserted player lines in a scroll source.
 * @param {string} text
 * @returns {{ lines: string[], refs: VideoRef[], players: PlayerLine[] }}
 */
export function analyzeScroll(text) {
  const lines = text.split("\n")
  const refs = []
  const players = []
  const blockEnd = (i, indent) => {
    let j = i + 1
    while (j < lines.length && lines[j] !== "" && indentOf(lines[j]) > indent) j++
    return j
  }

  const scanScript = (i, column, top) => {
    for (const match of lines[i].slice(column).matchAll(LITERAL)) {
      const value = match[2]
      if (!value || (match[1] === "`" && value.includes("${"))) continue
      const start = column + match.index + 1
      refs.push({ kind: "script", line: i, start, end: start + value.length, url: value, top })
    }
  }
  const scanHtml = (i, column, top) => {
    for (const tag of lines[i].slice(column).matchAll(MEDIA_TAG)) {
      const src = SRC.exec(tag[0])
      if (!src) continue
      const tagStart = column + tag.index
      const span = (match) => {
        const value = match[1] ?? match[2]
        const start = tagStart + match.index + match[0].length - value.length - 1
        return { value, start, end: start + value.length }
      }
      const { value, start, end } = span(src)
      const type = tag[1].toLowerCase() === "source" && TYPE.exec(tag[0])
      refs.push({ kind: "html", line: i, start, end, url: value.replaceAll("&amp;", "&"), top, type: type ? span(type) : null })
    }
  }

  const walk = (from, to, top) => {
    for (let i = from; i < to; ) {
      const line = lines[i]
      const indent = indentOf(line)
      const end = blockEnd(i, indent)
      const content = line.slice(indent)
      const cue = content.split(" ", 1)[0]
      const particleTop = top ?? i
      if (cue === "video") {
        const url = content.slice(6).split(" ", 1)[0]
        if (url) refs.push({ kind: "video", line: i, start: indent + 6, end: indent + 6 + url.length, url, top: particleTop })
      } else if (QUICK_VIDEO.test(content)) {
        refs.push({ kind: "quickVideo", line: i, start: indent, end: line.length, url: content, top: particleTop })
      } else if (cue === "script") {
        scanScript(i, indent + 6, particleTop)
        for (let j = i + 1; j < end; j++) scanScript(j, 0, particleTop)
      } else if (cue === "inlineJs" && path.posix.basename(content.split(" ")[1] ?? "") === PLAYER_FILE) {
        players.push({ line: i, start: indent, src: content.split(" ")[1] })
      } else if (cue === "html" || content.startsWith("<")) {
        scanHtml(i, indent, particleTop)
        for (let j = i + 1; j < end; j++) scanHtml(j, 0, particleTop)
      } else if (!RAW_CUES.has(cue) && !/^\w+Parser$/.test(cue)) {
        walk(i + 1, end, particleTop)
      }
      i = end
    }
  }

  walk(0, lines.length, null)
  return { lines, refs, players }
}

/**
 * Apply edits to source lines and join them back into the file's text.
 * @param {string[]} lines
 * @param {SourceEdit[]} edits
 */
export function applyEdits(lines, edits) {
  const out = [...lines]
  const spans = edits.filter((edit) => "start" in edit).sort((a, b) => b.line - a.line || b.start - a.start)
  for (const { line, start, end, text } of spans) out[line] = out[line].slice(0, start) + text + out[line].slice(end)
  const structural = edits.filter((edit) => !("start" in edit)).sort((a, b) => (b.insertBefore ?? b.removeLine) - (a.insertBefore ?? a.removeLine))
  for (const edit of structural) {
    if ("removeLine" in edit) out.splice(edit.removeLine, 1)
    else out.splice(edit.insertBefore, 0, edit.text)
  }
  return out.join("\n")
}
