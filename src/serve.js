// Local static server for testing a site's HLS output. Sends the HLS content
// types, and `cache-control: no-cache`: every request is revalidated, so
// re-converted videos show up at once, while back/forward cache still works
// (`no-store` would disable it and skew Lighthouse results).
import { createServer } from "node:http"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
}

/**
 * Serve `root` on `port` until the process exits. Resolves with the server once listening.
 * @param {(line: string) => void} [log] called for every request
 */
export function serve(root, { port = 8080, log = console.log } = {}) {
  root = path.resolve(root)
  const server = createServer(async (req, res) => {
    let pathname
    try {
      pathname = decodeURIComponent(req.url.split(/[?#]/, 1)[0])
    } catch {
      return res.writeHead(400).end()
    }
    let file = path.join(root, path.normalize(pathname))
    if (file !== root && !file.startsWith(root + path.sep)) return res.writeHead(403).end()
    try {
      if ((await stat(file)).isDirectory()) {
        if (!pathname.endsWith("/")) return res.writeHead(301, { location: pathname + "/" }).end()
        file = path.join(file, "index.html")
      }
      const body = await readFile(file)
      res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-cache" }).end(body)
      log(`200 ${pathname}`)
    } catch {
      res.writeHead(404).end()
      log(`404 ${pathname}`)
    }
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, () => resolve(server))
  })
}
