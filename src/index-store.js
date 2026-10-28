// Reading and writing <data-dir>/index.json. Reads accept every index version
// that has a schema and migrate it to the current one in memory; writes always
// produce the current version. Both sides are validated (validate.js).
import { readFile, rename, writeFile } from "node:fs/promises"
import pkg from "../package.json" with { type: "json" }
import { DEFAULT_VIDEOS_DIR } from "./layout.js"
import { MIGRATIONS } from "./migrations.js"
import { assertIndex, SchemaError } from "./validate.js"

/** Version of the index this static-site-hls writes (schemas/index.v2.schema.json). */
export const CURRENT_INDEX_VERSION = 2
/** Recorded in every index this package writes. */
export const GENERATOR = `${pkg.name}@${pkg.version}`

/**
 * An index in the current format (schemas/index.v2.schema.json).
 * @typedef {object} Index
 * @property {2} version
 * @property {string} generator
 * @property {{ videosDir: string, posters: boolean }} settings
 * @property {Record<string, VideoEntry>} videos source video path → state
 * @property {Record<string, string[]>} pages .scroll path → converted sources it plays
 */
/**
 * @typedef {{ status: "converted", id: string, sha256: string, convertedAt: string,
 *   hls: { segments: number, duration?: number, codecs: { video: "h264", audio?: string } },
 *   poster?: string }
 *   | { status: "unsupported", id: string, sha256: string, reason: string }} VideoEntry
 */

/** @returns {Index} the index of a site that has never been converted */
export const emptyIndex = () => ({
  version: CURRENT_INDEX_VERSION,
  generator: GENERATOR,
  settings: { videosDir: DEFAULT_VIDEOS_DIR, posters: true },
  videos: {},
  pages: {},
})

/**
 * Validate parsed index JSON of any known version and migrate it to the current
 * version. Pure: `data` is not modified.
 * @param {unknown} data
 * @returns {{ index: Index, migratedFrom: number | null }} `migratedFrom` is the
 *   version read, or null when it already was current
 */
export function migrateIndex(data, { generator = GENERATOR } = {}) {
  const version = data?.version
  if (!Number.isInteger(version) || version < 1) throw new SchemaError(`index has no valid "version" (got ${JSON.stringify(version)})`)
  if (version > CURRENT_INDEX_VERSION) {
    throw new Error(`index version ${version} was written by a newer static-site-hls (${data.generator ?? "unknown"}); ${GENERATOR} reads versions up to ${CURRENT_INDEX_VERSION}. Upgrade static-site-hls.`)
  }
  let index = assertIndex(data, version)
  while (index.version < CURRENT_INDEX_VERSION) {
    const migration = MIGRATIONS.find((m) => m.from === index.version)
    if (!migration) throw new Error(`no migration from index version ${index.version}`)
    index = assertIndex(migration.migrate(index, { generator }), migration.to, `index migrated from version ${migration.from} to ${migration.to}`)
  }
  return { index, migratedFrom: version === CURRENT_INDEX_VERSION ? null : version }
}

/**
 * Read an index file. A missing file is a new, empty index.
 * @param {string} file absolute path of index.json
 * @returns {Promise<{ index: Index, migratedFrom: number | null, exists: boolean }>}
 */
export async function readIndex(file) {
  let text
  try {
    text = await readFile(file, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return { index: emptyIndex(), migratedFrom: null, exists: false }
    throw error
  }
  try {
    return { ...migrateIndex(JSON.parse(text)), exists: true }
  } catch (error) {
    error.message = `${file}: ${error.message}`
    throw error
  }
}

/**
 * Stamp the generator, validate against the current schema, and replace the
 * file atomically (write to a temporary file, then rename over it).
 * @param {string} file absolute path of index.json
 * @param {Index} index
 */
export async function writeIndex(file, index) {
  index.generator = GENERATOR
  assertIndex(index, CURRENT_INDEX_VERSION, "index to save")
  const temporary = `${file}.tmp`
  await writeFile(temporary, JSON.stringify(index, null, 2) + "\n")
  await rename(temporary, file)
}
