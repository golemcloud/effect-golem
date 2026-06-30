/**
 * @since 1.6.0
 *
 * Compiles an Effect Schema into the `golem:core/types@2.0.0` schema model:
 * a recursive {@link SchemaType} (the WIT type) plus a bidirectional value
 * codec to/from {@link SchemaValue}. The flat wire carriers
 * (`schema-graph` / `schema-value-tree`) are produced from these by
 * `./internal/schema-model/wit.ts` at the dispatch boundary.
 */
import { Effect, HashMap, Option, Result, Schema, SchemaAST, SchemaGetter } from "effect"
import {
  field,
  t,
  v,
  variantCase,
  type NumericBound,
  type NumericRestrictions,
  type SchemaGraph,
  type SchemaType,
  type SchemaValue,
  type VariantCaseType,
} from "./internal/schema-model/model.js"
import { GuestQuotaTokenHandle } from "./internal/schema-model/quotaTokenHandle.js"
import { QUOTA_INTERNAL } from "./internal/schema-model/quotaInternal.js"
import type { QuotaToken as RawQuotaToken } from "golem:core/types@2.0.0"
import {
  variantCaseNameAnnotationKey,
  witNumericRestrictionsKey,
  witQuotaTokenAnnotationKey,
  witTypeAnnotationKey,
  witTypedArrayAnnotationKey,
  type NumericRestrictionsInput,
  type WitNumericKind,
  type WitTypedArrayKind,
} from "./WitTypes.js"

// Branded so `Durability.wrap` (and any other downstream consumer that uses
// nominal SDK-error detection) can route this into the defect channel without
// `_tag`-string sniffing. `Symbol.for(...)` guarantees the same runtime symbol
// across modules.
const sdkErrorBrand: unique symbol = Symbol.for("effect-golem/durable-function/sdk-error")

/**
 * Raised by {@link toWitCodec} (and registration helpers that compile a user
 * schema) when an Effect Schema construct cannot be represented in the Golem
 * schema model.
 *
 * @since 1.6.0
 * @category errors
 */
export class UnsupportedSchemaError {
  readonly _tag = "UnsupportedSchemaError"
  readonly [sdkErrorBrand] = true
  constructor(readonly reason: string) {}
}

/**
 * A pair of pure transforms mirroring a single AST node onto its
 * {@link SchemaValue} representation. They operate on the user schema's
 * **encoded** values, never the decoded domain values — so the user's own
 * decode/encode logic (refinements, transformations, branded types, …) still
 * runs when the full codec is evaluated.
 */
interface ValuePair {
  /** Encoded → schema value. Called during `Schema.encode`. */
  readonly toValue: (encoded: any) => SchemaValue
  /** Schema value → encoded. Called during `Schema.decode`. */
  readonly fromValue: (value: SchemaValue) => any
}

/**
 * The full mapping for a single Effect Schema:
 *
 * - `graph`  — a self-contained `SchemaGraph` (`root` schema type + nominal
 *              defs; defs are empty for the structural shapes we emit)
 * - `isUnit` — true for void/undefined returns (→ WIT `output-schema.unit`);
 *              the graph/codec are placeholders in that case
 * - `codec`  — `Codec<domainType, SchemaValue>`, composed on top of the user's
 *              own schema so refinements/transformations are honoured
 *
 * @since 1.6.0
 * @category codecs
 */
export interface WitCodec<S extends Schema.Top> {
  readonly schema: S
  readonly graph: SchemaGraph
  readonly isUnit: boolean
  readonly codec: Schema.Codec<
    S["Type"],
    SchemaValue,
    S["DecodingServices"],
    S["EncodingServices"]
  >
}

/** Leaf pair for a primitive whose schema value carries a single `value`. */
const primPair = (make: (val: any) => SchemaValue): ValuePair => ({
  toValue: (val) => make(val),
  fromValue: (sv) => (sv as { value: unknown }).value,
})

/**
 * Mapping from a {@link WitNumericKind} annotation to the matching schema-type
 * constructor, schema-value constructor, and a coercion re-shaping the encoded
 * JS value into what the value expects (e.g. `bigint` for `u64`/`s64`).
 */
const numericMapping: Record<
  WitNumericKind,
  { make: (r?: NumericRestrictions) => SchemaType; toV: (v: any) => SchemaValue; coerce: (v: any) => any }
> = {
  u8: { make: t.u8, toV: v.u8, coerce: (v) => v },
  u16: { make: t.u16, toV: v.u16, coerce: (v) => v },
  u32: { make: t.u32, toV: v.u32, coerce: (v) => v },
  u64: { make: t.u64, toV: v.u64, coerce: (v) => (typeof v === "bigint" ? v : BigInt(v as number)) },
  s8: { make: t.s8, toV: v.s8, coerce: (v) => v },
  s16: { make: t.s16, toV: v.s16, coerce: (v) => v },
  s32: { make: t.s32, toV: v.s32, coerce: (v) => v },
  s64: { make: t.s64, toV: v.s64, coerce: (v) => (typeof v === "bigint" ? v : BigInt(v as number)) },
  f32: { make: t.f32, toV: v.f32, coerce: (v) => v },
  f64: { make: t.f64, toV: v.f64, coerce: (v) => v },
}

