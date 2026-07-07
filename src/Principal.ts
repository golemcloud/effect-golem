/**
 * @since 1.5.0
 */
import { Context, Schema } from "effect"
import type * as AgentCommon from "golem:agent/common@1.5.0"
import { witPrincipalAnnotationKey } from "./WitTypes.js"

const PRINCIPAL_TAGS = ["oidc", "agent", "golem-user", "anonymous"]

/**
 * Identity of an authenticated agent caller. Mirrors the WIT
 * `golem:agent/common@1.5.0` `principal` discriminated union.
 *
 * Re-exported here so users of `effect-golem` do not need to import the
 * ambient `golem:agent/common@1.5.0` module directly. (Named
 * `PrincipalValue` to avoid a clash with the {@link Principal} service
 * class below — `yield* Principal` returns a `PrincipalValue`.)
 *
 * @since 1.5.0
 * @category models
 */
export type PrincipalValue = AgentCommon.Principal

/**
 * OIDC-authenticated principal variant of {@link PrincipalValue}.
 *
 * @since 1.5.0
 * @category models
 */
export type OidcPrincipal = AgentCommon.OidcPrincipal

/**
 * Agent-to-agent principal variant of {@link PrincipalValue}.
 *
 * @since 1.5.0
 * @category models
 */
export type AgentPrincipal = AgentCommon.AgentPrincipal

/**
 * Golem-user principal variant of {@link PrincipalValue}.
 *
 * @since 1.5.0
 * @category models
 */
export type GolemUserPrincipal = AgentCommon.GolemUserPrincipal

/**
 * Effect service exposing the active {@link Principal}.
 *
 * The framework provides this service automatically at the dispatch
 * boundary:
 *
 * - inside an agent's `impl` (constructor) effect it resolves to the
 *   principal the host passed to `agent-guest.guest.initialize`;
 * - inside a method handler it resolves to the principal the host
 *   passed to `agent-guest.guest.invoke` for that specific call (which
 *   may differ from the initialize-time principal, e.g. when other
 *   callers reach a durable agent instance).
 *
 * The dispatcher always provides this service before running user code,
 * so depending on it from inside an agent never leaks into the public
 * `R` slot of method/constructor signatures. In tests that bypass the
 * dispatcher you must provide it explicitly with
 * `Effect.provideService(Principal, …)`.
 *
 * **Example**
 *
 * ```ts
 * impl: () =>
 *   Effect.gen(function* () {
 *     const owner = yield* Principal
 *     return {
 *       whoCalled: () =>
 *         Effect.gen(function* () {
 *           const caller = yield* Principal
 *           return caller.tag
 *         }),
 *     }
 *   })
 * ```
 *
 * @since 1.5.0
 * @category host services
 */
export class Principal extends Context.Service<Principal, AgentCommon.Principal>()(
  "effect-golem/Principal",
) {}

/**
 * Schema for a {@link PrincipalValue} carried as ordinary structured data in a
 * method parameter or return value — the WIT `golem:agent/common` `principal`
 * variant (`oidc` / `agent` / `golem-user` / `anonymous`).
 *
 * Unlike the {@link Principal} service (a capability read of the *current*
 * caller), this schema lets a `Principal` travel as a plain value: use it as a
 * method `input` / `success` schema, or nest it inside a `Schema.Struct`. The
 * schema is annotated with `witPrincipalAnnotationKey`; the codec
 * (`toWitCodec`) recognises the annotation and lowers it to the `principal`
 * variant, round-tripping the host `Principal` shape exactly (case order
 * `oidc` / `agent` / `golem-user` / `anonymous`).
 *
 * **Example**
 *
 * ```ts
 * method({ input: { caller: PrincipalSchema }, success: Schema.String })
 * ```
 *
 * @since 1.6.0
 * @category codecs
 */
export const PrincipalSchema: Schema.Schema<AgentCommon.Principal> = Schema.declare(
  (u): u is AgentCommon.Principal =>
    typeof u === "object" &&
    u !== null &&
    typeof (u as { tag?: unknown }).tag === "string" &&
    PRINCIPAL_TAGS.includes((u as { tag: string }).tag),
).pipe(Schema.annotate({ [witPrincipalAnnotationKey]: true }))
