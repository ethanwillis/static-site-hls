// WASIX ffmpeg conversion end to end, on tiny fixtures. Guards the pinned
// wasmer/ffmpeg and @wasmer/sdk versions (run after `npm run deps:update`).
// The first run downloads wasmer/ffmpeg (about 40 MB) into the package cache.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { after, before, test } from "node:test"
import { Wasmer } from "@wasmer/sdk/node"
import { WASMER_CACHE_DIR } from "../src/apply.js"
import { openConverter, PLAYLIST, POSTER } from "../src/convert.js"

const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url))
let wasmer
let converter

before(async () => {
  wasmer = new Wasmer({ cache: { directory: WASMER_CACHE_DIR } })
  converter = await openConverter(wasmer)
})
after(async () => {
  await converter?.close()
  await wasmer?.close()
})

test("H.264 + AAC converts to a playlist, segments and a JPEG poster", async () => {
  const result = await converter.convert(await fixture("tiny.mp4"), ".mp4", { poster: true })
  assert.ok(!("unsupported" in result), result.unsupported)
  const names = result.files.map((file) => file.name)
  assert.equal(names.at(-1), PLAYLIST, "playlist comes last")
  assert.ok(names.includes(POSTER))
  assert.equal(names.filter((name) => name.endsWith(".ts")).length, result.segments)
  assert.deepEqual(result.codecs, { video: "h264", audio: "aac" })
  assert.ok(Math.abs(result.duration - 2) < 0.2, `duration ${result.duration}`)

  const playlist = new TextDecoder().decode(result.files.at(-1).bytes)
  assert.match(playlist, /#EXT-X-PLAYLIST-TYPE:VOD/)
  assert.match(playlist, /#EXT-X-ENDLIST/)
  const poster = result.files.find((file) => file.name === POSTER).bytes
  assert.deepEqual([...poster.slice(0, 3)], [0xff, 0xd8, 0xff], "poster is a JPEG")
})

test("without posters, no poster.jpg", async () => {
  const result = await converter.convert(await fixture("tiny.mp4"), ".mp4")
  assert.equal(result.poster, false)
  assert.ok(!result.files.some((file) => file.name === POSTER))
})

test("non-H.264 video is reported as unsupported", async () => {
  const result = await converter.convert(await fixture("tiny-vp9.webm"), ".webm", { poster: true })
  assert.match(result.unsupported, /vp9/)
})
