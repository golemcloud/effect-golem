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
 * trips the `satisfies` clause directly at the wrapper file.
 *
 * Consumed solely by `tsc --noEmit` (run via `npm run typecheck`);
 * vitest does not pick it up because the name does not end in
 * `.test.ts`.
 *
 * In the `golem:core/types@2.0.0` model there are currently no
 * record-shaped SDK Schema codecs that mirror a WIT record 1:1:
 *
 * - A quota-token is an opaque, affine capability handle
 *   (`own<quota-token>`); its wire carrier + affine validation live in
 *   `src/internal/schema-model/wit.ts`.
 * - The `Unstructured*` element specs no longer expose wire-shape Schema
 *   codecs (`TextType` / `BinaryType` / …); they project directly to
 *   `text` / `binary` / `url` schema-type nodes inside a `variant`, with
 *   the value codec living in `src/Unstructured.ts`.
 *
 * Pins will be re-added here when a future SDK construct again mirrors a
 * WIT record by hand.
 */

export {}
