/**
 * @since 1.5.0
 */
import { Effect, Pipeable, Result, Schema } from "effect"
import type { SchemaValueTree } from "golem:core/types@2.0.0"
import type { HostServices } from "../host/HostLive.js"
import type { EndpointDef } from "../Http.js"
import { isMultimodal, type Multimodal } from "../Multimodal.js"
import { schemaValueFromWit, schemaValueToWit, type SchemaValue } from "./schema-model/index.js"
import type {
  BindableKeys,
  EndpointBound,
  Invalid,
  NoCaseFoldDuplicates,
  NoDuplicateBindings,
} from "./httpTypes.js"
import { withPipe } from "./pipeable.js"
import { Principal } from "../Principal.js"
import { SelfAgentId } from "../SelfAgentId.js"
import { isElementSpec, type ElementSpec } from "../Unstructured.js"
import { toWitCodec, type UnsupportedSchemaError, type WitCodec } from "../WitCodec.js"

/**
 * A method/constructor parameter is either an ordinary `Schema.Top` (which
 * compiles to a `component-model` element), an `ElementSpec<T>`
 * (unstructured-text/binary), or a `Multimodal<S>` (the param maps to
 * `DataSchema.multimodal`; only valid when it is the sole parameter).
 *
 * @since 1.5.0
 * @category models
 */
export type MethodParam = Schema.Top | ElementSpec<any> | Multimodal<any>

/**
 * A record of named parameter shapes.
 *
 * @since 1.5.0
 * @category models
 */
export type MethodParams = Readonly<Record<string, MethodParam>>

/**
 * Decoded user-side type for one parameter.
 *
 * @since 1.5.0
 * @category models
 */
export type ParamInputType<P extends MethodParam> =
  P extends Multimodal<infer S>
    ? import("../Multimodal.js").MultimodalValue<S>
    : P extends ElementSpec<infer T>
      ? T
      : P extends Schema.Top
        ? P["Type"]
        : never

/**
 * Decoded shape of a method's named-input record.
 *
 * @since 1.5.0
 * @category models
 */
export type MethodInput<Params extends MethodParams> = {
  readonly [K in keyof Params]: ParamInputType<Params[K]>
}

declare const methodHasHttpBrand: unique symbol

/**
 * A `MethodSpec` describes a method's wire contract — its named input
 * parameters, success type, and typed failure type — *without* an
 * implementation.
 *
 * Used inside `defineAgent({ methods })` so that the agent type can be
 * fully discovered (and its `WitCodec`s compiled) without instantiating
 * the agent. The implementation comes from the agent's `impl` block.
 *
 * Instances are {@link Pipeable.Pipeable}: the pipeable-builder
 * combinators ({@link withHttp}, {@link withDescription},
 * {@link withPromptHint}) compose additively with the literal-options
 * form accepted by {@link method}.
 *
 * The fourth `HasHttp` phantom records whether the spec was constructed
 * with one or more HTTP endpoints — `true` when `method({ http: [...] })`
 * is built with a non-empty `http` tuple OR when `withHttp(...)` adds
 * endpoints, `false` otherwise. The `AnyMethodHasHttp<Methods>` helper
 * in `src/internal/agent.ts` reads this phantom to decide whether the
 * agent's `http: Http.mount(...)` field is required.
 *
 * Carried via a `readonly` optional unique-symbol-keyed property so the
 * variance is covariant — `MethodSpec<P, S, E, true>` is assignable to
 * `MethodSpec<P, S, E, boolean>` (the implicit shape when consumers
 * write `MethodSpec<P, S, E>` and rely on the default). This matters
 * because existing destructuring patterns (e.g. `Methods[K] extends
 * MethodSpec<infer P, infer S, infer E>` in `Client.ts`) leave the
 * fourth slot unspecified — the default of `boolean` plus covariance
 * keeps those patterns working unchanged.
 *
 * @since 1.5.0
 * @category models
 */
export interface MethodSpec<
  in out Params extends MethodParams,
  in out Success extends Schema.Top,
  in out Error extends Schema.Top,
  HasHttp extends boolean = boolean,
