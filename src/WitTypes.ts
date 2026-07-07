/**
 * @since 1.5.0
 */
import { Schema, SchemaAST } from "effect"

/**
 * Annotation key used by the codec to override the default WIT primitive
 * type for a numeric schema. Values are the `WitTypeNode` primitive tags
 * without the `prim-` / `-type` decorations: `"u8"`, `"u16"`, `"u32"`,
 * `"u64"`, `"s8"`, `"s16"`, `"s32"`, `"s64"`, `"f32"`, `"f64"`.
 *
 * `Schema.Number` defaults to `f64`, `Schema.BigInt` defaults to `s64`.
 * The helpers below pre-apply the right annotation.
 *
 * @since 1.5.0
 * @category utils
 */
export const witTypeAnnotationKey = "effect-golem/witType"

/**
 * Numeric WIT primitive a schema can be pinned to via
 * {@link witTypeAnnotationKey}.
 *
 * @since 1.5.0
 * @category models
 */
export type WitNumericKind =
  | "u8"
  | "u16"
  | "u32"
  | "u64"
  | "s8"
  | "s16"
  | "s32"
  | "s64"
  | "f32"
  | "f64"

const tag = (kind: WitNumericKind) => ({ [witTypeAnnotationKey]: kind })

/**
 * Annotation key carrying inline numeric min/max/unit restrictions on a numeric
 * pin schema. The codec lowers it to the WIT `numeric-restrictions` payload.
 *
 * @since 1.6.0
 * @category utils
 */
export const witNumericRestrictionsKey = "effect-golem/witNumericRestrictions"

/**
 * User input for {@link restrict}: inclusive `min`/`max` bounds (+ optional
 * display `unit`).
 *
 * @since 1.6.0
 * @category models
 */
export interface NumericRestrictionsInput {
  readonly min?: number | bigint
  readonly max?: number | bigint
  readonly unit?: string
}

/**
 * Restrict a numeric pin to an inclusive `min`/`max` range (+ optional display
 * `unit`), e.g. `Uint8.pipe(restrict({ min: 1, max: 200 }))` or
 * `Schema.Number.pipe(restrict({ max: 100 }))`.
 *
 * The bounds are BOTH (a) enforced at runtime — a value outside the range is
 * rejected during `Schema.decode`/`encode`, i.e. on the invocation boundary —
 * and (b) lowered into the agent-type schema as `numeric-restrictions` for the
 * host. `restrict` accepts ONLY numeric schemas (`number`/`bigint`); applying it
 * to a `String`/`Boolean`/record schema is a compile-time error.
 *
 * @since 1.6.0
 * @category codecs
 */
export const restrict =
  (opts: NumericRestrictionsInput) =>
  <S extends Schema.Schema<number> | Schema.Schema<bigint>>(self: S): S => {
    // Public signature pins `self` to numeric; internal casts thread the
    // number/bigint filter variants through Effect's invariant `.check`.
    let out: any = self
    if (opts.min !== undefined) {
      out = out.check(
        typeof opts.min === "bigint"
          ? Schema.isGreaterThanOrEqualToBigInt(opts.min)
          : Schema.isGreaterThanOrEqualTo(opts.min),
      )
    }
    if (opts.max !== undefined) {
      out = out.check(
        typeof opts.max === "bigint"
          ? Schema.isLessThanOrEqualToBigInt(opts.max)
          : Schema.isLessThanOrEqualTo(opts.max),
      )
    }
    // The codec resolves annotations off the *last* check only. Adding the bound
    // checks above shifts the "last check", so re-carry the pin's `witType` tag
    // (if any) onto this final annotation layer next to the restrictions — else
    // the codec would lose the width and fall back to f64/s64.
    const kind = (
      SchemaAST as unknown as {
        resolveAt: <T>(k: string) => (a: SchemaAST.AST) => T | undefined
      }
    ).resolveAt<WitNumericKind>(witTypeAnnotationKey)((self as Schema.Top).ast)
    const annotations: Record<string, unknown> = { [witNumericRestrictionsKey]: opts }
    if (kind !== undefined) annotations[witTypeAnnotationKey] = kind
    return out.pipe(Schema.annotate(annotations)) as S
  }

/**
 * Integer pin: `Schema.Int` (rejects non-integers/NaN/Infinity) narrowed to the
 * WIT width's inclusive range, then tagged. Enforced on the invocation boundary.
 */