/**
 * Look up an annotation by key on an AST node. Effect Schema attaches
 * annotations from `Schema.annotate(...)` to the *last check* (refinement),
 * not the AST root, so we delegate to `SchemaAST.resolveAt` which knows the
 * right traversal order.
 */
const annotationOf = <T = unknown>(a: SchemaAST.AST, key: string): T | undefined =>
  (
    SchemaAST as unknown as {
      resolveAt: <U>(k: string) => (a: SchemaAST.AST) => U | undefined
    }
  ).resolveAt<T>(key)(a)

const numericKindOf = (a: SchemaAST.AST): WitNumericKind | undefined =>
  annotationOf<WitNumericKind>(a, witTypeAnnotationKey)

const F64_BITS_VIEW = new DataView(new ArrayBuffer(8))
const f64Bits = (x: number): bigint => {
  // Canonicalize -0.0 to +0.0 so equal bounds compare equal (mirrors the codec).
  F64_BITS_VIEW.setFloat64(0, x === 0 ? 0 : x)
  return F64_BITS_VIEW.getBigUint64(0)
}

/** The `numeric-bound` tag for a numeric pin kind. */
const boundKindOf = (kind: WitNumericKind): "signed" | "unsigned" | "float-bits" =>
  kind[0] === "f" ? "float-bits" : kind[0] === "s" ? "signed" : "unsigned"

const makeBound = (
  boundKind: "signed" | "unsigned" | "float-bits",
  x: number | bigint,
): NumericBound =>
  boundKind === "float-bits"
    ? { tag: "float-bits", val: f64Bits(Number(x)) }
    : { tag: boundKind, val: BigInt(x) }

/** Read inline numeric restrictions (from a `restrict(...)` annotation) for `kind`. */
const numericRestrictionsOf = (
  a: SchemaAST.AST,
  kind: WitNumericKind,
): NumericRestrictions | undefined => {
  const opts = annotationOf<NumericRestrictionsInput>(a, witNumericRestrictionsKey)
  if (!opts || (opts.min === undefined && opts.max === undefined && !opts.unit)) return undefined
  const bk = boundKindOf(kind)
  return {
    min: opts.min !== undefined ? makeBound(bk, opts.min) : undefined,
    max: opts.max !== undefined ? makeBound(bk, opts.max) : undefined,
    unit: opts.unit,
  }
}

const numericNode = (
  kind: WitNumericKind,
  a: SchemaAST.AST,
): { type: SchemaType; pair: ValuePair } => {
  const m = numericMapping[kind]
  return {
    type: m.make(numericRestrictionsOf(a, kind)),
    pair: {
      toValue: (val) => m.toV(m.coerce(val)),
      fromValue: (sv) => (sv as { value: unknown }).value,
    },
  }
}

const isNullOrUndefinedAST = (a: SchemaAST.AST): boolean =>
  a._tag === "Null" || a._tag === "Undefined" || a._tag === "Void"

const isVoidLikeAST = (a: SchemaAST.AST): boolean =>
  a._tag === "Undefined" || a._tag === "Void"

/**
 * A "shape signature" classifying an AST's *encoded* form, used to dispatch
 * encoded values to the matching variant case at encode time and to reject
 * unions whose members would be ambiguous.
 */
interface EncodedShape {
  readonly tag:
    | "string"
    | "number"
    | "boolean"
    | "bigint"
    | "null"
    | "undefined"
    | "literal"
    | "array"
    | "object"
    | "object-with-tag"
    | "unknown"
  readonly literal?: string | number | boolean | bigint
  /** For `object-with-tag`: the discriminator value of the `_tag` field. */
  readonly tagLiteral?: string
  readonly matches: (v: unknown) => boolean
}

/**
 * Compute an `EncodedShape` for a schema AST. Operates on the *encoded* form
 * because the codec walks encoded values, not decoded ones.
 */
