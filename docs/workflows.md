# Workflows

Timing diagrams for what happens, in which order, when static-site-hls runs and when a visitor plays a video. Names on the arrows are the functions and the [types](data-model.md) passed.

- [convert, first run](#convert-first-run)
- [convert after a video changes](#convert-after-a-video-changes)
- [Reading and migrating the index](#reading-and-migrating-the-index)
- [Changing settings](#changing-settings-videos-dir-posters)
- [Page load and playback](#page-load-and-playback)
- [serve](#serve)

Developer-side workflows (tests, dependency updates, releases) are in [development.md](development.md).

## convert, first run

A site with one page and one video, no data folder yet: `static-site-hls my-site`.

<details>
<summary>Diagram: convert, first run</summary>

```mermaid
sequenceDiagram
  autonumber
  actor Dev as Developer
  participant CLI as CLI
  participant Scan as Planner<br/>scan.js
  participant Store as Index store
  participant Parser as Scroll parser
  participant Apply as Executor<br/>apply.js
  participant Conv as Converter
  participant WASIX as WASIX ffmpeg<br/>sandbox
  participant FS as Site files
  participant Scroll as scroll build

  Dev->>CLI: static-site-hls my-site
  CLI->>Scan: scan(root, options)
  Scan->>Store: readIndex(index.json)
  Store-->>Scan: emptyIndex() (no file yet)
  Scan->>Parser: findScrollFiles(), analyzeScroll(text)
  Parser-->>Scan: VideoRef[], PlayerLine[] per page
  Scan->>FS: stat + sha256 each referenced video
  Scan-->>CLI: ScanPlan (videos: status "new")
  CLI->>Dev: page → video map, "1 to convert"
  Dev->>CLI: confirm (or --yes)
  CLI->>Apply: apply(plan)
  Apply->>Store: writeIndex(index) (settings saved first)
  Apply->>FS: write static-site-hls.js (PlayerConfig), hls.min.js
  Apply->>Conv: openConverter(wasmer)
  Conv->>WASIX: create sandbox (wasmer/ffmpeg from cache or registry)
  loop each video with status new / changed / rebuild
    Apply->>FS: read video bytes
    Apply->>Conv: convert(bytes, ext, {poster})
    Conv->>WASIX: ffprobe (streams, codecs, duration)
    alt video is H.264
      Conv->>WASIX: ffmpeg -c:v copy -f hls → index.m3u8 + NNN.ts
      Conv->>WASIX: ffmpeg -frames:v 1 → poster.jpg
      Conv-->>Apply: ConversionResult (files, segments, codecs)
      Apply->>FS: replace videos/<id>/
    else other codec
      Conv-->>Apply: ConversionResult {unsupported}
    end
    Apply->>Store: writeIndex(index) (progress survives interruption)
  end
  Apply->>Apply: pageEdits(page) per page → SourceEdit[]
  Apply->>FS: write changed .scroll files
  Apply->>Store: writeIndex(index) (pages map)
  Apply->>Scroll: scroll build (per folder)
  Scroll->>FS: write HTML with the player inlined
  Apply-->>CLI: ApplyResult
  CLI->>Dev: "Done: 1 converted, … 1 source(s) updated."
```

</details>

The WASIX sandbox is created only when a video needs converting; a run that only rewrites sources or moves folders never loads ffmpeg.

## convert after a video changes

The developer overwrote `media/intro.mp4` in place. Pages already point at the playlist, so only the HLS output and the index change.

<details>
<summary>Diagram: convert after a video changes</summary>

```mermaid
sequenceDiagram
  autonumber
  actor Dev as Developer
  participant Scan as Planner
  participant Apply as Executor
  participant WASIX as Converter + WASIX
  participant FS as Site files

  Dev->>Scan: static-site-hls my-site
  Scan->>FS: analyzeScroll(index.scroll)
  Note over Scan: the reference is a playlist path,<br/>which the index maps back to media/intro.mp4
  Scan->>FS: sha256(media/intro.mp4)
  Note over Scan: hash ≠ index entry → status "changed"
  Scan-->>Dev: plan: 1 to convert
  Dev->>Apply: confirm
  Apply->>WASIX: convert(bytes)
  WASIX-->>Apply: new segments + poster
  Apply->>FS: replace videos/media/intro/
  Apply->>Apply: pageEdits() → no edits
  Note over Apply: no source and no player change →<br/>no scroll build
  Apply-->>Dev: Done: 1 converted, 0 source(s) updated
```

</details>

Other reasons a video is converted again: its HLS output folder or (with posters on) its `poster.jpg` is missing (`rebuild`). Unchanged videos are never touched: the content hash, not the file date, decides.

## Reading and migrating the index

Every `scan` reads the index through the index store. Older versions are upgraded in memory; the file on disk changes only when `convert` saves it.

<details>
<summary>Diagram: reading and migrating the index</summary>

```mermaid
sequenceDiagram
  autonumber
  participant Scan as Planner
  participant Store as readIndex()
  participant Val as validate.js<br/>(schemas/)
  participant Mig as migrations.js
  participant Apply as Executor

  Scan->>Store: readIndex(index.json)
  alt no file
    Store-->>Scan: emptyIndex(), exists: false
  else file exists
    Store->>Store: JSON.parse
    alt version > CURRENT_INDEX_VERSION
      Store-->>Scan: error: written by a newer static-site-hls, upgrade
    end
    Store->>Val: assertIndex(data, data.version)
    loop while version < CURRENT_INDEX_VERSION
      Store->>Mig: migration[from = version].migrate(index)
      Mig-->>Store: index of version + 1
      Store->>Val: assertIndex(index, version + 1)
    end
    Store-->>Scan: { index (current), migratedFrom }
  end
  Note over Scan: scan output shows<br/>"version 1, convert upgrades it to version 2"
  Scan-->>Apply: ScanPlan (index already current)
  Apply->>Store: writeIndex(index)
  Store->>Val: assertIndex(index, CURRENT) + stamp generator
  Store->>Store: write index.json.tmp, rename over index.json
```

</details>

## Changing settings: `--videos-dir`, `--posters`

<details>
<summary>Diagram: changing --videos-dir and --posters</summary>

```mermaid
sequenceDiagram
  autonumber
  actor Dev as Developer
  participant Apply as Executor
  participant FS as Site files
  participant Scroll as scroll build

  Dev->>Apply: static-site-hls my-site --videos-dir media-hls --no-posters
  Apply->>FS: rename static-site-hls/videos/ → static-site-hls/media-hls/
  Apply->>FS: index.settings = { videosDir: media-hls, posters: false }
  Apply->>FS: write static-site-hls.js with the new PlayerConfig
  Note over Apply: player bytes changed → pages need a rebuild
  Apply->>FS: delete every poster.jpg, drop "poster" from index entries
  Apply->>FS: rewrite references …/videos/… → …/media-hls/…
  Apply->>Scroll: scroll build
```

</details>

Both settings are saved in the index, so later runs keep them without the flags.

## Page load and playback

A visitor opens a page whose script does `video.src = "static-site-hls/videos/why/index.m3u8"` (launchation.com's background video works this way).

<details>
<summary>Diagram: page load and playback</summary>

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant P as Player<br/>(inlined script)
  participant S as Page script
  participant V as video element
  participant H as Web host

  B->>H: GET /
  H-->>B: HTML
  B->>P: run inline player (before page scripts)
  P->>P: hook HTMLMediaElement.src, start MutationObserver
  B->>S: run page script
  S->>V: video.src = ".../why/index.m3u8"
  V->>P: src setter hook
  P->>V: poster = ".../why/poster.jpg"
  V->>H: GET poster.jpg
  Note over V: poster visible: a frame on screen<br/>while the first segment loads
  alt native HLS (Safari, iOS, recent Chrome)
    P->>V: pass the playlist URL through
    V->>H: GET index.m3u8, 000.ts
  else no native HLS
    P->>H: GET hls.min.js (once per page)
    P->>V: new Hls(), loadSource(playlist), attachMedia(video)
    V->>H: GET index.m3u8, 000.ts (via hls.js, Media Source Extensions)
  end
  Note over V: first segment complete → first frame replaces the poster
  S->>V: next clip: video.src = ".../koa/index.m3u8"
  V->>P: hook: new poster, (hls.js) destroy old Hls, attach new
```

</details>

Markup works the same way through the MutationObserver: `<video src="….m3u8">` or a `<source>` with a playlist triggers the poster and, without native HLS, hls.js.

Why posters matter: a video can't show anything until its whole first segment has arrived, and segments split on the source's keyframes (often 8 s apart, hundreds of KB). On a throttled mobile connection that measured 10.6 s of empty background on launchation.com without posters, and about 4 s Speed Index with them.

## serve

<details>
<summary>Diagram: serve</summary>

```mermaid
sequenceDiagram
  actor Dev as Developer
  participant CLI as CLI
  participant Srv as serve.js
  participant B as Browser

  Dev->>CLI: static-site-hls serve my-site --port 8080
  CLI->>Srv: serve(root, { port })
  Srv-->>Dev: Serving … at http://localhost:8080/
  B->>Srv: GET /static-site-hls/videos/why/index.m3u8
  Srv-->>B: 200 application/vnd.apple.mpegurl, cache-control: no-cache
  Note over Srv,B: no-cache: revalidated each time (fresh after re-conversion)<br/>but back/forward cache still allowed (no-store would block it)
  B->>Srv: GET /../outside
  Srv-->>B: 403 / 404 (never serves outside the site)
```

</details>