const intPin = (kind: WitNumericKind, min: number, max: number) =>
  Schema.Int.check(Schema.isBetween({ minimum: min, maximum: max })).pipe(
    Schema.annotate(tag(kind)),
  )

/** BigInt pin: `Schema.BigInt` narrowed to the WIT width's inclusive range, then tagged. */
const bigPin = (kind: WitNumericKind, min: bigint, max: bigint) =>
  Schema.BigInt.check(
    Schema.isGreaterThanOrEqualToBigInt(min),
    Schema.isLessThanOrEqualToBigInt(max),
  ).pipe(Schema.annotate(tag(kind)))

/**
 * WIT `u8` (`number`, integer 0..255).
 *
 * @since 1.5.0
 * @category codecs
 */
export const Uint8 = intPin("u8", 0, 255)

/**
 * WIT `u16` (`number`, integer 0..65535).
 *
 * @since 1.5.0
 * @category codecs
 */
export const Uint16 = intPin("u16", 0, 65535)

/**
 * WIT `u32` (`number`, integer 0..2^32-1).
 *
 * @since 1.5.0
 * @category codecs
 */
export const Uint32 = intPin("u32", 0, 4294967295)

/**
 * WIT `s8` (`number`, integer -128..127).
 *
 * @since 1.5.0
 * @category codecs
 */
export const Int8 = intPin("s8", -128, 127)

/**
 * WIT `s16` (`number`, integer -32768..32767).
 *
 * @since 1.5.0
 * @category codecs
 */
export const Int16 = intPin("s16", -32768, 32767)

/**
 * WIT `s32` (`number`, integer -2^31..2^31-1).
 *
 * @since 1.5.0
 * @category codecs
 */
export const Int32 = intPin("s32", -2147483648, 2147483647)

/**
 * WIT `f32` (`number`, 32-bit float).
 *
 * @since 1.5.0
 * @category codecs
 */
export const Float32 = Schema.Number.pipe(Schema.annotate(tag("f32")))

/**
 * WIT `f64` (`number`, 64-bit float). Same default as `Schema.Number`.
 *
 * @since 1.5.0
 * @category codecs
 */
export const Float64 = Schema.Number.pipe(Schema.annotate(tag("f64")))

/**
 * WIT `s64` (`bigint`). Same default as `Schema.BigInt`.
 *
 * @since 1.5.0
 * @category codecs
 */
export const Int64 = bigPin("s64", -9223372036854775808n, 9223372036854775807n)

/**
 * WIT `u64` (`bigint`, non-negative).
 *
 * @since 1.5.0
 * @category codecs
 */
export const Uint64 = bigPin("u64", 0n, 18446744073709551615n)

/**
 * WIT `char` — a single Unicode scalar value, carried as a JS one-character
 * `string`. Built on top of `Schema.Char` so length-1 validation runs as
 * part of the user schema; the codec sees the `effect-golem/witType: "char"`
 * annotation and emits `prim-char-type` / `prim-char` accordingly.
 *
 * @since 1.5.0
 * @category codecs
 */
export const Char = Schema.Char.pipe(Schema.annotate({ [witTypeAnnotationKey]: "char" }))

/**
 * Annotation key carrying the *name* of a variant case for a
 * `Schema.Union(...)` member compiled to a generic WIT `variant`. When
 * absent, the codec auto-names cases `case0..caseN`.
 *
 * **Example**
 *
 * ```ts
 * Schema.Union(
 *   Schema.String.pipe(withVariantCaseName("text")),
 *   Schema.Number.pipe(withVariantCaseName("count")),
 * )
 * // → variant { text(string), count(f64) }
 * ```
 *
 * @since 1.5.0
 * @category utils
 */
export const variantCaseNameAnnotationKey = "effect-golem/variantCaseName"

/**
 * Annotate a schema with the variant case name to use when it appears
 * inside a `Schema.Union(...)` mapped to a WIT `variant`.
 *
 * @since 1.5.0
 * @category combinators
 */
export const withVariantCaseName = (name: string) =>
  Schema.annotate({ [variantCaseNameAnnotationKey]: name })

/**
 * Annotation key carrying a typed-array hint: `"u8" | "i8" | "u16" | "i16"
 * | "u32" | "i32" | "f32" | "f64" | "big-i64" | "big-u64"`.
 *
 * Schemas annotated with this key are emitted by the codec as a WIT
 * `list<primN>` (or `list<sN>`/`list<f32>` …) and reconstructed back to
 * the corresponding TypedArray subclass on decode.
 *
 * @since 1.5.0
 * @category utils
 */