const encodedShapeOf = (a: SchemaAST.AST): EncodedShape => {
  switch (a._tag) {
    case "String":
      return { tag: "string", matches: (v) => typeof v === "string" }
    case "Number":
      return { tag: "number", matches: (v) => typeof v === "number" }
    case "Boolean":
      return { tag: "boolean", matches: (v) => typeof v === "boolean" }
    case "BigInt":
      return { tag: "bigint", matches: (v) => typeof v === "bigint" }
    case "Null":
      return { tag: "null", matches: (v) => v === null }
    case "Undefined":
    case "Void":
      return { tag: "undefined", matches: (v) => v === undefined }
    case "Literal": {
      const lit = (a as SchemaAST.Literal).literal
      return {
        tag: "literal",
        literal: lit as EncodedShape["literal"],
        matches: (v) => v === lit,
      }
    }
    case "Arrays":
      return { tag: "array", matches: Array.isArray }
    case "Objects": {
      const tagPs = (a as SchemaAST.Objects).propertySignatures.find((ps) => ps.name === "_tag")
      // Only treat _tag as a discriminator if the property is *required*.
      if (
        tagPs !== undefined &&
        !SchemaAST.isOptional(tagPs.type) &&
        SchemaAST.isLiteral(tagPs.type) &&
        typeof tagPs.type.literal === "string"
      ) {
        const lit = tagPs.type.literal as string
        return {
          tag: "object-with-tag",
          tagLiteral: lit,
          matches: (v) =>
            typeof v === "object" &&
            v !== null &&
            !Array.isArray(v) &&
            (v as { _tag?: unknown })._tag === lit,
        }
      }
      return {
        tag: "object",
        matches: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
      }
    }
    default:
      return { tag: "unknown", matches: () => true }
  }
}

const variantCaseNameOf = (a: SchemaAST.AST): string | undefined =>
  annotationOf<string>(a, variantCaseNameAnnotationKey)

const declarationConstructorTag = (a: SchemaAST.AST): string | undefined => {
  if (a._tag !== "Declaration") return undefined
  const tc = (a.annotations as { typeConstructor?: { _tag?: string } } | undefined)?.typeConstructor
  return tc?._tag
}

const typedArrayKindOf = (a: SchemaAST.AST): WitTypedArrayKind | undefined =>
  annotationOf<WitTypedArrayKind>(a, witTypedArrayAnnotationKey)

const isQuotaTokenAST = (a: SchemaAST.AST): boolean =>
  annotationOf<boolean>(a, witQuotaTokenAnnotationKey) === true

/**
 * Type + value bridge for the opaque `quota-token` capability node. The graph
 * root is `t.quotaToken({})`; the value pair lowers a host `QuotaToken` (a raw
 * owned `own<quota-token>` resource) into `v.quotaToken(handle)` and lifts it
 * back out via `handle.take()`. The take-once cell guarantees the owned handle
 * is moved exactly once; decoding a value whose handle was already consumed
 * throws.
 */
const quotaTokenNode = (): { type: SchemaType; pair: ValuePair } => ({
  type: t.quotaToken({}),
  pair: {
    toValue: (raw) =>
      v.quotaToken(GuestQuotaTokenHandle.fromRaw(QUOTA_INTERNAL, raw as RawQuotaToken)),
    fromValue: (sv) => {
      const handle = (sv as { handle: GuestQuotaTokenHandle }).handle
      const raw = handle.take()
      if (raw === undefined) {
        throw new Error(
          "quota-token handle was already consumed; an owned quota-token can only be decoded once",
        )
      }
      return raw
    },
  },
})

/**
 * Per-typed-array element schema-type/value constructors plus an optional
 * coercion (used to keep `bigint` payloads for s64/u64 arrays without forcing
 * the user to pre-convert).
 */
const typedArrayElement: Record<
  WitTypedArrayKind,
  { make: () => SchemaType; toV: (v: any) => SchemaValue; coerce: (v: unknown) => any }
> = {
  u8: { make: t.u8, toV: v.u8, coerce: (v) => v },
  i8: { make: t.s8, toV: v.s8, coerce: (v) => v },
  u16: { make: t.u16, toV: v.u16, coerce: (v) => v },
  i16: { make: t.s16, toV: v.s16, coerce: (v) => v },
  u32: { make: t.u32, toV: v.u32, coerce: (v) => v },
  i32: { make: t.s32, toV: v.s32, coerce: (v) => v },
  f32: { make: t.f32, toV: v.f32, coerce: (v) => v },
  f64: { make: t.f64, toV: v.f64, coerce: (v) => v },
  "big-i64": {
    make: t.s64,
    toV: v.s64,
    coerce: (v) => (typeof v === "bigint" ? v : BigInt(v as number)),
  },
  "big-u64": {
    make: t.u64,
    toV: v.u64,
    coerce: (v) => (typeof v === "bigint" ? v : BigInt(v as number)),
  },
}

/** Construct the JS TypedArray subclass matching a `WitTypedArrayKind`. */
const typedArrayCtor: Record<WitTypedArrayKind, new (entries: Iterable<any>) => any> = {
  u8: Uint8Array,
  i8: Int8Array,
  u16: Uint16Array,
  i16: Int16Array,
  u32: Uint32Array,
  i32: Int32Array,
  f32: Float32Array,
  f64: Float64Array,
  "big-i64": BigInt64Array,
  "big-u64": BigUint64Array,
}

/**
 * Walk a Schema AST into a recursive {@link SchemaType} plus a top-level
 * {@link ValuePair}. Unlike the WIT-graph model, the type is recursive — the
 * flattening into the indexed `schema-graph` is done later by `GraphEncoder`.
 */
