// Index migrations. Every file in test/fixtures/index/ is an index written by an
// older static-site-hls; each must migrate to a valid current index (migrateIndex
// validates against the schemas). When the index format changes, add fixtures of
// the previous version here.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { test } from "node:test"
import { CURRENT_INDEX_VERSION, GENERATOR, migrateIndex, SchemaError } from "../src/index.js"

const FIXTURES = new URL("./fixtures/index/", import.meta.url)
const fixture = async (name) => JSON.parse(await readFile(new URL(name, FIXTURES), "utf8"))

for (const name of await readdir(FIXTURES)) {
  test(`${name} migrates to the current index version without losing entries`, async () => {
    const old = await fixture(name)
    const before = structuredClone(old)
    const { index, migratedFrom } = migrateIndex(old)
    assert.equal(migratedFrom, old.version)
    assert.equal(index.version, CURRENT_INDEX_VERSION)
    assert.equal(index.generator, GENERATOR)
    assert.deepEqual(Object.keys(index.videos).sort(), Object.keys(old.videos).sort())
    assert.deepEqual(index.pages, old.pages)
    assert.deepEqual(old, before, "the input must not be modified")
  })
}

test("v1 → v2 keeps every video's state", async () => {
  const { index } = migrateIndex(await fixture("v1-posters-off-unsupported.json"))
  assert.deepEqual(index.settings, { videosDir: "videos", posters: false })
  assert.deepEqual(index.videos["clips/brunch clip.mp4"], {
    status: "converted",
    id: "clips/brunch clip",
    sha256: "51340618f0d97cdd65cf9b2434ea720f003ac5b1e82aa6496781687e4b1693da",
    convertedAt: "2026-10-27T14:54:31.651Z",
    hls: { segments: 2, codecs: { video: "h264", audio: "aac (from opus)" } },
  })
  assert.equal(index.videos["intro.mov"].poster, "poster.jpg")
  assert.equal(index.videos["intro.mov"].hls.duration, 4.5)
  assert.deepEqual(index.videos["clips/vp9.webm"], {
    status: "unsupported",
    id: "clips/vp9",
    sha256: "4fb99e273ce133bbebd69c0f74ddb56dd02ef3161dfc05742bcd09c7f93f4ef0",
    reason: "video codec is vp9; only H.264 can be converted (stream copy), because the WASIX ffmpeg build has no H.264 encoder. Re-encode the source to H.264 first",
  })
})

test("v1 written before posters existed migrates with posters on", async () => {
  const { index } = migrateIndex(await fixture("v1-launchation-before-posters.json"))
  assert.deepEqual(index.settings, { videosDir: "streams", posters: true })
})

test("a current index is returned as is", async () => {
  const { index: current } = migrateIndex(await fixture("v1-launchation-before-posters.json"))
  const { index, migratedFrom } = migrateIndex(current)
  assert.equal(migratedFrom, null)
  assert.deepEqual(index, current)
})

test("an index from a newer static-site-hls is refused, not misread", () => {
  assert.throws(() => migrateIndex({ version: CURRENT_INDEX_VERSION + 1, generator: "@lessconversation/static-site-hls@9.0.0" }), /newer static-site-hls.*Upgrade/)
})

test("an invalid index names the offending field", async () => {
  const old = await fixture("v1-posters-off-unsupported.json")
  delete old.videos["intro.mov"].sha256
  assert.throws(() => migrateIndex(old), (error) => error instanceof SchemaError && error.message.includes("/videos/intro.mov"))
  assert.throws(() => migrateIndex({ videos: {} }), SchemaError)
})
