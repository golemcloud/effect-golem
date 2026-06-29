/**
 * @since 1.5.0
 */
import { Effect, Schema } from "effect"
import type { Role } from "golem:core/types@2.0.0"
import {
  emptyMetadata,
  t,
  v,
  variantCase,
  type SchemaType,
  type SchemaValue,
  type VariantCaseType,
} from "./internal/schema-model/model.js"
import {
  isElementSpec,
  tryGetter,
  UnstructuredBinary,
  UnstructuredText,
  type BinaryReferenceValue,
  type ElementSpec,
  type TextReferenceValue,
} from "./Unstructured.js"
import { toWitCodec, type UnsupportedSchemaError, type WitCodec } from "./WitCodec.js"

const MULTIMODAL_ROLE: Role = { tag: "multimodal" }

/**
 * One named element of a multimodal payload — either an
 * {@link ElementSpec} (unstructured-text/binary) or a regular
 * `Schema.Top` (compiled via {@link toWitCodec}).
 *
 * @since 1.5.0
 * @category models
 */
export type MultimodalMember = ElementSpec<any> | Schema.Top

/**
 * Record mapping case names to their multimodal members.
 *
 * @since 1.5.0
 * @category models
 */
export type MultimodalShape = Readonly<Record<string, MultimodalMember>>

/**
 * Domain-side type emitted by a multimodal element of the given shape.
 *
 * @since 1.5.0
 * @category models
 */
export type MultimodalValue<S extends MultimodalShape> = ReadonlyArray<
  {
    readonly [K in keyof S & string]: {
      readonly _tag: K
      readonly value: S[K] extends ElementSpec<infer T>
        ? T
        : S[K] extends Schema.Top
          ? S[K]["Type"]
          : never
    }
  }[keyof S & string]
>

/**
 * A `Multimodal<S>` is the carrier produced by {@link multimodal}. It lives at
 * the same boundary layer as {@link ElementSpec}: not a `Schema.Top`, but
 * recognised by the method / agent compiler as a parameter that projects to a
 * `list<variant>` schema node tagged `role = multimodal`.
 *
 * It holds a pre-built {@link WitCodec} whose root is that `list<variant>`. The
 * value codec maps the domain array (`ReadonlyArray<{ _tag, value }>`) to/from
 * a `{ tag: "list", elements: [v.variant(caseIndex, payload), …] }` value.
 *
 * @since 1.5.0
 * @category models
 */
export interface Multimodal<S extends MultimodalShape> {
  readonly _effectGolem: "Multimodal"
  readonly shape: S
  /**
   * Compile this multimodal carrier to its `WitCodec`. Done lazily / cached so
   * the method & agent param compilers share one assembly.
   */
  readonly compile: () => Effect.Effect<
    WitCodec<Schema.Schema<MultimodalValue<S>>>,
    UnsupportedSchemaError
  >
}

/** Per-case synchronous bridge between a domain value and its `SchemaValue`. */
interface CaseCodec {
  readonly name: string
  readonly root: SchemaType
  readonly toValue: (domain: unknown) => SchemaValue
  readonly fromValue: (sv: SchemaValue) => unknown
}

const compileMember = (
  caseName: string,
  member: MultimodalMember,
): Effect.Effect<CaseCodec, UnsupportedSchemaError> =>
  Effect.gen(function* () {
    if (isElementSpec(member)) {
      return {
        name: caseName,
        root: member.root,
        toValue: member.toValue as (d: unknown) => SchemaValue,
        fromValue: member.fromValue as (sv: SchemaValue) => unknown,
      }
    }
    const wc = yield* toWitCodec(member)
    const encodeSync = Schema.encodeSync(
      wc.codec as Schema.Codec<unknown, SchemaValue, never, never>,
    )
    const decodeSync = Schema.decodeSync(
      wc.codec as Schema.Codec<unknown, SchemaValue, never, never>,
    )
    return {
      name: caseName,
      root: wc.graph.root,
      toValue: (d) => encodeSync(d),
      fromValue: (sv) => decodeSync(sv),
    }
  })

/**
 * Construct a multimodal element that accepts a named, ordered, repeatable
 * sequence of typed sub-elements.
 *
 * **Example**
 *
 * ```ts
 * const Content = multimodal({
 *   text:  UnstructuredText(),
 *   image: UnstructuredBinary(),
 *   meta:  Schema.Struct({ prompt: Schema.String }),
 * })
 * ```
 *
 * @since 1.5.0
 * @category constructors
 */