const walk = (
  ast: SchemaAST.AST,
): Effect.Effect<{ type: SchemaType; pair: ValuePair }, UnsupportedSchemaError> =>
  Effect.gen(function* () {
    const unsupported = (reason: string) => Effect.fail(new UnsupportedSchemaError(reason))

    /** Recurse into a child AST, returning its type + pair. */
    const child = (
      a: SchemaAST.AST,
    ): Effect.Effect<{ type: SchemaType; pair: ValuePair }, UnsupportedSchemaError> => nodeFor(a)

    /**
     * Build a record-type node + pair given a list of property signatures.
     * Used for both `Objects` schemas and tagged-variant payloads.
     */
    const recordNode = (
      props: ReadonlyArray<SchemaAST.PropertySignature>,
    ): Effect.Effect<{ type: SchemaType; pair: ValuePair }, UnsupportedSchemaError> =>
      Effect.gen(function* () {
        type Field = {
          readonly name: string
          readonly type: SchemaType
          readonly pair: ValuePair
          readonly optional: boolean
        }
        const fields: Array<Field> = []
        for (const ps of props) {
          if (typeof ps.name !== "string") {
            return yield* unsupported(`non-string property key: ${String(ps.name)}`)
          }
          const { type: rawType, pair: rawPair } = yield* child(ps.type)
          const optional = SchemaAST.isOptional(ps.type)
          if (optional) {
            const pair: ValuePair = {
              toValue: (val) => v.option(val === undefined ? undefined : rawPair.toValue(val)),
              fromValue: (sv) => {
                const ov = sv as { value?: SchemaValue }
                return ov.value === undefined ? undefined : rawPair.fromValue(ov.value)
              },
            }
            fields.push({ name: ps.name, type: t.option(rawType), pair, optional })
          } else {
            fields.push({ name: ps.name, type: rawType, pair: rawPair, optional })
          }
        }
        const type = t.record(fields.map((f) => field(f.name, f.type)))
        const pair: ValuePair = {
          toValue: (obj: Record<string, unknown>) =>
            v.record(fields.map((f) => f.pair.toValue(obj[f.name]))),
          fromValue: (sv) => {
            const rv = sv as { fields: ReadonlyArray<SchemaValue> }
            const out: Record<string, unknown> = {}
            for (let i = 0; i < fields.length; i++) {
              const f = fields[i]!
              const val = f.pair.fromValue(rv.fields[i]!)
              if (!f.optional || val !== undefined) out[f.name] = val
            }
            return out
          },
        }
        return { type, pair }
      })

    /**
     * Build an option-type node + pair wrapping an inner type/pair, with a
     * configurable "encoded empty" representation (the value standing in for
     * `None` in the user's encoded form, e.g. `null` for `NullOr`).
     */
    const optionWrap = (
      innerType: SchemaType,
      innerPair: ValuePair,
      empty: { readonly kind: "null" | "undefined" | "effect-option" },
    ): { type: SchemaType; pair: ValuePair } => {
      const isEmpty = (val: unknown): boolean => {
        switch (empty.kind) {
          case "null":
            return val === null
          case "undefined":
            return val === undefined
          case "effect-option":
            return Option.isOption(val as any) && Option.isNone(val as any)
        }
      }
      const wrap = (encoded: unknown): unknown =>
        empty.kind === "effect-option" ? Option.some(encoded) : encoded
      const unwrap = (val: any): unknown =>
        empty.kind === "effect-option"
          ? (val as Option.Option<unknown>).pipe(Option.getOrElse(() => undefined))
          : val
      const emptyEncoded = (): unknown => {
        switch (empty.kind) {
          case "null":
            return null
          case "undefined":
            return undefined
          case "effect-option":
            return Option.none()
        }
      }
      const pair: ValuePair = {
        toValue: (val) => v.option(isEmpty(val) ? undefined : innerPair.toValue(unwrap(val))),
        fromValue: (sv) => {
          const ov = sv as { value?: SchemaValue }
          if (ov.value === undefined) return emptyEncoded()
          return wrap(innerPair.fromValue(ov.value))
        },
      }
      return { type: t.option(innerType), pair }
    }

    /** Build a type + pair for a single AST node (no graph mutation). */
    const nodeFor = (
      a: SchemaAST.AST,
    ): Effect.Effect<{ type: SchemaType; pair: ValuePair }, UnsupportedSchemaError> =>
      Effect.gen(function* () {
        switch (a._tag) {
          case "String": {
            // `Char` annotates Schema.Char with witType: "char".
            const witHint = annotationOf<string>(a, witTypeAnnotationKey)
            if (witHint === "char") {
              return { type: t.char(), pair: primPair(v.char) }
            }
            return { type: t.string(), pair: primPair(v.string) }
          }
          case "Boolean":
            return { type: t.bool(), pair: primPair(v.bool) }
          case "Literal": {
            // Single literal value — emitted as the matching primitive type;
            // the pair always echoes the literal back.
            const lit = (a as SchemaAST.Literal).literal
            if (typeof lit === "string") {
              return { type: t.string(), pair: { toValue: () => v.string(lit), fromValue: () => lit } }
            }
            if (typeof lit === "boolean") {
              return { type: t.bool(), pair: { toValue: () => v.bool(lit), fromValue: () => lit } }
            }
            if (typeof lit === "number") {
              return { type: t.f64(), pair: { toValue: () => v.f64(lit), fromValue: () => lit } }
            }
            if (typeof lit === "bigint") {
              return { type: t.s64(), pair: { toValue: () => v.s64(lit), fromValue: () => lit } }
            }
            return yield* unsupported(`unsupported literal type: ${typeof lit}`)
          }
          case "Number": {
            const kind = numericKindOf(a) ?? "f64"
            return numericNode(kind, a)
          }
          case "BigInt": {
            const kind = numericKindOf(a) ?? "s64"
            return numericNode(kind, a)
          }

          case "Objects": {
            if (a.indexSignatures.length > 0) {
              return yield* unsupported("index signatures cannot be represented in the schema model")
            }
            return yield* recordNode(a.propertySignatures)
          }

          case "Arrays": {
            if (a.rest.length === 0 && a.elements.length > 0) {
              const elemTypes: Array<SchemaType> = []
              const elemPairs: Array<ValuePair> = []
              for (const el of a.elements) {
                const { type, pair } = yield* child(el)
                elemTypes.push(type)
                elemPairs.push(pair)
              }
              return {
                type: t.tuple(elemTypes),
                pair: {
                  toValue: (arr: ReadonlyArray<unknown>) =>
                    v.tuple(elemPairs.map((p, i) => p.toValue(arr[i]))),
                  fromValue: (sv) => {
                    const tv = sv as { elements: ReadonlyArray<SchemaValue> }
                    return elemPairs.map((p, i) => p.fromValue(tv.elements[i]!))
                  },
                },
              }
            }
            if (a.elements.length === 0 && a.rest.length === 1) {
              const { type, pair } = yield* child(a.rest[0]!)
              return {
                type: t.list(type),
                pair: {
                  toValue: (arr: ReadonlyArray<unknown>) => v.list(arr.map((x) => pair.toValue(x))),
                  fromValue: (sv) => {
                    const lv = sv as { elements: ReadonlyArray<SchemaValue> }
                    return lv.elements.map((c) => pair.fromValue(c))
                  },
                },
              }
            }
            return yield* unsupported("mixed tuple/rest arrays are not supported")
          }

          case "Union":
            return yield* unionNode(a)

          case "Declaration": {
            // The opaque `quota-token` capability is a declared schema marked
            // with `witQuotaTokenAnnotationKey`; emit the dedicated capability
            // node rather than treating it as an unknown declared type.
            if (isQuotaTokenAST(a)) {
              return quotaTokenNode()
            }
            // Typed-array hints (Uint8ArraySchema, …) take precedence — emit a
            // dedicated `list<primN>` shape rather than an unknown declared type.
            const tak = typedArrayKindOf(a)
            if (tak !== undefined) {
              const elem = typedArrayElement[tak]
              const Ctor = typedArrayCtor[tak]
              return {
                type: t.list(elem.make()),
                pair: {
                  toValue: (arr) => {
                    const items: Array<SchemaValue> = []
                    for (const x of arr as Iterable<unknown>) items.push(elem.toV(elem.coerce(x)))
                    return v.list(items)
                  },
                  fromValue: (sv) => {
                    const lv = sv as { elements: ReadonlyArray<SchemaValue> }
                    const raw = lv.elements.map((c) => (c as { value: unknown }).value)
                    return new Ctor(raw as Iterable<any>)
                  },
                },
              }
            }
            return yield* declarationNode(a)
          }

          default:
            return yield* unsupported(`unsupported AST node: ${a._tag}`)
        }
      })

    const unionNode = (
      a: SchemaAST.Union,
    ): Effect.Effect<{ type: SchemaType; pair: ValuePair }, UnsupportedSchemaError> =>
      Effect.gen(function* () {
        // String-literal enum: every member is a string Literal.
        if (
          a.types.length > 0 &&
          a.types.every(
            (m): m is SchemaAST.Literal => SchemaAST.isLiteral(m) && typeof m.literal === "string",
          )
        ) {
          const literals = a.types.map((m) => m.literal as string)
          return {
            type: t.enum(literals),
            pair: {
              toValue: (s: string) => v.enum(literals.indexOf(s)),
              fromValue: (sv) => literals[(sv as { caseIndex: number }).caseIndex]!,
            },
          }
        }

        // NullOr / UndefinedOr: a union with exactly one Null OR Undefined/Void
        // member and exactly one "real" member maps to `option<inner>`.
        // NullishOr (Null + Undefined + T) is intentionally NOT collapsed — both
        // empty kinds can't round-trip through a single option, so it falls
        // through to the generic variant path.
        const emptyMembers = a.types.filter(isNullOrUndefinedAST)
        const realMembers = a.types.filter((m) => !isNullOrUndefinedAST(m))
        if (emptyMembers.length === 1 && realMembers.length === 1) {
          const empty =
            emptyMembers[0]!._tag === "Null" ? ("null" as const) : ("undefined" as const)
          const { type, pair } = yield* child(realMembers[0]!)
          return optionWrap(type, pair, { kind: empty })
        }

        if (a.types.length === 0) {
          return yield* unsupported("empty union")
        }

        // Tagged variant: every member is an Objects with a *required*
        // string-literal _tag. Falls through to generic variant otherwise.
        if (a.types.every(SchemaAST.isObjects)) {
          const tagged = a.types.every((m) => {
            const tagPs = m.propertySignatures.find((ps) => ps.name === "_tag")
            return (
              !!tagPs &&
              !SchemaAST.isOptional(tagPs.type) &&
              SchemaAST.isLiteral(tagPs.type) &&
              typeof tagPs.type.literal === "string"
            )
          })
          if (tagged) {
            return yield* taggedVariantNode(a as SchemaAST.Union<SchemaAST.Objects>)
          }
        }

        // Generic variant: arbitrary union members.
        return yield* genericVariantNode(a)
      })

    /**
     * Build a tagged variant where every member is an Objects with a
     * string-literal `_tag` discriminator.
     */
    const taggedVariantNode = (
      a: SchemaAST.Union<SchemaAST.Objects>,
    ): Effect.Effect<{ type: SchemaType; pair: ValuePair }, UnsupportedSchemaError> =>
      Effect.gen(function* () {
        type Case = {
          readonly tag: string
          readonly payloadType: SchemaType | undefined
          readonly payloadPair: ValuePair | undefined
        }
        const cases: Array<Case> = []
        const seenTags = new Set<string>()
        for (const m of a.types) {
          const tagPs = m.propertySignatures.find((ps) => ps.name === "_tag")!
          const tag = (tagPs.type as SchemaAST.Literal).literal as string
          if (seenTags.has(tag)) {
            return yield* unsupported(`duplicate variant tag '${tag}' in tagged union`)
          }
          seenTags.add(tag)
          const rest = m.propertySignatures.filter((ps) => ps.name !== "_tag")
          if (rest.length === 0) {
            cases.push({ tag, payloadType: undefined, payloadPair: undefined })
          } else {
            const { type, pair } = yield* recordNode(rest)
            cases.push({ tag, payloadType: type, payloadPair: pair })
          }
        }
        const tagToIdx = new Map(cases.map((c, i) => [c.tag, i] as const))
        const variantCases: Array<VariantCaseType> = cases.map((c) =>
          variantCase(c.tag, c.payloadType),
        )
        return {
          type: t.variant(variantCases),
          pair: {
            toValue: (obj: { _tag: string } & Record<string, unknown>) => {
              const i = tagToIdx.get(obj._tag)
              if (i === undefined) throw new Error(`unknown variant tag: ${obj._tag}`)
              const c = cases[i]!
              if (c.payloadPair === undefined) return v.variant(i, undefined)
              const { _tag, ...rest } = obj
              void _tag
              return v.variant(i, c.payloadPair.toValue(rest))
            },
            fromValue: (sv) => {
              const vv = sv as { caseIndex: number; payload?: SchemaValue }
              const c = cases[vv.caseIndex]!
              if (c.payloadPair === undefined || vv.payload === undefined) {
                return { _tag: c.tag }
              }
              return { _tag: c.tag, ...c.payloadPair.fromValue(vv.payload) }
            },
          },
        }
      })

    /**
     * Build a generic variant for an arbitrary `Schema.Union(...)`. Each member
     * becomes a variant case (auto-named `caseN` or annotated via
     * {@link withVariantCaseName}). Encode picks the first member whose
     * `EncodedShape.matches(encoded)` returns true, in declaration order; decode
     * uses the case index.
     */
    const genericVariantNode = (
      a: SchemaAST.Union,
    ): Effect.Effect<{ type: SchemaType; pair: ValuePair }, UnsupportedSchemaError> =>
      Effect.gen(function* () {
        // Conflict detection on encoded shapes.
        const shapes = a.types.map(encodedShapeOf)
        const seen = new Set<string>()
        let plainObjectCount = 0
        let plainArrayCount = 0
        let taggedObjectCount = 0
        const literalTypeKinds = new Set<string>()
        const primitiveKinds = new Set<string>()
        for (const s of shapes) {
          if (s.tag === "object") plainObjectCount++
          if (s.tag === "array") plainArrayCount++
          if (s.tag === "object-with-tag") taggedObjectCount++
          if (s.tag === "literal") literalTypeKinds.add(typeof s.literal)
          if (s.tag === "string" || s.tag === "number" || s.tag === "boolean" || s.tag === "bigint") {
            primitiveKinds.add(s.tag)
          }
          const key =
            s.tag === "literal"
              ? `literal:${typeof s.literal}:${String(s.literal)}`
              : s.tag === "object-with-tag"
                ? `object-with-tag:${s.tagLiteral}`
                : s.tag
          if (s.tag !== "object" && s.tag !== "array" && s.tag !== "unknown" && seen.has(key)) {
            return yield* unsupported(`ambiguous union: two members share encoded shape '${key}'`)
          }
          seen.add(key)
        }
        if (plainObjectCount > 1) {
          return yield* unsupported(
            "ambiguous union: multiple object members without distinct `_tag` discriminators",
          )
        }
        if (plainObjectCount > 0 && taggedObjectCount > 0) {
          return yield* unsupported(
            "ambiguous union: cannot mix plain object members with `_tag`-discriminated object members",
          )
        }
        if (plainArrayCount > 1) {
          return yield* unsupported("ambiguous union: multiple array members cannot be distinguished")
        }
        const primitiveOfLiteralKind: Record<string, string> = {
          string: "string",
          number: "number",
          boolean: "boolean",
          bigint: "bigint",
        }
        for (const litKind of literalTypeKinds) {
          const conflict = primitiveOfLiteralKind[litKind]
          if (conflict !== undefined && primitiveKinds.has(conflict)) {
            return yield* unsupported(
              `ambiguous union: primitive '${conflict}' member overlaps a literal of the same type`,
            )
          }
        }
        if (shapes.some((s) => s.tag === "unknown") && shapes.length > 1) {
          return yield* unsupported(
            "ambiguous union: contains a member whose encoded shape cannot be classified for variant dispatch",
          )
        }

        type Case = {
          readonly name: string
          readonly type: SchemaType | undefined
          readonly pair: ValuePair | undefined
          readonly matches: (v: unknown) => boolean
          /** Encoded value to reconstruct for unit (payload-less) cases. */
          readonly emptyEncoded: unknown
        }

        const usedNames = new Set<string>()
        const cases: Array<Case> = []
        for (let i = 0; i < a.types.length; i++) {
          const m = a.types[i]!
          const annotated = variantCaseNameOf(m)
          const name = annotated ?? `case${i}`
          if (usedNames.has(name)) {
            return yield* unsupported(`duplicate variant case name '${name}' in Schema.Union`)
          }
          usedNames.add(name)
          const shape = encodedShapeOf(m)
          if (m._tag === "Null" || m._tag === "Undefined" || m._tag === "Void") {
            cases.push({
              name,
              type: undefined,
              pair: undefined,
              matches: shape.matches,
              emptyEncoded: m._tag === "Null" ? null : undefined,
            })
          } else {
            const { type, pair } = yield* child(m)
            cases.push({ name, type, pair, matches: shape.matches, emptyEncoded: undefined })
          }
        }

        const variantCases: Array<VariantCaseType> = cases.map((c) => variantCase(c.name, c.type))
        return {
          type: t.variant(variantCases),
          pair: {
            toValue: (val: unknown) => {
              for (let i = 0; i < cases.length; i++) {
                const c = cases[i]!
                if (c.matches(val)) {
                  if (c.pair === undefined) return v.variant(i, undefined)
                  return v.variant(i, c.pair.toValue(val))
                }
              }
              throw new Error(`Schema.Union: no member matched value of type ${typeof val}`)
            },
            fromValue: (sv) => {
              const vv = sv as { caseIndex: number; payload?: SchemaValue }
              const c = cases[vv.caseIndex]!
              if (c.pair === undefined || vv.payload === undefined) return c.emptyEncoded
              return c.pair.fromValue(vv.payload)
            },
          },
        }
      })

    /**
     * Recognised `Schema.declareConstructor`-based types mapped to their schema
     * shape: `Schema.Option`, `Schema.Result`, `Schema.ReadonlyMap`,
     * `Schema.HashMap`.
     */
    const declarationNode = (
      a: SchemaAST.Declaration,
    ): Effect.Effect<{ type: SchemaType; pair: ValuePair }, UnsupportedSchemaError> =>
      Effect.gen(function* () {
        const tc = declarationConstructorTag(a)
        switch (tc) {
          case "effect/Option": {
            const inner = a.typeParameters[0]
            if (inner === undefined) {
              return yield* unsupported("Schema.Option without inner type parameter")
            }
            const { type, pair } = yield* child(inner)
            return optionWrap(type, pair, { kind: "effect-option" })
          }

          case "effect/Result": {
            const okAst = a.typeParameters[0]
            const errAst = a.typeParameters[1]
            if (okAst === undefined || errAst === undefined) {
              return yield* unsupported("Schema.Result without both type parameters")
            }
            const { type: okType, pair: okPair } = yield* child(okAst)
            const { type: errType, pair: errPair } = yield* child(errAst)
            const pair: ValuePair = {
              toValue: (val) => {
                const r = val as Result.Result<unknown, unknown>
                return Result.isSuccess(r) ? v.ok(okPair.toValue(r.success)) : v.err(errPair.toValue(r.failure))
              },
              fromValue: (sv) => {
                const rv = (sv as { result: { tag: "ok" | "err"; value?: SchemaValue } }).result
                if (rv.tag === "ok") {
                  return Result.succeed(rv.value === undefined ? undefined : okPair.fromValue(rv.value))
                }
                return Result.fail(rv.value === undefined ? undefined : errPair.fromValue(rv.value))
              },
            }
            return { type: t.result(okType, errType), pair }
          }

          case "ReadonlyMap":
          case "effect/HashMap": {
            const kAst = a.typeParameters[0]
            const vAst = a.typeParameters[1]
            if (kAst === undefined || vAst === undefined) {
              return yield* unsupported("Schema.ReadonlyMap/HashMap without both type parameters")
            }
            const { type: kType, pair: kPair } = yield* child(kAst)
            const { type: vType, pair: vPair } = yield* child(vAst)
            const isHashMap = tc === "effect/HashMap"
            // Represented as `list<tuple<k, v>>` so arbitrary (non-primitive)
            // key types are allowed, matching the previous model's behaviour.
            const pair: ValuePair = {
              toValue: (val) => {
                const entries: Iterable<readonly [unknown, unknown]> = isHashMap
                  ? HashMap.toEntries(val as HashMap.HashMap<unknown, unknown>)
                  : (val as ReadonlyMap<unknown, unknown>).entries()
                const items: Array<SchemaValue> = []
                for (const [k, val2] of entries) {
                  items.push(v.tuple([kPair.toValue(k), vPair.toValue(val2)]))
                }
                return v.list(items)
              },
              fromValue: (sv) => {
                const lv = sv as { elements: ReadonlyArray<SchemaValue> }
                const entries: Array<[unknown, unknown]> = lv.elements.map((it) => {
                  const tv = it as { elements: ReadonlyArray<SchemaValue> }
                  return [kPair.fromValue(tv.elements[0]!), vPair.fromValue(tv.elements[1]!)]
                })
                return isHashMap ? HashMap.fromIterable(entries) : new Map(entries)
              },
            }
            return { type: t.list(t.tuple([kType, vType])), pair }
          }

          default:
            return yield* unsupported(`unsupported declaration: ${tc ?? "unknown"}`)
        }
      })

    // Walk on the *encoded* AST so user-defined `decodeTo` chains (Schema.Option,
    // Schema.Result, custom record↔class bridges, …) surface their wire shape.
    const encodedAst = SchemaAST.toEncoded(ast)
    return yield* nodeFor(encodedAst)
  })