>
  extends Pipeable.Pipeable {
  readonly [methodHasHttpBrand]?: HasHttp
  readonly params: Params
  readonly success: Success
  readonly error: Error
  /** Free-text description, surfaced as `agent-method.description`. */
  readonly description?: string
  /** Optional `prompt-hint`, surfaced as `agent-method.prompt-hint`. */
  readonly promptHint?: string
  /**
   * Optional list of HTTP endpoints exposing this method through the
   * Golem host. Compiled to `agent-method.http-endpoint`. Each endpoint
   * may bind path / query / header variables to entries of `Params`;
   * type-level constraint: every binding name must be a `keyof Params`
   * AND must be statically eligible for path/query/header binding (i.e.
   * not a {@link Multimodal} or {@link ElementSpec} carrier — see
   * {@link BindableKeys}). Full string-bindability (rejecting
   * `Schema.Struct` etc.) is enforced at registration time by the
   * runtime validators in `Http.ts`.
   */
  readonly http?: ReadonlyArray<EndpointDef<BindableKeys<Params>>>
}

/**
 * Build a {@link MethodSpec} from a literal options object.
 *
 * **Details**
 *
 * Every facet of a method can be declared inline on the input object —
 * the same facets are also reachable via the pipeable combinators
 * ({@link withHttp}, {@link withDescription}, {@link withPromptHint})
 * for users who prefer Effect's `.pipe(...)` style.
 *
 * **Input fields**
 *
 * - `params` — a `Record<string, MethodParam>` describing the method's
 *   inputs. Each entry is one of: a `Schema.Top` (regular value
 *   parameter), an `ElementSpec<...>` ({@link UnstructuredText} /
 *   {@link UnstructuredBinary} unstructured-data parameter), or a
 *   {@link Multimodal} (multi-element parameter). The keys become the
 *   `data-schema` element names emitted into the WIT metadata.
 *
 * - `success` — a `Schema.Top` describing the method's success value
 *   (the `A` of the resulting `Effect<A, E, R>`).
 *
 * - `error` *(optional)* — a `Schema.Top` describing typed failures
 *   (the `E` of the resulting `Effect<A, E, R>`). Defaults to
 *   `Schema.Void`, meaning "does not fail in a typed way".
 *
 * - `description` *(optional)* — free-text description, surfaced as
 *   `agent-method.description` in the discovered WIT metadata. Same
 *   facet as {@link withDescription}.
 *
 * - `promptHint` *(optional)* — natural-language hint used by LLM
 *   front-ends to decide when to call this method. Surfaced as
 *   `agent-method.prompt-hint`. Same facet as {@link withPromptHint}.
 *
 * - `http` *(optional)* — a `ReadonlyArray<EndpointDef<...>>`
 *   exposing this method through the host's HTTP server. Each
 *   endpoint's path / query / header bindings must reference an entry
 *   of `params` (enforced at the type level). Same facet as
 *   {@link withHttp}; the literal form replaces, the combinator
 *   appends.
 *
 * The returned spec is {@link Pipeable.Pipeable}, so additional
 * cross-cutting facets can still be layered on with `.pipe(...)`
 * after construction.
 *
 * **Example** (all fields inline)
 *
 * ```ts
 * import { Http, method, Schema } from "effect-golem"
 *
 * const add = method({
 *   params: { by: Schema.Number },
 *   success: Schema.Number,
 *   error: Schema.String,
 *   description: "Add `by` to the counter",
 *   promptHint: "Use this to increment the counter by a number",
 *   http: [Http.post("/add"), Http.get("/add?by={by}")],
 * })
 * ```
 *
 * **Example** (minimal, then `.pipe(...)` for the rest)
 *
 * ```ts
 * import { Http, method, Schema, withDescription, withHttp } from "effect-golem"
 *
 * method({ params: { by: Schema.Number }, success: Schema.Number }).pipe(
 *   withHttp(Http.post("/add"), Http.get("/add?by={by}")),
 *   withDescription("Add `by` to the counter"),
 * )
 * ```
 *
 * **Compile-time guarantees on the `http` array**
 *
 * Each element of the optional `http: ReadonlyArray<EndpointDef<...>>`
 * is validated independently by the type system. For each endpoint:
 *
 * - Every binding `{var}` (path / query / header) must reference a
 *   key of `params` AND that key must be statically eligible for
 *   binding (i.e. NOT a {@link Multimodal} or {@link ElementSpec}
 *   carrier — see `BindableKeys`). Misnamed bindings produce a normal
 *   "no such property" error on `EndpointDef<BindableKeys<Params>>`.
 * - A method parameter may be bound from at most one source within
 *   the same endpoint — enforced via the structured `EndpointBound`
 *   phantom on `EndpointDef`.
 * - Header names declared on the same endpoint must be unique when
 *   compared case-insensitively — enforced via the `HeaderNames`
 *   phantom on `EndpointDef`.
 * - `Http.get(...)` / `Http.head(...)` shorthands are tagged
 *   `"bodyless"` and rejected at compile time when the endpoint's
 *   bound-var union does NOT cover every key of `params` — there is
 *   no request body in which to deliver an unbound parameter.
 *
 * On any of these violations, the type-level helper substitutes the
 * offending endpoint with an `Invalid<"…">` carrier whose message
 * names the offending parameter / header — `tsc` then reports the
 * mismatch at the `method({ http: [...] })` call site.
 *
 * Full string-bindability of bound parameters (rejecting a
 * `Schema.Struct` schema as a path var, etc.) remains runtime-only
 * and is surfaced as an `HttpRouteError` from `registerAgent`.
 *
 * @see {@link withHttp} for the pipeable HTTP-endpoint combinator.
 * @see {@link withDescription} for the pipeable description combinator.
 * @see {@link withPromptHint} for the pipeable prompt-hint combinator.
 *
 * @since 1.5.0
 * @category constructors
 */
