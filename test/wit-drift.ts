/**
 * Type-only drift detection for WIT-originated types that the SDK
 * re-shapes into a richer JS / Effect / Schema surface.
 *
 * Each entry below pins a relationship between an SDK construct and
 * its underlying WIT type — derived from real code on BOTH sides, so
 * the assertion only fires when the WIT side actually drifts away
 * from what the wrapper still claims to mirror. Hand-written copies
 * of d.ts shapes are not allowed here: that is just a host-API
 * snapshot under another name (see AGENTS.md "WIT-drift suite").
 *
 * Variant-tag exhaustiveness checks for namespace constructors
 * (`PersistenceLevel`, `FunctionType`, `RevertTarget`, `Filter`, …)
 * live ALONGSIDE the wrappers themselves as `satisfies Record<TagUnion,
 * unknown>` clauses; on regen of `golem-types/*.d.ts`, a new variant
 * trips the `satisfies` clause directly at the wrapper file. This
 * file therefore only carries shape-pins for SDK Schema codecs
 * mirroring WIT records.
 *
 * Consumed solely by `tsc --noEmit` (run via `npm run typecheck`);
 * vitest does not pick it up because the name does not end in
 * `.test.ts`.
 */

import * as Unstructured from "../src/Unstructured.js"
import type * as CoreTypes from "golem:core/types@1.5.0"

/**
 * Structural mutual-assignability check, recursively normalising
 * `readonly` modifiers. Schema-codec `.Type` projections add
 * `readonly` to every field while WIT records are emitted as
 * mutable, so a strict invariant `Equal` would always fail; we
 * only care that the two shapes are interchangeable at the wire.
 */
type Mutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlyArray<infer U>
    ? Array<Mutable<U>>
    : T extends object
      ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T

type StructEqual<A, B> = [Mutable<A>] extends [Mutable<B>]
  ? [Mutable<B>] extends [Mutable<A>]
    ? true
    : false
  : false

/**
 * Forces every value in the supplied record to be `true`. Concrete
 * mismatches surface in the type-checker error message with the
 * record's key naming the offending symbol.
 */
type AssertAllTrue<T extends Record<string, true>> = T

/**
 * In the `golem:core/types@2.0.0` model a quota-token is an opaque, affine
 * capability handle (`own<quota-token>`), not a record-serializable struct, so
 * there is no record-shaped Schema codec to pin here — the wire carrier and
 * affine validation live in `src/internal/schema-model/wit.ts` instead.
 */

/**
 * Schema codecs in `src/unstructured.ts` that mirror the
 * `golem:core/types@1.5.0` text / binary descriptors used by
 * `Unstructured*` element specs. The `_tag`-discriminated unions
 * (`TextReference` / `BinaryReference`) are intentionally not pinned
 * here — the SDK's discriminator is `_tag` while WIT's is `tag`, and
 * the wit-codec performs the rename at the wire boundary.
 */
export type _Drift_UnstructuredSchemaCodecs = AssertAllTrue<{
  "Unstructured.TextType": StructEqual<typeof Unstructured.TextType.Type, CoreTypes.TextType>
  "Unstructured.BinaryType": StructEqual<typeof Unstructured.BinaryType.Type, CoreTypes.BinaryType>
  "Unstructured.TextSource": StructEqual<typeof Unstructured.TextSource.Type, CoreTypes.TextSource>
  "Unstructured.BinarySource": StructEqual<
    typeof Unstructured.BinarySource.Type,
    CoreTypes.BinarySource
  >
}>
