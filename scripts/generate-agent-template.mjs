#!/usr/bin/env node
/**
 * Generates the Rust wrapper crate that embeds the bundled effect-golem
 * runtime into a QuickJS-backed WASM component, leaving a `user` slot to
 * be filled in later via `wasm-rquickjs inject-js`.
 *
 * Mirrors the corresponding script in golemcloud/golem's
 * sdks/ts/packages/golem-ts-sdk.
 */
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { existsSync, rmSync, readFileSync, writeFileSync } from "node:fs"

// ---------------------------------------------------------------------------
// The generated wrapper crate must build its WIT bindings with Golem's forked
// wit-bindgen ("outline-lift"), which shrinks the giant generated lift/lower
// wrappers the golem:core@2.0.0 schema model produces. wasm-rquickjs hardcodes
// the upstream wit-bindgen version, so we rewrite the manifest after generation.
// ---------------------------------------------------------------------------
const WIT_BINDGEN_GIT = "https://github.com/golemcloud/wit-bindgen"
const WIT_BINDGEN_BRANCH = "golem-outline-lift-v0.58.0"

function useForkedWitBindgen(cargoTomlPath) {
  const original = readFileSync(cargoTomlPath, "utf8")
  const witBindgenLine =
    'wit-bindgen = { version = "0.42.1", default-features = false, features = ["macros"] }'
  const witBindgenRtLine = 'wit-bindgen-rt = { version = "0.42.1", features = ["bitflags"] }'
  const forkedLine = `wit-bindgen = { git = "${WIT_BINDGEN_GIT}", branch = "${WIT_BINDGEN_BRANCH}", version = "=0.58.0", default-features = false, features = ["macros"] }`

  if (original.split(witBindgenLine).length - 1 !== 1) {
    throw new Error(
      `Expected exactly one wit-bindgen dependency line in ${cargoTomlPath}; the wasm-rquickjs skeleton may have changed.`,
    )
  }
  if (original.split(witBindgenRtLine).length - 1 !== 1) {
    throw new Error(
      `Expected exactly one wit-bindgen-rt dependency line in ${cargoTomlPath}; the wasm-rquickjs skeleton may have changed.`,
    )
  }

  // The forked wit-bindgen embeds its own runtime, so drop the separate
  // wit-bindgen-rt crate.
  const updated = original.replace(`${witBindgenRtLine}\n`, "").replace(witBindgenLine, forkedLine)
  if (!updated.includes(WIT_BINDGEN_GIT) || updated.includes(witBindgenRtLine)) {
    throw new Error(`Failed to rewrite the wit-bindgen dependency in ${cargoTomlPath}.`)
  }
  writeFileSync(cargoTomlPath, updated)

  // The wasm-rquickjs Cargo.lock pins upstream wit-bindgen deps that conflict
  // with the fork; drop it and let cargo resolve a fresh lock at build time.
  rmSync(join(cargoTomlPath, "..", "Cargo.lock"), { force: true })
}

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "..")
const wit = resolve(root, "wit")
const output = resolve(root, "agent-template")
const sdkBundle = resolve(root, "dist/index.mjs")
const effectBundle = resolve(root, "dist/effect.mjs")
const sqliteBundle = resolve(root, "dist/sqlite.mjs")
const postgresBundle = resolve(root, "dist/postgres.mjs")
const mysqlBundle = resolve(root, "dist/mysql.mjs")
const igniteBundle = resolve(root, "dist/ignite.mjs")

for (const f of [
  sdkBundle,
  effectBundle,
  sqliteBundle,
  postgresBundle,
  mysqlBundle,
  igniteBundle,
]) {
  if (!existsSync(f)) {
    console.error(`error: ${f} does not exist. Run "npm run build:bundle" first.`)
    process.exit(1)
  }
}

if (existsSync(output)) {
  rmSync(output, { recursive: true, force: true })
}

const result = spawnSync(
  "wasm-rquickjs",
  [
    "generate-wrapper-crate",
    "--wit",
    wit,
    "--output",
    output,
    "--world",
    "agent-guest",
    "--js-modules",
    `effect-golem=${sdkBundle}`,
    "--js-modules",
    `effect-golem/sqlite=${sqliteBundle}`,
    "--js-modules",
    `effect-golem/postgres=${postgresBundle}`,
    "--js-modules",
    `effect-golem/mysql=${mysqlBundle}`,
    "--js-modules",
    `effect-golem/ignite2=${igniteBundle}`,
    "--js-modules",
    `effect=${effectBundle}`,
    "--js-modules",
    "user=@slot",
  ],
  { stdio: "inherit", cwd: root },
)

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

// Swap the skeleton's upstream wit-bindgen for Golem's outline-lift fork.
useForkedWitBindgen(resolve(output, "Cargo.toml"))

// Workaround: the generated `JS_ADDITIONAL_MODULES` Vec expects each
// closure to return `String`, but for static (non-`@slot`) modules
// wasm-rquickjs emits `include_str!(...)` which yields `&'static str`.
// Coerce them with `.to_string()` so cargo will compile the crate.
const libRsPath = resolve(output, "src/lib.rs")
const original = readFileSync(libRsPath, "utf-8")
const patched = original.replace(
  /Box::new\(\|\|\s*\{\s*include_str!\("([^"]+)"\)\s*\}\)/g,
  'Box::new(|| { include_str!("$1").to_string() })',
)
if (patched !== original) {
  writeFileSync(libRsPath, patched, "utf-8")
  console.log("patched JS_ADDITIONAL_MODULES include_str! to .to_string()")
}
