# Architecture

static-site-hls described with the [C4 model](https://c4model.com), from the widest view inward:

1. [System context](#level-1-system-context): who and what the tool deals with.
2. [Containers](#level-2-containers): the separately running or separately stored parts.
3. [Components](#level-3-components): the modules inside the core library and inside the browser player.
4. [Deployment](#deployment): where each part runs.

Then a [module map](#module-map) and the [design decisions](#design-decisions) behind the shape. How the parts talk over time is in [workflows.md](workflows.md); the data they pass is in [data-model.md](data-model.md).

**Notation.** C4 elements drawn as flowcharts (mermaid's own C4 diagrams lay out poorly):

```mermaid
flowchart LR
  p(["<b>Person</b>"]):::person
  s["<b>Software system</b><br/>this tool"]:::system
  c["<b>Container</b><br/>part of this tool"]:::container
  k["<b>Component</b><br/>module in a container"]:::component
  d[("<b>Stored data</b>")]:::container
  x["<b>External</b><br/>not part of this tool"]:::external
  subgraph b [Boundary]
    direction LR
    i[" "]:::hidden
  end
  classDef person fill:#08427b,stroke:#052e56,color:#fff
  classDef system fill:#1168bd,stroke:#0b4884,color:#fff
  classDef container fill:#438dd5,stroke:#3c7fc0,color:#fff
  classDef component fill:#85bbf0,stroke:#5d82a8,color:#000
  classDef external fill:#999,stroke:#6b6b6b,color:#fff
  classDef hidden fill:none,stroke:none
  style b fill:none,stroke:#444,stroke-dasharray:5 5
```

## Level 1: System context

```mermaid
flowchart TB
  dev(["<b>Site developer</b><br/>[Person]<br/>Maintains a Scroll site that shows local videos"]):::person
  visitor(["<b>Site visitor</b><br/>[Person]<br/>Watches the videos in a browser, often on a phone"]):::person
  tool["<b>static-site-hls</b><br/>[Software system]<br/>Converts the videos a Scroll site uses to HLS,<br/>points the site at the playlists, rebuilds it"]:::system
  site["<b>Scroll site</b><br/>[Folder, usually a git repo]<br/>.scroll sources, video files, built HTML"]:::external
  scroll["<b>Scroll</b><br/>[Static site generator]<br/>Builds HTML from .scroll files"]:::external
  wasmer["<b>Wasmer registry</b><br/>Hosts the wasmer/ffmpeg WASIX package"]:::external
  host["<b>Static web host</b><br/>[GitHub Pages or similar]<br/>Serves the built site"]:::external

  dev -- "runs scan / convert / serve" --> tool
  tool -- "reads sources and videos;<br/>writes sources and its data folder" --> site
  tool -- "runs scroll build" --> scroll
  scroll -- "writes HTML" --> site
  tool -- "downloads wasmer/ffmpeg once<br/>[HTTPS]" --> wasmer
  dev -- "deploys<br/>[git push]" --> site
  site -. "published to" .-> host
  visitor -- "loads pages, playlists, segments<br/>[HTTPS]" --> host

  classDef person fill:#08427b,stroke:#052e56,color:#fff
  classDef system fill:#1168bd,stroke:#0b4884,color:#fff
  classDef external fill:#999,stroke:#6b6b6b,color:#fff
```

static-site-hls never talks to the web host or the visitor. Everything that reaches the visitor goes through the Scroll site: the rewritten pages, the HLS files and the player, all deployed like any other file of the site.

## Level 2: Containers

```mermaid
flowchart TB
  dev(["<b>Site developer</b><br/>[Person]"]):::person
  visitor(["<b>Site visitor</b><br/>[Person]"]):::person

  subgraph tool [static-site-hls]
    cli["<b>CLI</b><br/>[Node.js 24: bin/static-site-hls.js]<br/>Commands, options, prompts,<br/>prints the plan and the result"]:::container
    core["<b>Core library</b><br/>[Node.js ESM: src/]<br/>scan(): plan the work<br/>apply(): convert, rewrite, save, build<br/>Also the programmatic API"]:::container
    sandbox["<b>WASIX ffmpeg sandbox</b><br/>[@wasmer/sdk + wasmer/ffmpeg 1.0.5]<br/>ffprobe and ffmpeg in an in-memory<br/>filesystem, in worker threads"]:::container
    server["<b>Local server</b><br/>[Node.js http: src/serve.js]<br/>Serves a site for testing"]:::container
    data[("<b>Data folder</b><br/>[files inside the site]<br/>index.json, player script, hls.min.js,<br/>one HLS folder per video")]:::container
    cache[("<b>Package cache</b><br/>[~/.cache/static-site-hls]<br/>the wasmer/ffmpeg package")]:::container
    player["<b>Player</b><br/>[browser JavaScript, inlined in pages]<br/>Sets posters; loads hls.js where<br/>HLS isn't native"]:::container
  end

  site["<b>Scroll site</b><br/>.scroll sources, videos, HTML"]:::external
  scroll["<b>Scroll CLI</b><br/>scroll build"]:::external
  wasmer["<b>Wasmer registry</b>"]:::external

  dev -- "runs" --> cli
  cli -- "scan(), apply()" --> core
  cli -- "serve()" --> server
  core -- "reads and rewrites .scroll;<br/>reads videos" --> site
  core -- "reads, writes" --> data
  core -- "video bytes in,<br/>HLS files out" --> sandbox
  sandbox -- "loads" --> cache
  sandbox -. "downloads on a cache miss" .-> wasmer
  core -- "spawns" --> scroll
  scroll -- "writes HTML, inlining the player" --> site
  data -. "player source" .-> scroll
  server -- "serves" --> site
  visitor -- "runs with each page" --> player

  classDef person fill:#08427b,stroke:#052e56,color:#fff
  classDef container fill:#438dd5,stroke:#3c7fc0,color:#fff
  classDef external fill:#999,stroke:#6b6b6b,color:#fff
  style tool fill:none,stroke:#444,stroke-dasharray:5 5
```

| Container | Runs where | Lifetime |
| --- | --- | --- |
| CLI, core library | Developer's machine, one Node.js process | One command |
| WASIX ffmpeg sandbox | Same process, @wasmer/sdk worker threads | One `convert`, only when something needs converting |
| Local server | Developer's machine | Until Ctrl+C |
| Data folder | Inside the site; committed and deployed with it | Permanent; [versioned](data-model.md#index-versions-and-migrations) |
| Package cache | Developer's machine | Permanent; safe to delete |
| Player | Visitor's browser, inlined into every page that plays HLS | One page view |

## Level 3: Components

### Core library

```mermaid
flowchart TB
  cli["<b>CLI</b><br/>[Container]"]:::container

  subgraph core [Core library: src/]
    scan["<b>Planner</b><br/>[scan.js]<br/>Finds video references, hashes<br/>sources, decides each video's status"]:::component
    apply["<b>Executor</b><br/>[apply.js]<br/>Runs the steps of a plan in order"]:::component
    parser["<b>Scroll source parser</b><br/>[scroll.js]<br/>Finds .scroll files, locates references<br/>and player lines, applies edits"]:::component
    rewriter["<b>Source rewriter</b><br/>[rewrite.js]<br/>Pure: the edits that point<br/>a page at playlists"]:::component
    store["<b>Index store</b><br/>[index-store.js, migrations.js,<br/>validate.js, schemas/]<br/>Reads any index version, migrates,<br/>validates, writes atomically"]:::component
    converter["<b>Converter</b><br/>[convert.js]<br/>Probes and converts one video;<br/>makes the poster"]:::component
    installer["<b>Player installer</b><br/>[player-install.js]<br/>Writes the player with its config,<br/>and hls.min.js"]:::component
    builder["<b>Scroll builder</b><br/>[scroll-build.js]<br/>Runs scroll build per folder"]:::component
  end

  data[("<b>Data folder</b>")]:::container
  sandbox["<b>WASIX ffmpeg sandbox</b>"]:::container
  site["<b>Scroll site</b>"]:::external
  scrollcli["<b>Scroll CLI</b>"]:::external

  cli -- "ScanPlan = scan(root, options)" --> scan
  cli -- "ApplyResult = apply(plan)" --> apply
  scan -- "readIndex()" --> store
  scan -- "findScrollFiles(), analyzeScroll()" --> parser
  apply -- "convert(bytes)" --> converter
  apply -- "installPlayer(config)" --> installer
  apply -- "pageEdits(page)" --> rewriter
  apply -- "applyEdits()" --> parser
  apply -- "writeIndex()" --> store
  apply -- "scrollBuild()" --> builder
  store -- "index.json" --> data
  installer -- "static-site-hls.js, hls.min.js" --> data
  converter -- "ffprobe, ffmpeg" --> sandbox
  parser -- ".scroll files" --> site
  builder -- "spawns" --> scrollcli

  classDef container fill:#438dd5,stroke:#3c7fc0,color:#fff
  classDef component fill:#85bbf0,stroke:#5d82a8,color:#000
  classDef external fill:#999,stroke:#6b6b6b,color:#fff
  style core fill:none,stroke:#444,stroke-dasharray:5 5
```

`layout.js` (not drawn) holds the names every component shares: the default folders, `index.json`, `static-site-hls.js`, `hls.min.js`, `index.m3u8`, `poster.jpg`.

### Player

```mermaid
flowchart TB
  pagejs["<b>Page scripts</b><br/>the site's own JavaScript"]:::external
  markup["<b>video / source elements</b><br/>in the page's HTML"]:::external

  subgraph player [Player: src/player.js, inlined into pages]
    config["<b>CONFIG</b><br/>[object literal]<br/>dataDir, videosDir, posters;<br/>written in by the player installer"]:::component
    hook["<b>src setter hook</b><br/>[HTMLMediaElement.prototype.src]<br/>Catches scripts that assign a playlist"]:::component
    observer["<b>Markup observer</b><br/>[MutationObserver]<br/>Catches video and source elements<br/>and their src changes"]:::component
    posters["<b>Poster setter</b><br/>Sets poster.jpg next to the playlist;<br/>never replaces a page's own poster"]:::component
    loader["<b>hls.js loader</b><br/>Only without native HLS: loads hls.min.js<br/>once, attaches one Hls per video"]:::component
  end

  video["<b>video element</b><br/>[browser]"]:::external
  hlsjs["<b>hls.js</b><br/>[data folder: hls.min.js]"]:::external

  pagejs -- "video.src = playlist" --> hook
  markup -- "added / src changed" --> observer
  hook -- "playlist URL" --> posters
  observer -- "playlist URL" --> posters
  hook -- "playlist URL" --> loader
  observer -- "playlist URL" --> loader
  config -. "read by" .-> posters
  config -. "read by" .-> loader
  posters -- "poster attribute" --> video
  loader -- "loads, attaches to video" --> hlsjs
  hlsjs -- "Media Source Extensions" --> video

  classDef component fill:#85bbf0,stroke:#5d82a8,color:#000
  classDef external fill:#999,stroke:#6b6b6b,color:#fff
  style player fill:none,stroke:#444,stroke-dasharray:5 5
```

With native HLS (Safari, iOS, recent Chrome), the loader stays idle: the browser plays the playlist URL itself and only posters are set.

## Deployment

```mermaid
flowchart LR
  subgraph machine [Developer machine]
    subgraph nodeproc [Node.js 24 process]
      cli["<b>CLI + core library</b>"]:::container
      sandbox["<b>WASIX ffmpeg sandbox</b><br/>[@wasmer/sdk workers]"]:::container
    end
    subgraph scrollproc [Node.js process]
      scrollcli["<b>scroll build</b>"]:::external
    end
    cache[("<b>Package cache</b><br/>~/.cache/static-site-hls")]:::container
    repo[("<b>Site working tree</b><br/>[git]<br/>.scroll, videos, HTML, data folder")]:::external
  end

  subgraph hosting [Static web host: GitHub Pages, Netlify, S3, …]
    published[("<b>Published site</b><br/>HTML, data folder, original videos")]:::external
  end

  subgraph device [Visitor's device: browser]
    player["<b>Player + hls.js</b>"]:::container
    videoel["<b>video element</b><br/>native HLS or Media Source Extensions"]:::external
  end

  cli -- "in process" --> sandbox
  sandbox -- "loads wasmer/ffmpeg" --> cache
  cli -- "spawns" --> scrollcli
  cli -- "reads, writes" --> repo
  scrollcli -- "writes HTML" --> repo
  repo -- "git push / deploy" --> published
  published -- "page with inlined player" --> player
  published -- "hls.min.js, posters" --> player
  published -- "playlists, segments" --> videoel
  player -- "attaches" --> videoel

  classDef container fill:#438dd5,stroke:#3c7fc0,color:#fff
  classDef external fill:#999,stroke:#6b6b6b,color:#fff
  style machine fill:none,stroke:#444,stroke-dasharray:5 5
  style nodeproc fill:none,stroke:#888,stroke-dasharray:3 3
  style scrollproc fill:none,stroke:#888,stroke-dasharray:3 3
  style hosting fill:none,stroke:#444,stroke-dasharray:5 5
  style device fill:none,stroke:#444,stroke-dasharray:5 5
```

The original video files stay in the site and are deployed with it: they are the conversion sources, and pages fall back to them for videos that can't be converted.

## Module map

| Module | C4 component | Responsibility | Uses |
| --- | --- | --- | --- |
| `bin/static-site-hls.js` | CLI | Commands, options, prompts, output | `index.js`, `serve.js` |
| `src/index.js` | (public API) | Re-exports | the modules below |
| `src/scan.js` | Planner | `scan()` → `ScanPlan` | index store, parser, layout |
| `src/apply.js` | Executor | `apply()` → `ApplyResult` | every component |
| `src/scroll.js` | Scroll source parser | Find .scroll files, `analyzeScroll()`, `applyEdits()`, URL mapping | layout |
| `src/rewrite.js` | Source rewriter | `pageEdits()` (pure) | parser (`urlFor`) |
| `src/index-store.js` | Index store | `readIndex()`, `migrateIndex()`, `writeIndex()` | migrations, validate |
| `src/migrations.js` | Index store | Ordered index migrations | none |
| `src/validate.js` | Index store | Ajv validators for `schemas/*.json` | schemas |
| `src/convert.js` | Converter | `openConverter()`; runtime-agnostic (Node or browser) | a @wasmer/sdk client passed in |
| `src/player-install.js` | Player installer | `installPlayer()` | validate, layout |
| `src/scroll-build.js` | Scroll builder | `scrollBuild()` | layout |
| `src/serve.js` | Local server | `serve()` | none |
| `src/player.js` | Player | Browser script, installed into sites | none |
| `src/layout.js` | (shared) | File and folder names, `siteFolder()` | convert (output names) |

## Design decisions

- **Scroll sources, not HTML.** A Scroll site's HTML is generated, so edits to it would be overwritten by the next build. The tool rewrites the `.scroll` files and lets `scroll build` produce the HTML. See [scroll-integration.md](scroll-integration.md).
- **WASIX ffmpeg, stream copy.** The `wasmer/ffmpeg` WASIX build runs anywhere @wasmer/sdk runs (Node or a browser), with no native install. It has no H.264 encoder, so video is copied into HLS rather than re-encoded. That is lossless and fast, but sources must already be H.264, and segment lengths follow the sources' keyframes.
- **One persisted, versioned index.** Everything later runs need to know lives in `index.json`, validated against a JSON Schema on every read and write and migrated from older versions automatically. See [data-model.md](data-model.md).
- **Plan, then apply.** `scan()` only reads, so `static-site-hls scan` and the confirmation prompt show exactly what `convert` will do. `apply()` takes that plan; nothing is re-decided while files are being written.
- **Inlined player.** Scroll's `inlineJs` copies the player into each page: no extra request before the video, and it runs before the page's own scripts, so it can take over `video.src` assignments. The cost: pages must be rebuilt when the player changes, which `apply()` does.
- **Posters from the player.** Scroll's `video` lines can't carry a `poster` attribute, and pages often set `video.src` from script. Setting the poster where the playlist URL becomes known covers both.
