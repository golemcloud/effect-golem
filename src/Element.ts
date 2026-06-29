/**
 * @since 1.5.0
 */
import { Effect, Schema } from "effect"
import type * as AgentCommon from "golem:agent/common@1.5.0"
import type * as CoreTypes from "golem:core/types@1.5.0"
import type { WitCodec } from "./WitCodec.js"

/**
 * `ElementCodec<T>` is the boundary between an Effect Schema-driven user
 * value of type `T` and a Golem `ElementValue` (one slot of a `DataValue`
 * tuple or multimodal payload).
 *
 * It abstracts over the **kind** of element schema:
 *
 * - `component-model` — the value is encoded via a `WitCodec` and carried
 *   as a `WitValue`. This is what every "ordinary" `Schema.Top` collapses
 *   to (see {@link componentModelElement}).
 * - `unstructured-text` / `unstructured-binary` — the value is a
 *   `TextReference` / `BinaryReference` carried directly as the
 *   element-value payload; no `WitValue` is involved. Implemented by
 *   factories under `effect-golem` (see step 6/7 of the gap plan).
 *
 * Keeping the codec narrow at this layer means the rest of the SDK
 * (method/agent/client) speaks a single uniform shape per parameter slot
 * regardless of which element kind it is.
 *
 * @since 1.5.0
 * @category codecs
 */
export interface ElementCodec<T> {
  /** The schema as it appears inside a `DataSchema.tuple` / `DataSchema.multimodal`. */
  readonly elementSchema: AgentCommon.ElementSchema
  /** Encode a user-side value to an `ElementValue` for the host call. */
  readonly encode: (value: T) => Effect.Effect<CoreTypes.ElementValue, Schema.SchemaError>
  /** Decode an incoming `ElementValue` back into a user-side value. */
  readonly decode: (
    element: CoreTypes.ElementValue,
  ) => Effect.Effect<T, Schema.SchemaError | ElementValueKindError>
}

/**
 * Raised by `ElementCodec.decode` when the incoming `ElementValue.tag`
 * doesn't match what the codec expects (e.g. a `component-model` codec
 * receives an `unstructured-text` value).
 *
 * @since 1.5.0
 * @category errors
 */
export class ElementValueKindError {
  readonly _tag = "ElementValueKindError"
  constructor(
    readonly expected: AgentCommon.ElementSchema["tag"],
    readonly actual: CoreTypes.ElementValue["tag"],
    readonly context?: string,
  ) {}
}

/**
 * Lift a `WitCodec<S>` to the `ElementCodec<S["Type"]>` that wraps the
 * underlying `WitValue` in `{ tag: "component-model", val: ... }`.
 *
 * @since 1.5.0
 * @category constructors
 */
export const componentModelElement = <S extends Schema.Top>(
  _witCodec: WitCodec<S>,
  _context?: string,
): ElementCodec<S["Type"]> => ({
  // TODO(phase-5): the element-value / data-schema layer is removed in the new
  // model — `WitCodec` no longer carries an `elementSchema`, and values flow as a
  // `schema-value-tree`. Multimodal/Unstructured will be redesigned onto `text`/
  // `binary` schema nodes + role metadata; until then this lifter is inert.
  elementSchema: {
    tag: "component-model",
    val: { nodes: [] },
  } as unknown as AgentCommon.ElementSchema,
  encode: () =>
    Effect.die(
      new Error("componentModelElement: not yet migrated to the new schema model (Phase 5)"),
    ),
  decode: () =>
    Effect.die(
      new Error("componentModelElement: not yet migrated to the new schema model (Phase 5)"),
    ),
})
