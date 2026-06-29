/**
 * Host service for the `getConfigValue` subset of
 * `golem:agent/host@1.5.0`. Wraps the synchronous host call into an
 * Effect-typed surface so SDK code can read agent config via DI rather
 * than reaching directly into the imported namespace.
 *
 * @internal — not re-exported from `src/index.ts`.
 */
import { Context, Layer } from "effect"
import * as AgentHost from "golem:agent/host@2.0.0"
import type { SchemaGraph, SchemaValueTree } from "golem:core/types@2.0.0"

export interface ConfigClientShape {
  /**
   * Mirrors `golem:agent/host.get-config-value` — the host resolves the config
   * key against the expected `schema-graph` and returns a `schema-value-tree`.
   * Errors thrown by the host become Effect defects (caught at the call site by
   * `compileConfig` and turned into a `ConfigError({ _tag: "HostTrap" })`).
   */
  readonly getConfigValue: (key: ReadonlyArray<string>, expected: SchemaGraph) => SchemaValueTree
}

export class ConfigClient extends Context.Service<ConfigClient, ConfigClientShape>()(
  "effect-golem/host/Config",
) {}

export const ConfigLive: Layer.Layer<ConfigClient> = Layer.succeed(
  ConfigClient,
  ConfigClient.of({
    getConfigValue: (key, expected) => AgentHost.getConfigValue([...key], expected),
  }),
)