/**
 * Apply the cross-source binding-uniqueness check, the case-insensitive
 * header-name-uniqueness check, AND the bodyless-verb unbound-param
 * check to each user-supplied endpoint by mapping over the inferred
 * `Eps` tuple. For each element:
 *
 *   - destructure its `EndpointDef<V, K, B, HN>` to recover the
 *     bound-vars union, the kind, the structured `Bound` slot AND the
 *     header-names tuple;
 *   - if `K extends "bodyless"` and `Exclude<keyof Params & string, V>`
 *     is non-empty, surface an {@link Invalid} naming the missing
 *     parameter — bodyless verbs (`GET` / `HEAD`) have no request
 *     body in which to deliver an unbound value;
 *   - run `NoDuplicateBindings<B>` over the bindings;
 *   - run `NoCaseFoldDuplicates<HN>` over the header names;
 *   - if any of the three checks resolves to {@link Invalid}, surface
 *     that carrier at this position (the user's literal `EndpointDef`
 *     cannot satisfy `Invalid`, so the call site fails with a
 *     readable message);
 *   - otherwise pass the original element type through unchanged.
 *
 * The `Eps` array constraint already restricts each endpoint to
 * `EndpointDef<BindableKeys<Params>>` — multimodal / unstructured
 * params are rejected before any of the three checks is tried.
 */
type ValidateEndpointsTuple<Eps extends ReadonlyArray<EndpointDef<string>>, Params> = {
  readonly [K in keyof Eps]: Eps[K] extends EndpointDef<infer V, infer Kind, infer B, infer HN>
    ? Kind extends "bodyless"
      ? [Exclude<keyof Params & string, V>] extends [never]
        ? ValidateEndpointStructure<Eps[K], B, HN>
        : Invalid<`GET/HEAD endpoint cannot have unbound param '${Exclude<
            keyof Params & string,
            V
          > &
            string}' (only path / query / header bindings are allowed because there is no request body)`>
      : ValidateEndpointStructure<Eps[K], B, HN>
    : Eps[K]
}

// The cross-source binding-uniqueness and case-insensitive
// header-name-uniqueness checks, factored out so the bodyless-verb
// wrapper above can dispatch on `Kind` without duplicating the
// dup-check ladder.
type ValidateEndpointStructure<E, B, HN> = B extends EndpointBound
  ? HN extends ReadonlyArray<string>
    ? NoDuplicateBindings<B> extends infer R1
      ? [R1] extends [Invalid<string>]
        ? R1
        : NoCaseFoldDuplicates<HN> extends infer R2
          ? [R2] extends [Invalid<string>]
            ? R2
            : E
          : E
      : E
    : E
  : E