export const multimodal = <S extends MultimodalShape>(shape: S): Multimodal<S> => {
  let cached: WitCodec<Schema.Schema<MultimodalValue<S>>> | null = null

  return {
    _effectGolem: "Multimodal",
    shape,
    compile: () =>
      Effect.suspend(() => {
        if (cached !== null) return Effect.succeed(cached)
        return Effect.gen(function* () {
          const cases: Array<CaseCodec> = []
          for (const [k, m] of Object.entries(shape)) {
            cases.push(yield* compileMember(k, m))
          }
          const byName = new Map(cases.map((c, i) => [c.name, { c, index: i }] as const))

          const variantCases: Array<VariantCaseType> = cases.map((c) =>
            variantCase(c.name, c.root),
          )
          const variant = t.variant(variantCases)
          const root: SchemaType = {
            body: t.list(variant).body,
            metadata: { ...emptyMetadata(), role: MULTIMODAL_ROLE },
          }

          const toValue = (value: MultimodalValue<S>): SchemaValue => {
            const elements: Array<SchemaValue> = []
            for (const item of value) {
              const entry = byName.get(item._tag)
              if (entry === undefined) {
                throw new Error(`multimodal: unknown case '${item._tag}'`)
              }
              elements.push(v.variant(entry.index, entry.c.toValue(item.value)))
            }
            return v.list(elements)
          }

          const fromValue = (sv: SchemaValue): MultimodalValue<S> => {
            if (sv.tag !== "list") {
              throw new Error(`multimodal: expected a list value, got ${sv.tag}`)
            }
            const out: Array<{ _tag: string; value: unknown }> = []
            for (const el of sv.elements) {
              if (el.tag !== "variant") {
                throw new Error(`multimodal: expected variant element, got ${el.tag}`)
              }
              const c = cases[el.caseIndex]
              if (c === undefined) {
                throw new Error(`multimodal: unknown case index ${el.caseIndex}`)
              }
              if (el.payload === undefined) {
                throw new Error(`multimodal: missing payload for case '${c.name}'`)
              }
              out.push({ _tag: c.name, value: c.fromValue(el.payload) })
            }
            return out as unknown as MultimodalValue<S>
          }

          const SchemaValueCarrier = Schema.declare((_u): _u is SchemaValue => true)
          const DomainCarrier = Schema.declare((_u): _u is MultimodalValue<S> => true)
          const codec = SchemaValueCarrier.pipe(
            Schema.decodeTo(DomainCarrier, {
              decode: tryGetter((sv: SchemaValue) => fromValue(sv)),
              encode: tryGetter((d: MultimodalValue<S>) => toValue(d)),
            }),
          ) as WitCodec<Schema.Schema<MultimodalValue<S>>>["codec"]

          cached = {
            schema: DomainCarrier as unknown as Schema.Schema<MultimodalValue<S>>,
            graph: { defs: new Map(), root },
            isUnit: false,
            codec,
          }
          return cached
        })
      }),
  }
}

/**
 * Type-guard for `Multimodal` carriers.
 *
 * @since 1.5.0
 * @category guards
 */
export const isMultimodal = (x: unknown): x is Multimodal<MultimodalShape> =>
  typeof x === "object" &&
  x !== null &&
  (x as { _effectGolem?: unknown })._effectGolem === "Multimodal"

// ---------- Convenience constructors ----------

/**
 * Multimodal payload with arbitrary text + image elements.
 *
 * @since 1.5.0
 * @category constructors
 */
export const multimodalTextImage = (opts?: {
  readonly text?: { readonly restrictions?: ReadonlyArray<{ languageCode: string }> }
  readonly image?: { readonly restrictions?: ReadonlyArray<{ mimeType: string }> }
}) =>
  multimodal({
    text: UnstructuredText(opts?.text),
    image: UnstructuredBinary(opts?.image),
  } as const)

/**
 * Multimodal payload with arbitrary text + image elements plus a custom
 * schema under a named slot (default: `"custom"`).
 *
 * @since 1.5.0
 * @category constructors
 */
export const multimodalTextImageCustom = <S extends Schema.Top>(
  custom: S,
  opts?: {
    readonly text?: { readonly restrictions?: ReadonlyArray<{ languageCode: string }> }
    readonly image?: { readonly restrictions?: ReadonlyArray<{ mimeType: string }> }
    readonly customName?: string
  },
) => {
  const name = opts?.customName ?? "custom"
  const shape: Record<string, MultimodalMember> = {
    text: UnstructuredText(opts?.text),
    image: UnstructuredBinary(opts?.image),
    [name]: custom,
  }
  return multimodal(shape) as unknown as Multimodal<
    {
      text: ElementSpec<TextReferenceValue>
      image: ElementSpec<BinaryReferenceValue>
    } & Record<string, S>
  >
}
