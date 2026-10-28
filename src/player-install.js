// Installs the browser-side assets into the data folder: the player script with
// its config written in, and hls.js.
import { copyFile, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { HLS_JS_FILE, PLAYER_FILE, sitePath } from "./layout.js"
import { assertPlayerConfig } from "./validate.js"

const PLAYER_SOURCE = fileURLToPath(new URL("./player.js", import.meta.url))
const HLS_JS_SOURCE = fileURLToPath(import.meta.resolve("hls.js/dist/hls.min.js"))
const CONFIG_LITERAL = /\/\*CONFIG\*\/ \{[^}]*\}/

/**
 * Player settings (schemas/player-config.schema.json).
 * @typedef {{ dataDir: string, videosDir: string, posters: boolean }} PlayerConfig
 */

/** The player script's source with `config` written into its CONFIG literal. */
export async function renderPlayer(config) {
  assertPlayerConfig(config)
  const source = await readFile(PLAYER_SOURCE, "utf8")
  if (!CONFIG_LITERAL.test(source)) throw new Error(`${PLAYER_SOURCE} has no /*CONFIG*/ literal`)
  return source.replace(CONFIG_LITERAL, `/*CONFIG*/ ${JSON.stringify(config)}`)
}

/**
 * Write <dataDir>/static-site-hls.js and <dataDir>/hls.min.js.
 * @param {string} root site root
 * @param {PlayerConfig} config
 * @returns {Promise<{ playerChanged: boolean }>} whether the player script's
 *   bytes changed; built pages hold a copy of it and need rebuilding then
 */
export async function installPlayer(root, config) {
  const playerFile = sitePath(root, path.posix.join(config.dataDir, PLAYER_FILE))
  const player = await renderPlayer(config)
  const playerChanged = player !== (await readFile(playerFile, "utf8").catch(() => null))
  if (playerChanged) await writeFile(playerFile, player)
  await copyFile(HLS_JS_SOURCE, sitePath(root, path.posix.join(config.dataDir, HLS_JS_FILE)))
  return { playerChanged }
}