/**
 * Resolves to `true` when `T` is statically known to be a non-empty
 * tuple, else `false`. Used by the `method({...})` factory and
 * `withHttp(...)` to compute the `HasHttp` phantom on `MethodSpec`.
 *
 * Mirrors (defence-in-depth) the runtime "any endpoints declared" check
 * in `validateAgentHttp` (Http.ts L1452: `m.endpoints.length > 0`). When
 * `T` widens to a non-tuple `ReadonlyArray<...>` (e.g. because the user
 * passed an unspread variable instead of an array literal), this helper
 * conservatively resolves to `false`, deferring entirely to the runtime
 * check. That keeps existing wide-array call patterns working without
 * forcing a mount on agents that may or may not have endpoints — the
 * runtime validator catches any actual violation at registration time.
 */
type IsNonEmptyTuple<T extends ReadonlyArray<unknown>> = T extends readonly [
  unknown,
  ...ReadonlyArray<unknown>,
]
  ? true
  : false

export const method: {
  <
    const Params extends MethodParams,
    Success extends Schema.Top,
    Error extends Schema.Top,
    const Eps extends ReadonlyArray<EndpointDef<BindableKeys<Params>>> = readonly [],
  >(spec: {
    readonly params: Params
    readonly success: Success
    readonly error: Error
    readonly description?: string
    readonly promptHint?: string
    readonly http?: ValidateEndpointsTuple<Eps, Params>
  }): MethodSpec<Params, Success, Error, IsNonEmptyTuple<Eps>>
  <
    const Params extends MethodParams,
    Success extends Schema.Top,
    const Eps extends ReadonlyArray<EndpointDef<BindableKeys<Params>>> = readonly [],
  >(spec: {
    readonly params: Params
    readonly success: Success
    readonly description?: string
    readonly promptHint?: string
    readonly http?: ValidateEndpointsTuple<Eps, Params>
  }): MethodSpec<Params, Success, typeof Schema.Void, IsNonEmptyTuple<Eps>>
} = (spec: any): any => withPipe({ error: Schema.Void, ...spec })

// ---------------------------------------------------------------------------
// Pipeable combinators for `MethodSpec`
//
// These layer cross-cutting facets onto a previously-built `MethodSpec`
// so users can compose them with the canonical Effect `.pipe(...)`
// style, e.g.:
//
//   method({ params: { by: Schema.Number }, success: Schema.Number }).pipe(
//     Method.withHttp(Http.post("/add"), Http.get("/add?by={by}")),
//     Method.withDescription("Add by to the counter"),
//     Method.withPromptHint("Increment by `by`"),
//   )
//
// Every combinator returns a fresh, pipeable spec — input is never
// mutated. The literal-options form passed to `method({...})` keeps
// working unchanged.
// ---------------------------------------------------------------------------

// `MethodSpec<Params, ...>` is `in out` invariant in its type
// parameters, so `MethodSpec<{ by: Schema.Number }, ...>` is NOT
// assignable to `MethodSpec<MethodParams, ...>` even though the
// constituent types are subtypes. The combinators below therefore
// constrain `T extends MethodSpec<any, any, any>` (which TS bypasses
// for variance) and use a *separate* structural intersection on
// `params` to enforce binding correctness for `withHttp`.

/**
 * Append HTTP endpoints to a `MethodSpec`. The endpoints' bindings —
 * path variables, query variables, and headers — must reference the
 * spec's existing parameter names; this is enforced by intersecting
 * the input spec type with `{ params: Record<V, unknown> }`, which
 * makes TypeScript reject specs whose params record is missing any
 * binding. Endpoints already declared on the spec are preserved; the
 * new ones are appended.
 *
 * Generic over the full input spec type, so when applied to a
 * {@link Method} (which carries a `body` and a `name`) those extra
 * fields are preserved in the returned value.
 *
 * @since 1.5.0
 * @category combinators
 */