export const witTypedArrayAnnotationKey = "effect-golem/witTypedArray"

/**
 * Typed-array element kind a schema can be pinned to via
 * {@link witTypedArrayAnnotationKey}.
 *
 * @since 1.5.0
 * @category models
 */
export type WitTypedArrayKind =
  | "u8"
  | "i8"
  | "u16"
  | "i16"
  | "u32"
  | "i32"
  | "f32"
  | "f64"
  | "big-i64"
  | "big-u64"

/**
 * Annotation key marking a schema as the opaque `quota-token` capability
 * node. Schemas carrying this annotation are compiled by the codec to the
 * schema-model `quota-token` type (`t.quotaToken`) and their values bridge the
 * host `QuotaToken` (an owned `own<quota-token>` resource) to/from a
 * `v.quotaToken(handle)` schema value.
 *
 * Unlike the numeric / typed-array hints there is no payload — the presence of
 * the key alone selects the quota-token shape.
 *
 * @since 1.5.0
 * @category utils
 */
export const witQuotaTokenAnnotationKey = "effect-golem/witQuotaToken"

/**
 * Annotation key marking a schema as a `principal` value carried as ordinary
 * structured data (the WIT `golem:agent/common` `principal` variant —
 * `oidc` / `agent` / `golem-user` / `anonymous`). Schemas carrying this
 * annotation are compiled by the codec to that variant type and their values
 * round-trip a host `Principal` to/from the corresponding `SchemaValue`.
 *
 * Unlike the numeric / typed-array hints there is no payload — the presence of
 * the key alone selects the principal shape. See {@link Principal.PrincipalSchema}.
 *
 * @since 1.6.0
 * @category utils
 */
export const witPrincipalAnnotationKey = "effect-golem/witPrincipal"

const typedArraySchema = <T>(kind: WitTypedArrayKind, ctor: new (...args: any[]) => T) =>
  Schema.declare((u): u is T => u instanceof ctor).pipe(
    Schema.annotate({ [witTypedArrayAnnotationKey]: kind }),
  )

/**
 * WIT `list<u8>` carried as a JS `Uint8Array`.
 *
 * @since 1.5.0
 * @category codecs
 */
export const Uint8ArraySchema = typedArraySchema<Uint8Array>("u8", Uint8Array)

/**
 * WIT `list<s8>` carried as a JS `Int8Array`.
 *
 * @since 1.5.0
 * @category codecs
 */
export const Int8ArraySchema = typedArraySchema<Int8Array>("i8", Int8Array)

/**
 * WIT `list<u16>` carried as a JS `Uint16Array`.
 *
 * @since 1.5.0
 * @category codecs
 */
export const Uint16ArraySchema = typedArraySchema<Uint16Array>("u16", Uint16Array)

/**
 * WIT `list<s16>` carried as a JS `Int16Array`.
 *
 * @since 1.5.0
 * @category codecs
 */
export const Int16ArraySchema = typedArraySchema<Int16Array>("i16", Int16Array)

/**
 * WIT `list<u32>` carried as a JS `Uint32Array`.
 *
 * @since 1.5.0
 * @category codecs
 */
export const Uint32ArraySchema = typedArraySchema<Uint32Array>("u32", Uint32Array)

/**
 * WIT `list<s32>` carried as a JS `Int32Array`.
 *
 * @since 1.5.0
 * @category codecs
 */
export const Int32ArraySchema = typedArraySchema<Int32Array>("i32", Int32Array)

/**
 * WIT `list<f32>` carried as a JS `Float32Array`.
 *
 * @since 1.5.0
 * @category codecs
 */
export const Float32ArraySchema = typedArraySchema<Float32Array>("f32", Float32Array)

/**
 * WIT `list<f64>` carried as a JS `Float64Array`.
 *
 * @since 1.5.0
 * @category codecs
 */
export const Float64ArraySchema = typedArraySchema<Float64Array>("f64", Float64Array)

/**
 * WIT `list<s64>` carried as a JS `BigInt64Array`.
 *
 * @since 1.5.0
 * @category codecs
 */
export const BigInt64ArraySchema = typedArraySchema<BigInt64Array>("big-i64", BigInt64Array)

/**
 * WIT `list<u64>` carried as a JS `BigUint64Array`.
 *
 * @since 1.5.0
 * @category codecs
 */
export const BigUint64ArraySchema = typedArraySchema<BigUint64Array>("big-u64", BigUint64Array)
