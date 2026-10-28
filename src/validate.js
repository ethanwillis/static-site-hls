// Validation against the JSON Schemas in schemas/. Everything static-site-hls
// persists in a site, or embeds in its pages, is checked here on the way in and
// on the way out.
import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"
import indexV1 from "../schemas/index.v1.schema.json" with { type: "json" }
import indexV2 from "../schemas/index.v2.schema.json" with { type: "json" }
import playerConfig from "../schemas/player-config.schema.json" with { type: "json" }

const ajv = new Ajv2020({ allErrors: true, discriminator: true })
addFormats(ajv)

const INDEX_VALIDATORS = new Map([
  [1, ajv.compile(indexV1)],
  [2, ajv.compile(indexV2)],
])
const PLAYER_CONFIG_VALIDATOR = ajv.compile(playerConfig)

/** Index versions with a schema, oldest first. */
export const INDEX_VERSIONS = [...INDEX_VALIDATORS.keys()]

export class SchemaError extends Error {
  name = "SchemaError"
}

function check(validate, data, what) {
  if (validate(data)) return data
  const problems = new Set(validate.errors.map((error) => `${error.instancePath || "(root)"} ${error.message}`))
  throw new SchemaError(`${what} doesn't match its schema:\n  ${[...problems].join("\n  ")}`)
}

/**
 * Throw a SchemaError unless `data` is a valid index of `version`; else return it.
 * @param {unknown} data
 * @param {number} version
 * @param {string} what description for the error message
 */
export function assertIndex(data, version, what = `index (version ${version})`) {
  const validate = INDEX_VALIDATORS.get(version)
  if (!validate) throw new SchemaError(`${what}: unknown index version ${JSON.stringify(version)}`)
  return check(validate, data, what)
}

/** Throw a SchemaError unless `data` is a valid player config; else return it. */
export const assertPlayerConfig = (data) => check(PLAYER_CONFIG_VALIDATOR, data, "player config")