export const withHttp =
  <V extends string>(...endpoints: ReadonlyArray<EndpointDef<V>>) =>
  <T extends MethodSpec<any, any, any, any>>(
    spec: T & { readonly params: Readonly<Record<V, unknown>> },
  ): T extends MethodSpec<infer P, infer Su, infer Er, infer _H>
    ? // `withHttp` only matters at the type level when the endpoint
      // tuple is non-empty (the runtime check in `validateAgentHttp`
      // gates on `endpoints.length > 0`). The factory-arg signature
      // accepts a (possibly empty) `ReadonlyArray<...>` so we cannot
      // detect emptiness here without a `const Eps` modifier — and
      // that modifier breaks V inference (it tightens `EndpointDef<V>`
      // capture so V no longer flows from the endpoint's path
      // variables, which would silently drop the
      // "binding-not-in-params" rejection enforced via the `spec
      // params` constraint above). Always-flip-to-true is acceptable
      // because the runtime check ignores empty `withHttp()` calls
      // anyway, and `withHttp()` with zero args is a no-op users do
      // not actually write.
      MethodSpec<P, Su, Er, true>
    : T =>
    withPipe({
      ...spec,
      http: [
        ...(spec.http ?? []),
        ...(endpoints as unknown as ReadonlyArray<EndpointDef<BindableKeys<T["params"]>>>),
      ],
    }) as never

/**
 * Set the free-text description on a `MethodSpec`, surfaced as
 * `agent-method.description` in the WIT metadata. Replaces any
 * previous value.
 *
 * Generic over the full input spec type, so when applied to a
 * {@link Method} (which carries a `body` and a `name`) those extra
 * fields are preserved in the returned value.
 *
 * @since 1.5.0
 * @category combinators
 */
export const withDescription =
  (description: string) =>
  <T extends MethodSpec<any, any, any>>(spec: T): T =>
    withPipe({ ...spec, description }) as unknown as T

/**
 * Set the prompt-hint on a `MethodSpec`, surfaced as
 * `agent-method.prompt-hint` in the WIT metadata. Replaces any
 * previous value.
 *
 * Generic over the full input spec type, so when applied to a
 * {@link Method} (which carries a `body` and a `name`) those extra
 * fields are preserved in the returned value.
 *
 * @since 1.5.0
 * @category combinators
 */
export const withPromptHint =
  (promptHint: string) =>
  <T extends MethodSpec<any, any, any>>(spec: T): T =>
    withPipe({ ...spec, promptHint }) as unknown as T

/**
 * A `Method` is a `MethodSpec` paired with a name and a body. Use
 * {@link defineMethod} to build one when you want a self-contained method
 * value (e.g. for tests, or a future "stateless functions" registry).
 *
 * Inside `defineAgent` you should use `method(...)` for the spec and
 * provide the body inside the agent's `impl` block — that gives the body
 * access to per-instance state via closure.
 *
 * @since 1.5.0
 * @category models
 */
export interface Method<
  in out Params extends MethodParams,
  in out Success extends Schema.Top,
  in out Error extends Schema.Top,
  out R,
> extends MethodSpec<Params, Success, Error> {
  readonly name: string
  readonly body: (input: MethodInput<Params>) => Effect.Effect<Success["Type"], Error["Type"], R>
}

/**
 * Standalone Method (spec + name + body), useful outside agents.
 *
 * @since 1.5.0
 * @category constructors
 */
export const defineMethod: {
  <
    const Params extends MethodParams,
    Success extends Schema.Top,
    Error extends Schema.Top,
    R,
  >(definition: {
    readonly name: string
    readonly params: Params
    readonly success: Success
    readonly error: Error
    readonly body: (input: MethodInput<Params>) => Effect.Effect<Success["Type"], Error["Type"], R>
  }): Method<Params, Success, Error, R>
  <const Params extends MethodParams, Success extends Schema.Top, R>(definition: {
    readonly name: string
    readonly params: Params
    readonly success: Success
    readonly body: (input: MethodInput<Params>) => Effect.Effect<Success["Type"], never, R>
  }): Method<Params, Success, typeof Schema.Void, R>
} = (definition: any): any => withPipe({ error: Schema.Void, ...definition })

/**
 * A handler implementing a `MethodSpec`: takes the decoded input record,
 * returns an Effect of the success/error types declared by the spec.
 *
 * The required-services slot allows {@link Principal}, {@link SelfAgentId},
 * any host-service tag bundled into `HostLive` (so `yield*
 * BlobstoreClient`, `yield* OplogClient`, etc. inside a handler body
 * does not leak), and an optional agent-specific config tag (defaulting
 * to `never`). The dispatcher always provides all of these via the
 * `userRuntimeLayer`.
 *
 * @since 1.5.0
 * @category models
 */
