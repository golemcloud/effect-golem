import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Layer, Schema } from "effect"
import * as Quota from "../src/Quota.js"
import { QuotaToken as QuotaTokenSchema } from "../src/Quota.js"
import { QuotaClient, QuotaLive } from "../src/host/QuotaClient.js"
import { toWitCodec } from "../src/WitCodec.js"
import * as QuotaHost from "golem:quota/types@1.5.0"
import * as QuotaMock from "./mocks/golem-quota-types.js"

// In the `golem:core/types@2.0.0` model the host `QuotaToken` is an opaque,
// affine owned resource. In tests `golem:quota/types@1.5.0` is aliased to the
// mock, whose `QuotaToken` carrier is what `acquireQuotaToken` constructs —
// reference it directly for `instanceof` checks (the `.d.ts` exports the token
// only as a type).
const QuotaToken = QuotaMock.QuotaToken

/**
 * Default Layer-based stub for {@link QuotaClient} used by the
 * operational tests below. Production resolution is unchanged: the
 * `QuotaLive` layer delegates to `golem:quota/types@1.5.0`, which
 * vitest aliases to {@link QuotaMock} — so invocations here exercise
 * the same in-memory mock as before, just plumbed through the layer
 * boundary instead of the legacy `__setX/__resetX` indirection.
 */
const QuotaTestLive: Layer.Layer<QuotaClient> = QuotaLive

describe("QuotaToken schema", () => {
  it.effect("compiles to the schema-model quota-token capability node", () =>
    Effect.gen(function* () {
      const wc = yield* toWitCodec(QuotaTokenSchema as any)
      expect(wc.graph.root.body.tag).toBe("quota-token")
    }),
  )

  it.effect("round-trips a (mock) token end-to-end through the WIT codec", () =>
    Effect.gen(function* () {
      const wc = yield* toWitCodec(QuotaTokenSchema as any)
      const codec = wc.codec as Schema.Codec<QuotaHost.QuotaToken, any, never, never>

      // A freshly minted host token is lowered to a `quota-token` schema value
      // carrying an opaque, affine owned handle, then lifted back out.
      const token = QuotaMock.newToken("cpu", 100n)
      const sv = yield* Schema.encodeEffect(codec)(token)
      expect(sv.tag).toBe("quota-token")

      const back = yield* Schema.decodeEffect(codec)(sv)
      // The owned handle is moved by ownership, so decode yields the same raw
      // token back out of the take-once cell.
      expect(back).toBe(token)
    }),
  )
})

