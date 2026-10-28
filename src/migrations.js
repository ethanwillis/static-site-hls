// Index migrations, oldest first. Each one upgrades an index from version
// `from` to `from + 1`. index-store.js validates its input against the `from`
// schema and its output against the `to` schema, and chains them until the
// index reaches CURRENT_INDEX_VERSION.
//
// Changing the index format (see docs/data-model.md#changing-the-index-format):
// 1. add schemas/index.v<N>.schema.json and register it in validate.js;
// 2. append the v<N-1> → v<N> migration here;
// 3. bump CURRENT_INDEX_VERSION in index-store.js and update the code that reads
//    and writes the index;
// 4. add test/fixtures/index/v<N-1>-*.json examples that test/migrations.test.js
//    migrates.

/**
 * @typedef {object} Migration
 * @property {number} from
 * @property {number} to
 * @property {string} summary what changed, shown when the index is upgraded
 * @property {(index: any, context: { generator: string }) => any} migrate
 *   pure: returns the upgraded index without touching its input
 */

/** @type {Migration[]} */
export const MIGRATIONS = [
  {
    from: 1,
    to: 2,
    summary: "settings grouped under `settings`; each video has an explicit `status`; HLS details under `hls`; records the generator",
    migrate(v1, { generator }) {
      const videos = Object.fromEntries(Object.entries(v1.videos).map(([source, entry]) => [
        source,
        "unsupported" in entry
          ? { status: "unsupported", id: entry.id, sha256: entry.sha256, reason: entry.unsupported }
          : {
              status: "converted",
              id: entry.id,
              sha256: entry.sha256,
              convertedAt: entry.convertedAt,
              hls: {
                segments: entry.segments,
                ...(entry.duration !== undefined && { duration: entry.duration }),
                codecs: { ...entry.codecs },
              },
              ...(entry.poster !== undefined && { poster: entry.poster }),
            },
      ]))
      return {
        version: 2,
        generator,
        // Version 1 files from before posters existed lack the flag; posters then became the default.
        settings: { videosDir: v1.videosDir, posters: v1.posters ?? true },
        videos,
        pages: Object.fromEntries(Object.entries(v1.pages).map(([page, sources]) => [page, [...new Set(sources)]])),
      }
    },
  },
]