export type Handler<S extends MethodSpec<any, any, any>, CfgTag = never> = (
  input: MethodInput<S["params"]>,
) => Effect.Effect<
  S["success"]["Type"],
  S["error"]["Type"],
  Principal | SelfAgentId | HostServices | CfgTag
>

/**
 * Invoke a standalone {@link Method} with a *decoded* input record. Useful
 * for tests; production code goes through `invokeDataValue` (with an
 * explicit handler) at the Golem boundary.
 *
 * @since 1.5.0
 * @category operations
 */
export const invoke = <
  Params extends MethodParams,
  Success extends Schema.Top,
  Error extends Schema.Top,
  R,
>(
  m: Method<Params, Success, Error, R>,
  input: MethodInput<Params>,
): Effect.Effect<Success["Type"], Error["Type"], R> => m.body(input)

/**
 * A single method/constructor parameter compiled to its WIT codec, in
 * declaration order. In the new schema model a parameter is just a
 * `WitCodec` (no element wrapper); its `graph.root` is encoded into the
 * agent's shared `schema-graph` when the `AgentType` is assembled.
 *
 * Multimodal / unstructured parameters (which map to `text`/`binary` schema
 * types) are not yet supported on the new model — see the Phase 5 redesign.
 *
 * @since 1.6.0
 * @category models
 */
export interface ParamCodec {
  readonly name: string
  readonly codec: WitCodec<Schema.Top>
}

/**
 * The compiled encoding of a single method: per-parameter codecs (in
 * declaration order) and a unit-or-single output codec. The WIT `input-schema`
 * / `output-schema` (which reference `type-node-index`es into the agent's
 * shared `schema-graph`) are built later in `agent.ts` via a `GraphEncoder`.
 * Compiled once via {@link compileMethodSpec}, reused per call by
 * {@link invokeSchemaValue}.
 *
 * @since 1.6.0
 * @category models
 */
export interface MethodCodec<
  in out Params extends MethodParams,
  in out Success extends Schema.Top,
  in out Error extends Schema.Top,
> {
  readonly name: string
  readonly spec: MethodSpec<Params, Success, Error>
  /** Per-parameter codecs in declaration order (drives the input record order). */
  readonly inputCodecs: ReadonlyArray<ParamCodec>
  /**
   * The method's wire response: `unit` for a void, unfailable return;
   * otherwise a single `WitCodec`. When {@link errorWrapped} is `true` the
   * codec is for `Result<Success, Error>` (the wrapper carries the error tag
   * even when `Success` is `Schema.Void`).
   */
  readonly output:
    | { readonly tag: "unit" }
    | { readonly tag: "single"; readonly codec: WitCodec<Schema.Top> }
  /**
   * `true` when the method declares a non-Void typed `error`; the wire
   * response is folded into a `result<S, E>`. `AgentError` is reserved for
   * host/SDK-level conditions, not user-domain errors.
   */
  readonly errorWrapped: boolean
  /**
   * `true` when `spec.success` is `Schema.Void`. With `errorWrapped`, the wire
   * `result<_, E>` uses an empty-record stand-in for the success arm, and the
   * SDK substitutes `undefined` ↔ `{}` automatically.
   */
  readonly successVoid: boolean
}

/** Detect a unit / `Schema.Void` return type. */
const isVoidSchema = (s: Schema.Top): boolean => s.ast._tag === "Void"

/**
 * Compile a record of named `MethodParam`s to a flat `ParamBinding[]`.
 * Reused by both `compileMethodSpec` (per-method) and `agent.ts`
 * (per-constructor) so the two share a single param-shape pipeline.
 *
 * @since 1.5.0
 * @category codecs
 */
export const compileParamCodecs = (
  context: string,
  params: MethodParams,
): Effect.Effect<ReadonlyArray<ParamCodec>, UnsupportedSchemaError> =>
  Effect.gen(function* () {
    const codecs: Array<ParamCodec> = []
    for (const [paramName, param] of Object.entries(params)) {
      if (isMultimodal(param) || isElementSpec(param)) {
        return yield* Effect.fail<UnsupportedSchemaError>({
          _tag: "UnsupportedSchemaError",
          reason: `${context}: multimodal/unstructured parameter '${paramName}' is not yet supported on the new schema model`,
        } as UnsupportedSchemaError)
      }
      const codec = (yield* toWitCodec(param as Schema.Top)) as WitCodec<Schema.Top>
      codecs.push({ name: paramName, codec })
    }
    return codecs
  })