describe("Quota — operational API", () => {
  beforeEach(() => {
    QuotaMock.__reset()
  })
  afterEach(() => {
    QuotaMock.__reset()
  })

  it.effect("acquireQuotaToken constructs a QuotaToken via the host class", () =>
    Effect.gen(function* () {
      const token = yield* Quota.acquireQuotaToken("api-calls", 100n)
      expect(token).toBeInstanceOf(QuotaToken)
      expect(QuotaMock.events).toEqual([
        { tag: "construct", resourceName: "api-calls", expectedUse: 100n },
      ])
    }).pipe(Effect.provide(QuotaTestLive)),
  )

  it.effect("acquireQuotaToken surfaces host failures as QuotaHostError", () =>
    Effect.gen(function* () {
      // Per-test override: `acquireQuotaToken` throws; the other
      // methods stay at their live (mock-routed) impls. Replaces the
      // legacy `__setAcquireQuotaTokenForTest` indirection.
      const failingAcquireLayer = Layer.succeed(
        QuotaClient,
        QuotaClient.of({
          acquireQuotaToken: () => {
            throw new Error("manifest does not declare resource")
          },
          reserve: (t, a) => QuotaHost.reserve(t, a),
          commit: (r, u) => QuotaHost.Reservation.commit(r, u),
          split: (t, c) => QuotaHost.split(t, c),
          merge: (t, o) => QuotaHost.merge(t, o),
        }),
      )
      const exit = yield* Effect.exit(
        Quota.acquireQuotaToken("missing", 1n).pipe(Effect.provide(failingAcquireLayer)),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toMatch(/QuotaHostError/)
      }
    }),
  )

  it.effect("withReservation reserves, runs body, and commits the body's used", () =>
    Effect.gen(function* () {
      const token = yield* Quota.acquireQuotaToken("api-calls", 1n)
      const value = yield* Quota.withReservation(token, 100n, () =>
        Effect.succeed({ used: 42n, value: "ok" }),
      )
      expect(value).toBe("ok")

      const eventTags = QuotaMock.events.map((e) => e.tag)
      expect(eventTags).toEqual(["construct", "reserve", "commit"])
      const commitEv = QuotaMock.events[2]
      if (commitEv.tag !== "commit") throw new Error("unreachable")
      expect(commitEv.used).toBe(42n)
      expect(commitEv.reservedAmount).toBe(100n)
    }).pipe(Effect.provide(QuotaTestLive)),
  )

  it.effect("withReservation commits 0 on body failure (drop semantics)", () =>
    Effect.gen(function* () {
      class Boom {
        readonly _tag = "Boom"
      }
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const token = yield* Quota.acquireQuotaToken("api-calls", 1n)
          return yield* Quota.withReservation(token, 50n, () => Effect.fail(new Boom()))
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toMatch(/Boom/)
      }
      const commitEv = QuotaMock.events.find((e) => e.tag === "commit")
      expect(commitEv).toBeDefined()
      if (commitEv?.tag !== "commit") throw new Error("unreachable")
      expect(commitEv.used).toBe(0n)
    }).pipe(Effect.provide(QuotaTestLive)),
  )

  it.live("withReservation commits 0 on body interruption", () =>
    Effect.gen(function* () {
      let bodyEntered = false
      const token = yield* Quota.acquireQuotaToken("api-calls", 1n)
      const fiber = yield* Effect.forkChild(
        Quota.withReservation(token, 50n, () =>
          Effect.gen(function* () {
            bodyEntered = true
            yield* Effect.never
            return { used: 999n, value: "unreachable" }
          }),
        ),
      )
      // Wait for the body to be entered, then interrupt.
      yield* Effect.sleep("10 millis")
      expect(bodyEntered).toBe(true)
      yield* Fiber.interrupt(fiber)

      const commitEv = QuotaMock.events.find((e) => e.tag === "commit")
      expect(commitEv).toBeDefined()
      if (commitEv?.tag !== "commit") throw new Error("unreachable")
      expect(commitEv.used).toBe(0n)
    }).pipe(Effect.provide(QuotaTestLive)),
  )

  it.effect("withReservation surfaces failed-reservation as FailedReservationError", () =>
    Effect.gen(function* () {
      QuotaMock.__setReserveFails({ estimatedWaitNanos: 5000n })
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const token = yield* Quota.acquireQuotaToken("api-calls", 1n)
          return yield* Quota.withReservation(token, 100n, () =>
            Effect.succeed({ used: 0n, value: "never" }),
          )
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const text = JSON.stringify(exit.cause)
        expect(text).toMatch(/FailedReservationError/)
        expect(text).toMatch(/5000/)
      }
      expect(QuotaMock.events.find((e) => e.tag === "commit")).toBeUndefined()
    }).pipe(Effect.provide(QuotaTestLive)),
  )

  it.effect("manual reserve + commit emits the expected event sequence", () =>
    Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const token = yield* Quota.acquireQuotaToken("api-calls", 1n)
          const reservation = yield* Quota.reserve(token, 10n)
          yield* Quota.commit(reservation, 7n)
        }),
      )
      const eventTags = QuotaMock.events.map((e) => e.tag)
      expect(eventTags).toEqual(["construct", "reserve", "commit"])
      const commitEv = QuotaMock.events[2]
      if (commitEv.tag !== "commit") throw new Error("unreachable")
      expect(commitEv.used).toBe(7n)
    }).pipe(Effect.provide(QuotaTestLive)),
  )

  it.effect("reserve auto-commits 0 on scope close when not explicitly committed", () =>
    Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const token = yield* Quota.acquireQuotaToken("api-calls", 1n)
          yield* Quota.reserve(token, 10n)
          // No explicit commit — scope close fires the finalizer.
        }),
      )
      const commits = QuotaMock.events.filter((e) => e.tag === "commit")
      expect(commits).toHaveLength(1)
      if (commits[0].tag !== "commit") throw new Error("unreachable")
      expect(commits[0].used).toBe(0n)
    }).pipe(Effect.provide(QuotaTestLive)),
  )

  it.effect("commit twice on the same reservation fails with QuotaHostError", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const token = yield* Quota.acquireQuotaToken("api-calls", 1n)
            const reservation = yield* Quota.reserve(token, 10n)
            yield* Quota.commit(reservation, 5n)
            yield* Quota.commit(reservation, 1n)
          }),
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toMatch(/already committed/)
      }
    }).pipe(Effect.provide(QuotaTestLive)),
  )

  it.effect("manual reserve surfaces failed-reservation typed error", () =>
    Effect.gen(function* () {
      QuotaMock.__setReserveFails({ estimatedWaitNanos: undefined })
      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const token = yield* Quota.acquireQuotaToken("api-calls", 1n)
            return yield* Quota.reserve(token, 10n)
          }),
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toMatch(/FailedReservationError/)
      }
    }).pipe(Effect.provide(QuotaTestLive)),
  )

  it.effect("manual reserve surfaces non-failed-reservation throws as QuotaHostError", () =>
    Effect.gen(function* () {
      QuotaMock.__setReserveThrows(new Error("host invariant violated"))
      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const token = yield* Quota.acquireQuotaToken("api-calls", 1n)
            return yield* Quota.reserve(token, 10n)
          }),
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const text = JSON.stringify(exit.cause)
        expect(text).toMatch(/QuotaHostError/)
        expect(text).not.toMatch(/FailedReservationError/)
      }
    }).pipe(Effect.provide(QuotaTestLive)),
  )

  it.effect("split delegates to the host and returns a child token", () =>
    Effect.gen(function* () {
      const parent = yield* Quota.acquireQuotaToken("api-calls", 1000n)
      const child = yield* Quota.split(parent, 300n)
      expect(child).toBeInstanceOf(QuotaToken)
      const splits = QuotaMock.events.filter((e) => e.tag === "split")
      expect(splits).toHaveLength(1)
      if (splits[0].tag !== "split") throw new Error("unreachable")
      expect(splits[0].childExpectedUse).toBe(300n)
    }).pipe(Effect.provide(QuotaTestLive)),
  )

  it.effect("split overflow surfaces as QuotaHostError", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const parent = yield* Quota.acquireQuotaToken("api-calls", 100n)
          return yield* Quota.split(parent, 999n)
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toMatch(/QuotaHostError/)
      }
    }).pipe(Effect.provide(QuotaTestLive)),
  )

  it.effect("merge delegates to the host", () =>
    Effect.gen(function* () {
      const a = yield* Quota.acquireQuotaToken("api-calls", 500n)
      const b = yield* Quota.acquireQuotaToken("api-calls", 500n)
      yield* Quota.merge(a, b)
      const merges = QuotaMock.events.filter((e) => e.tag === "merge")
      expect(merges).toHaveLength(1)
    }).pipe(Effect.provide(QuotaTestLive)),
  )

  it.effect("merge of mismatched resources surfaces as QuotaHostError", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const a = yield* Quota.acquireQuotaToken("api-calls", 500n)
          const b = yield* Quota.acquireQuotaToken("storage", 500n)
          yield* Quota.merge(a, b)
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toMatch(/QuotaHostError/)
      }
    }).pipe(Effect.provide(QuotaTestLive)),
  )
})