/**
 * Build a `WitCodec<S>` for a single Effect Schema. Composes:
 *
 *     userSchema (Type ↔ Encoded)
 *       ↕  per-AST value transforms (encoded ↔ SchemaValue)
 *
 * into one `Codec<S["Type"], SchemaValue>`. Refinements / transformations
 * inside the user's schema run as part of the outer codec, so we get validation
 * and good error messages for free. The flat `schema-value-tree` wire carrier is
 * produced from `SchemaValue` at the dispatch boundary.
 *
 * @since 1.6.0
 * @category codecs
 */
export const toWitCodec = <S extends Schema.Top>(
  schema: S,
): Effect.Effect<WitCodec<S>, UnsupportedSchemaError> =>
  Effect.gen(function* () {
    const EncodedCarrier = Schema.declare((_u): _u is S["Encoded"] => true)
    const SchemaValueCarrier = Schema.declare((_u): _u is SchemaValue => true)

    // Void/undefined returns map to WIT `output-schema.unit`; the graph + codec
    // are placeholders the agent layer ignores when `isUnit` is set.
    const encodedAst = SchemaAST.toEncoded(schema.ast)
    const isUnit = isVoidLikeAST(encodedAst)

    const walked = isUnit ? undefined : yield* walk(schema.ast)
    const pair: ValuePair = walked?.pair ?? { toValue: () => v.record([]), fromValue: () => undefined }
    const root: SchemaType = walked?.type ?? t.record([])

    const svToEncoded = SchemaValueCarrier.pipe(
      Schema.decodeTo(EncodedCarrier, {
        decode: SchemaGetter.transform((sv: SchemaValue) => pair.fromValue(sv)),
        encode: SchemaGetter.transform((enc: S["Encoded"]) => pair.toValue(enc)),
      }),
    )

    const codec = svToEncoded.pipe(Schema.decodeTo(schema)) as Schema.Codec<
      S["Type"],
      SchemaValue,
      S["DecodingServices"],
      S["EncodingServices"]
    >

    return {
      schema,
      graph: { defs: new Map(), root },
      isUnit,
      codec,
    }
  })