/**
 * Compile a method spec (name + params + success + error) to a MethodCodec.
 *
 * @since 1.5.0
 * @category codecs
 */
export const compileMethodSpec = <
  Params extends MethodParams,
  Success extends Schema.Top,
  Error extends Schema.Top,
>(
  name: string,
  spec: MethodSpec<Params, Success, Error>,
): Effect.Effect<MethodCodec<Params, Success, Error>, UnsupportedSchemaError> =>
  Effect.gen(function* () {
    const errorWrapped = !isVoidSchema(spec.error)
    const successVoid = isVoidSchema(spec.success)
    // When the method declares a non-Void typed error, fold success+error into
    // a single `result<S, E>` (the only channel for user-typed errors;
    // `AgentError` is reserved for host/SDK-level conditions). The schema model
    // has no free-standing unit type, so a void success uses an empty-record
    // stand-in and the SDK substitutes `undefined` ↔ `{}` on encode/decode.
    const responseSchema: Schema.Top = errorWrapped
      ? (Schema.Result(
          successVoid ? (Schema.Struct({}) as Schema.Top) : spec.success,
          spec.error,
        ) as unknown as Schema.Top)
      : spec.success
    const output: MethodCodec<Params, Success, Error>["output"] =
      !errorWrapped && successVoid
        ? { tag: "unit" }
        : { tag: "single", codec: (yield* toWitCodec(responseSchema)) as WitCodec<Schema.Top> }

    // Multimodal params are rejected pending the Phase 5 redesign onto
    // `text`/`binary` schema types.
    if (Object.entries(spec.params).some(([, p]) => isMultimodal(p))) {
      return yield* Effect.fail<UnsupportedSchemaError>({
        _tag: "UnsupportedSchemaError",
        reason: `${name}: multimodal parameters are not yet supported on the new schema model`,
      } as UnsupportedSchemaError)
    }

    const inputCodecs = yield* compileParamCodecs(name, spec.params)
    return { name, spec, inputCodecs, output, errorWrapped, successVoid }
  })

/**
 * Convenience: compile a standalone {@link Method}.
 *
 * @since 1.5.0
 * @category codecs
 */
export const compileMethod = <
  Params extends MethodParams,
  Success extends Schema.Top,
  Error extends Schema.Top,
  R,
>(
  m: Method<Params, Success, Error, R>,
): Effect.Effect<MethodCodec<Params, Success, Error>, UnsupportedSchemaError> =>
  compileMethodSpec(m.name, m)

/**
 * Raised when {@link invokeDataValue} receives a `DataValue` whose
 * shape does not match the compiled method codec — wrong tag, wrong
 * arity, or an element of the wrong kind.
 *
 * @since 1.5.0
 * @category errors
 */
export class InvalidDataValueError {
  readonly _tag = "InvalidDataValueError"
  constructor(readonly reason: string) {}
}

/**
 * Run the user handler and encode its outcome into the on-the-wire
 * `DataValue`. Two paths:
 *
 * - `errorWrapped === false` (default, no typed error declared): the
 *   handler's typed `E` channel propagates unchanged. Success is
 *   encoded into a single-element `tuple` (or empty tuple for void).
 *
 * - `errorWrapped === true`: the handler's typed `E` is folded into
 *   `Result.fail(e)` via `Effect.matchEffect`; success becomes
 *   `Result.succeed(s)`. The `Result` is encoded through
 *   `mc.outputElement`, whose codec is `Schema.Result(success, error)`.
 *   `AgentError.custom-error` is NOT used — typed user errors travel
 *   on the success channel as a component-model `result<S, E>`.
 *
 * Defects (`Effect.die`) and SDK-internal failures continue to propagate
 * untouched — they are not user-domain errors and surface as host-level
 * traps / `remote-internal-error`.
 */
const runHandlerAndEncode = <
  Params extends MethodParams,
  Success extends Schema.Top,
  Error extends Schema.Top,
  R,
