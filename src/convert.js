// HLS conversion with the WASIX build of ffmpeg (wasmer/ffmpeg) inside a
// @wasmer/sdk sandbox. Runtime-agnostic: pass a Wasmer client from either
// "@wasmer/sdk/node" or "@wasmer/sdk/browser".
//
// The WASIX ffmpeg build has no H.264 encoder, so video is always stream-copied
// (lossless and fast). Sources must therefore already be H.264. Audio is copied
// when HLS-compatible (AAC, MP3) and re-encoded to AAC otherwise. Segments split
// on source keyframes, so real segment lengths are at least SEGMENT_SECONDS.
// Posters are the first video frame as JPEG (the build does have an MJPEG encoder).

export const FFMPEG_PACKAGE = "wasmer/ffmpeg@=1.0.5"
export const SEGMENT_SECONDS = 6
export const PLAYLIST = "index.m3u8"
export const POSTER = "poster.jpg"

const COPY_AUDIO = new Set(["aac", "mp3"])

/** ffmpeg arguments that turn `input` into `outDir/index.m3u8` + `outDir/000.ts`… */
export const hlsArgs = (input, outDir, { video, audio }) => [
  "-hide_banner", "-nostats", "-loglevel", "error", "-y",
  "-i", input,
  "-map", `0:${video.index}`,
  ...(audio ? ["-map", `0:${audio.index}`] : []),
  "-c:v", "copy",
  ...(audio ? (COPY_AUDIO.has(audio.codec) ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "128k"]) : []),
  "-f", "hls",
  "-hls_time", String(SEGMENT_SECONDS),
  "-hls_playlist_type", "vod",
  "-hls_flags", "independent_segments",
  "-hls_segment_filename", `${outDir}/%03d.ts`,
  `${outDir}/${PLAYLIST}`,
]

/** ffmpeg arguments that write the first frame of `input` to `outDir/poster.jpg`. */
export const posterArgs = (input, outDir, { video }) => [
  "-hide_banner", "-nostats", "-loglevel", "error", "-y",
  "-i", input,
  "-map", `0:${video.index}`,
  "-frames:v", "1",
  "-c:v", "mjpeg", "-q:v", "3",
  "-update", "1",
  `${outDir}/${POSTER}`,
]

/**
 * What `convert()` returns: either why the video can't be converted, or its HLS
 * files (playlist last, poster.jpg included when asked for) and stream details.
 * @typedef {{ unsupported: string }
 *   | { files: { name: string, bytes: Uint8Array }[], segments: number, poster: boolean,
 *       duration?: number, codecs: { video: "h264", audio?: string } }} ConversionResult
 */

/**
 * Open one sandbox for a batch of conversions. Close it when done.
 * @param {import("@wasmer/sdk").Wasmer} wasmer
 * @returns {Promise<{ convert: (bytes: Uint8Array, extension?: string, options?: { poster?: boolean }) => Promise<ConversionResult>, close: () => Promise<void> }>}
 */
export async function openConverter(wasmer) {
  const sandbox = await wasmer.sandboxes.create({ packages: [FFMPEG_PACKAGE] })

  const run = async (command, args) => {
    const output = await sandbox.command(command, args).run({ check: false })
    if (!output.ok) throw new Error(`${command} exited ${output.exitCode}: ${output.stderr.text().trim()}`)
    return output.stdout.text()
  }

  const probe = async (input) => {
    const info = JSON.parse(await run("ffprobe", [
      "-v", "error", "-of", "json",
      "-show_entries", "stream=index,codec_type,codec_name:stream_disposition=attached_pic:format=duration",
      input,
    ]))
    const streams = (info.streams ?? []).filter((s) => !s.disposition?.attached_pic)
    const pick = (type) => {
      const s = streams.find((stream) => stream.codec_type === type)
      return s && { index: s.index, codec: s.codec_name }
    }
    return { video: pick("video"), audio: pick("audio"), duration: Number(info.format?.duration) || undefined }
  }

  return {
    /**
     * Convert one video.
     * @param {Uint8Array} bytes
     * @param {string} [extension] source extension such as ".mp4", as a hint for ffmpeg
     * @param {{ poster?: boolean }} [options]
     * @returns {Promise<ConversionResult>}
     */
    async convert(bytes, extension = "", { poster = false } = {}) {
      const input = `/workspace/input${extension}`
      const outDir = "/workspace/hls"
      await sandbox.fs.writeFile(input, bytes)
      let made = false
      try {
        const { video, audio, duration } = await probe(input)
        if (!video) return { unsupported: "no video stream" }
        if (video.codec !== "h264") {
          return { unsupported: `video codec is ${video.codec}; only H.264 can be converted (stream copy), because the WASIX ffmpeg build has no H.264 encoder. Re-encode the source to H.264 first` }
        }
        await sandbox.fs.mkdir(outDir, { recursive: true })
        made = true
        await run("ffmpeg", hlsArgs(input, outDir, { video, audio }))
        if (poster) await run("ffmpeg", posterArgs(input, outDir, { video }))
        const names = (await sandbox.fs.readDir(outDir)).map((entry) => entry.name)
        names.sort((a, b) => (a === PLAYLIST) - (b === PLAYLIST) || a.localeCompare(b))
        const files = []
        for (const name of names) files.push({ name, bytes: await sandbox.fs.readFile(`${outDir}/${name}`) })
        return {
          files,
          segments: names.filter((name) => name.endsWith(".ts")).length,
          poster: names.includes(POSTER),
          duration,
          codecs: { video: video.codec, ...(audio && { audio: COPY_AUDIO.has(audio.codec) ? audio.codec : `aac (from ${audio.codec})` }) },
        }
      } finally {
        await sandbox.fs.remove(input)
        if (made) await sandbox.fs.remove(outDir, { recursive: true })
      }
    },
    close: () => sandbox.close(),
  }
}
