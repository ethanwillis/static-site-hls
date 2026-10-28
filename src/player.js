// static-site-hls player, installed into the site by @lessconversation/static-site-hls
// and inlined into pages with Scroll's `inlineJs`, so it costs no extra request
// and runs before the page's own scripts.
//
// For every <video> whose src or first HLS <source> is a static-site-hls
// playlist, and for scripts that assign `video.src = "….m3u8"`, it:
// - sets the video's poster to the playlist's poster.jpg (unless the page set its
//   own), so a frame shows before the first segment has downloaded;
// - in browsers without native HLS, loads hls.min.js from the data folder on
//   first use and attaches it.
;(() => {
  // Written by static-site-hls when it installs this file.
  const CONFIG = /*CONFIG*/ { dataDir: "static-site-hls", videosDir: "videos", posters: true }
  const HLS_URL = /\.m3u8(?:[?#]|$)/i
  const native = Boolean(document.createElement("video").canPlayType("application/vnd.apple.mpegurl"))

  // Playlists live at …/<dataDir>/<videosDir>/<id>/index.m3u8, next to their
  // poster.jpg, and hls.js at …/<dataDir>/hls.min.js.
  const encode = (dir) => dir.split("/").map(encodeURIComponent).join("/")
  const marker = `/${encode(CONFIG.dataDir)}/${encode(CONFIG.videosDir)}/`
  const siteRootOf = (playlist) => {
    const { pathname } = new URL(playlist)
    const at = pathname.lastIndexOf(marker)
    return at < 0 ? null : pathname.slice(0, at)
  }

  // Posters: only ever replace a poster this script set itself.
  const ownPoster = new WeakMap() // video → poster URL set by this script
  const setPoster = (video, playlist) => {
    if (!CONFIG.posters) return
    const current = video.getAttribute("poster")
    if (current !== null && ownPoster.get(video) !== current) return
    const poster = playlist && siteRootOf(playlist) !== null ? new URL("poster.jpg", playlist).href : null
    if (poster === current) return
    if (poster) {
      video.setAttribute("poster", poster)
      ownPoster.set(video, poster)
    } else {
      video.removeAttribute("poster")
      ownPoster.delete(video)
    }
  }

  // hls.js, for browsers without native HLS.
  let loading
  const loadHls = (playlist) => (loading ??= window.Hls
    ? Promise.resolve(window.Hls)
    : new Promise((resolve, reject) => {
        const root = siteRootOf(playlist)
        if (root === null) return reject(new Error(`static-site-hls: ${playlist} is not in ${marker}`))
        const script = document.createElement("script")
        script.src = new URL(`${root}/${encode(CONFIG.dataDir)}/hls.min.js`, playlist).href
        script.onload = () => resolve(window.Hls)
        script.onerror = () => reject(new Error(`static-site-hls: could not load ${script.src}`))
        document.head.append(script)
      }))
  const attached = new WeakMap() // video → { url, hls }
  const detach = (video) => {
    attached.get(video)?.hls?.destroy()
    attached.delete(video)
  }
  const attach = (video, url) => {
    if (attached.get(video)?.url === url) return
    detach(video)
    const entry = { url, hls: null }
    attached.set(video, entry)
    loadHls(url).then((Hls) => {
      if (attached.get(video) !== entry || !Hls?.isSupported()) return
      entry.hls = new Hls()
      entry.hls.loadSource(url)
      entry.hls.attachMedia(video)
    }, console.error)
  }

  // Scripts that assign `video.src`. Without native HLS, playlists are taken
  // over before the browser tries (and fails) to play them; hls.js itself
  // assigns blob: URLs, which pass through.
  const src = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src")
  Object.defineProperty(HTMLMediaElement.prototype, "src", {
    ...src,
    set(value) {
      const url = String(value)
      if (this instanceof HTMLVideoElement && !url.startsWith("blob:")) {
        const playlist = HLS_URL.test(url) ? new URL(url, document.baseURI).href : null
        setPoster(this, playlist)
        if (!native) {
          detach(this) // assigning src always restarts playback, even with the same URL
          if (playlist) return attach(this, playlist)
        }
      }
      src.set.call(this, value)
    },
  })

  // Markup: <video src="….m3u8"> and <video><source src="….m3u8"></video>.
  const playlistOf = (video) => {
    const own = video.getAttribute("src")
    if (own) return HLS_URL.test(own) ? own : null
    for (const source of video.querySelectorAll(":scope > source[src]")) {
      if (HLS_URL.test(source.getAttribute("src"))) return source.getAttribute("src")
    }
    return null
  }
  const update = (video) => {
    const own = video.getAttribute("src")
    // hls.js attaching (blob:) or detaching (src removed) a video it manages.
    if (own?.startsWith("blob:") || (own === null && attached.has(video))) return
    const url = playlistOf(video)
    const playlist = url && new URL(url, document.baseURI).href
    setPoster(video, playlist)
    if (native) return
    if (playlist) attach(video, playlist)
    else detach(video)
  }
  const visit = (node) => {
    if (node.nodeType !== Node.ELEMENT_NODE) return
    if (node instanceof HTMLVideoElement) update(node)
    else if (node.localName === "source" && node.parentElement instanceof HTMLVideoElement) update(node.parentElement)
    else node.querySelectorAll("video").forEach(update)
  }
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") visit(record.target)
      else record.addedNodes.forEach(visit)
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] })
  document.querySelectorAll("video").forEach(update)
})()