>(
  mc: MethodCodec<Params, Success, Error>,
  handler: (input: MethodInput<Params>) => Effect.Effect<Success["Type"], Error["Type"], R>,
  decoded: MethodInput<Params>,
): Effect.Effect<
  SchemaValueTree | undefined,
  Error["Type"] | Schema.SchemaError | InvalidDataValueError,
  R
> =>
  Effect.gen(function* () {
    if (mc.errorWrapped) {
      // `output` is always `single` when errorWrapped (Result<S,E> is not unit).
      const codec = (mc.output as { tag: "single"; codec: WitCodec<Schema.Top> }).codec.codec
      const folded = handler(decoded).pipe(
        Effect.matchEffect({
          onFailure: (e: Error["Type"]) =>
            Effect.succeed(Result.fail(e) as Result.Result<unknown, Error["Type"]>),
          onSuccess: (s: Success["Type"]) =>
            // Substitute `{}` for a void success so it round-trips through the
            // empty-record stand-in compiled into `Schema.Result(Schema.Struct({}), error)`.
            Effect.succeed(
              Result.succeed(mc.successVoid ? {} : s) as Result.Result<unknown, Error["Type"]>,
            ),
        }),
      )
      const result = yield* folded
      const sv = yield* Schema.encodeEffect(codec as Schema.Codec<any, SchemaValue, never, never>)(
        result,
      )
      return schemaValueToWit(sv)
    }
    const result = yield* handler(decoded)
    if (mc.output.tag === "unit") return undefined
    const sv = yield* Schema.encodeEffect(
      mc.output.codec.codec as Schema.Codec<any, SchemaValue, never, never>,
    )(result)
    return schemaValueToWit(sv)
  }) as Effect.Effect<
    SchemaValueTree | undefined,
    Error["Type"] | Schema.SchemaError | InvalidDataValueError,
    R
  >

/**
 * Invoke a compiled method using a `schema-value-tree` as input and producing
 * an optional `schema-value-tree` as output (`undefined` for a unit return).
 * The handler is provided separately so the same compiled codec can be paired
 * with different per-instance closures (which is how agents work).
 *
 * Input is the `record` value whose fields line up positionally with the
 * declared parameters. When the method declares a non-Void typed error, the
 * output value is a `result<S, E>` carrying either the success value or the
 * typed failure (the ONLY channel for user-typed errors; `AgentError` is
 * reserved for host/SDK-level conditions).
 *
 * @since 1.6.0
 * @category operations
 */
export const invokeSchemaValue = <
  Params extends MethodParams,
  Success extends Schema.Top,
  Error extends Schema.Top,
  R,
>(
  mc: MethodCodec<Params, Success, Error>,
  handler: (input: MethodInput<Params>) => Effect.Effect<Success["Type"], Error["Type"], R>,
  input: SchemaValueTree,
): Effect.Effect<
  SchemaValueTree | undefined,
  Error["Type"] | Schema.SchemaError | InvalidDataValueError,
  R
> =>
  Effect.gen(function* () {
    const decoded: Record<string, unknown> = {}
    if (mc.inputCodecs.length > 0) {
      const sv = schemaValueFromWit(input)
      if (sv.tag !== "record") {
        return yield* Effect.fail(
          new InvalidDataValueError(`${mc.name}: expected a record input value, got ${sv.tag}`),
        )
      }
      const fields = sv.fields
      if (fields.length !== mc.inputCodecs.length) {
        return yield* Effect.fail(
          new InvalidDataValueError(
            `${mc.name}: expected ${mc.inputCodecs.length} arguments, got ${fields.length}`,
          ),
        )
      }
      for (let i = 0; i < mc.inputCodecs.length; i++) {
        const ic = mc.inputCodecs[i]!
        decoded[ic.name] = yield* Schema.decodeEffect(
          ic.codec.codec as Schema.Codec<any, SchemaValue, never, never>,
        )(fields[i]!)
      }
    }
    return yield* runHandlerAndEncode(mc, handler, decoded as MethodInput<Params>)
  }) as Effect.Effect<
    SchemaValueTree | undefined,
    Error["Type"] | Schema.SchemaError | InvalidDataValueError,
    R
  >
