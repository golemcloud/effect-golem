import { describe, expect, it, beforeEach } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Layer, Result, Schema } from "effect"
import { defineAgent } from "../src/Agent.js"
import { method } from "../src/Method.js"
import { defineConfig } from "../src/Config.js"
import { DurabilityModeLive } from "../src/host/DurabilityModeClient.js"
import * as RpcFake from "./host/RpcFake.js"
import { __resetIdempotency } from "./mocks/golem-api-host.js"
import {
  schemaValueFromWit,
  schemaValueToWit,
  v,
  type SchemaValue,
} from "../src/internal/schema-model/index.js"

const Counter = defineAgent({
  name: "Counter",
  mode: "durable",
  constructorParams: { initial: Schema.Number },
  methods: {
    getValue: method({ params: {}, success: Schema.Number }),
    add: method({ params: { by: Schema.Number }, success: Schema.Void }),
  },
}).implement(() =>
  Effect.succeed({
    getValue: () => Effect.succeed(0),
    add: () => Effect.void,
  }),
)

const Worker = defineAgent({
  name: "Worker",
  mode: "ephemeral",
  constructorParams: { jobId: Schema.String },
  methods: {
    run: method({ params: { times: Schema.Number }, success: Schema.String }),
  },
}).implement(() =>
  Effect.succeed({
    run: () => Effect.succeed("ok"),
  }),
)

/**
 * Decode a `SchemaValue` (the new schema-value-tree leaf the codec
 * yields) back to its decoded TS value. On the schema-value model the
 * encoded form is a `SchemaValue`, so `decodeEffect` takes one directly.
 */
const decodeSv = <S extends Schema.Top>(s: S, sv: SchemaValue): Effect.Effect<S["Type"], unknown> =>
  Effect.gen(function* () {
    const { toWitCodec } = yield* Effect.promise(() => import("../src/WitCodec.js"))
    const codec = yield* toWitCodec(s)
    return yield* Schema.decodeEffect(codec.codec)(sv) as Effect.Effect<S["Type"], unknown, never>
  })

/**
 * Encode a TS value to its `SchemaValue` form through the schema's
 * WitCodec. Used to build the fake host's response trees and to assert
 * on recorded constructor / method input trees.
 */
const encodeSv = <S extends Schema.Top>(
  s: S,
  value: S["Type"],
): Effect.Effect<SchemaValue, unknown> =>
  Effect.gen(function* () {
    const { toWitCodec } = yield* Effect.promise(() => import("../src/WitCodec.js"))
    const codec = yield* toWitCodec(s)
    return yield* Schema.encodeEffect(codec.codec)(value) as Effect.Effect<SchemaValue, unknown, never>
  })

/**
 * Build a fresh RpcFake plus a composed runtime layer (RpcFake +
 * DurabilityModeLive) ready to be plugged into `Effect.provide`. Used
 * in every test below — the RPC fake is per-instance so each test
 * starts with a clean responder + recording log + cancellation log.
 *
 * `DurabilityModeLive` delegates to the module-level
 * `test/mocks/golem-api-host.ts` mock (aliased via vitest's
 * `golemAliases`); the deterministic UUID counter is reset in
 * `beforeEach` via `__resetIdempotency()`.
 */
const makeRpcRuntime = Effect.gen(function* () {
  const fake = yield* RpcFake.make
  const layer = Layer.mergeAll(fake.layer, DurabilityModeLive)
  return { fake, layer }
})

describe("AgentClient (durable)", () => {
  beforeEach(() => {
    __resetIdempotency()
  })

  it("attaches `client` to the defineAgent return value", () => {
    expect(typeof Counter.client.get).toBe("function")
    expect(typeof Counter.client.getPhantom).toBe("function")
    expect(typeof Counter.client.newPhantom).toBe("function")
  })

  it.effect("get(): constructs a WasmRpc with no phantomId and round-trips a method call", () =>
    Effect.gen(function* () {
      const { fake, layer } = yield* makeRpcRuntime
      const numSv = yield* encodeSv(Schema.Number, 42)
      yield* fake.setResponder(({ methodName }) => {
        if (methodName === "getValue") {
          return {
            tag: "ok",
            val: schemaValueToWit(numSv),
          }
        }
        return { tag: "throw", error: new Error("unexpected method") }
      })

      const result = yield* Effect.provide(
        Effect.gen(function* () {
          const remote = yield* Counter.client.get({ initial: 7 })
          return yield* remote.getValue({})
        }) as Effect.Effect<number, unknown, never>,
        layer,
      )
      expect(result).toBe(42)

      const calls = yield* fake.getRecordedCalls
      expect(calls.length).toBe(1)
      const c = calls[0]!
      expect(c.kind).toBe("asyncInvokeAndAwait")
      expect(c.methodName).toBe("getValue")
      expect(c.agentTypeName).toBe("Counter")
      expect(c.phantomId).toBeUndefined()
      // constructor input is a record<{ initial: f64 }>
      const ctorSv = schemaValueFromWit(c.constructorValue) as any
      expect(ctorSv.tag).toBe("record")
      expect(ctorSv.fields.length).toBe(1)
      const decodedCtor = yield* decodeSv(Schema.Number, ctorSv.fields[0])
      expect(decodedCtor).toBe(7)
    }),
  )

  it.effect("get(): encodes named method args positionally", () =>
    Effect.gen(function* () {
      const { fake, layer } = yield* makeRpcRuntime
      // `add` returns Schema.Void (unit) → host returns no value.
      yield* fake.setResponder(() => ({
        tag: "ok",
        val: undefined,
      }))
      yield* Effect.provide(
        Effect.gen(function* () {
          const remote = yield* Counter.client.get({ initial: 0 })
          yield* remote.add({ by: 5 })
        }) as Effect.Effect<void, unknown, never>,
        layer,
      )

      const calls = yield* fake.getRecordedCalls
      const c = calls[0]!
      expect(c.methodName).toBe("add")
      const inputSv = schemaValueFromWit(c.input) as any
      expect(inputSv.tag).toBe("record")
      expect(inputSv.fields.length).toBe(1)
      const decoded = yield* decodeSv(Schema.Number, inputSv.fields[0])
      expect(decoded).toBe(5)
    }),
  )

  it.effect("trigger(): uses fire-and-forget invoke and resolves to void", () =>
    Effect.gen(function* () {
      const { fake, layer } = yield* makeRpcRuntime
      yield* fake.setResponder(() => ({ tag: "ok", val: undefined }))
      yield* Effect.provide(
        Effect.gen(function* () {
          const remote = yield* Counter.client.get({ initial: 0 })
          yield* remote.add.trigger({ by: 9 })
        }) as Effect.Effect<void, unknown, never>,
        layer,
      )

      const calls = yield* fake.getRecordedCalls
      const c = calls[0]!
      expect(c.kind).toBe("invoke")
    }),
  )

  it.effect("schedule(): records scheduledTime and returns a cancel handle", () =>
    Effect.gen(function* () {
      const { fake, layer } = yield* makeRpcRuntime
      const at = { seconds: 1n, nanoseconds: 0 }
      yield* Effect.provide(
        Effect.gen(function* () {
          const remote = yield* Counter.client.get({ initial: 0 })
          const cancelHandle = yield* remote.add.schedule(at, { by: 1 })
          yield* cancelHandle.cancel()
        }) as Effect.Effect<void, unknown, never>,
        layer,
      )

      const calls = yield* fake.getRecordedCalls
      const c = calls[0]!
      expect(c.kind).toBe("schedule")
      expect(c.scheduledTime).toEqual(at)

      const cancellations = yield* fake.getCancellations
      expect(cancellations.length).toBe(1)
      expect(cancellations[0]).toEqual({ kind: "scheduled", methodName: "add" })
    }),
  )

  it.effect("getPhantom(): parses the uuid and forwards it to the WasmRpc constructor", () =>
    Effect.gen(function* () {
      const { fake, layer } = yield* makeRpcRuntime
      yield* fake.setResponder(() => ({ tag: "ok", val: undefined }))
      const phantomId = "12345678-1234-1234-1234-1234567890ab"
      yield* Effect.provide(
        Effect.gen(function* () {
          const remote = yield* Counter.client.getPhantom({ initial: 0 }, phantomId)
          yield* remote.add({ by: 1 })
        }) as Effect.Effect<void, unknown, never>,
        layer,
      )

      const calls = yield* fake.getRecordedCalls
      const c = calls[0]!
      expect(c.phantomId).toBeDefined()
      expect((c.phantomId as any).highBits).toBe(BigInt("0x1234567812341234"))
      expect((c.phantomId as any).lowBits).toBe(BigInt("0x12341234567890ab"))
    }),
  )

  it.effect("getPhantom(): fails with InvalidUuidError on a malformed string", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeRpcRuntime
      const result = yield* Effect.provide(
        Effect.result(
          Counter.client.getPhantom({ initial: 0 }, "not-a-uuid") as Effect.Effect<
            unknown,
            any,
            never
          >,
        ),
        layer,
      )
      expect(result._tag).toBe("Failure")
      if (result._tag !== "Failure") return
      const failure: any = result.failure
      expect(failure._tag).toBe("InvalidUuidError")
      expect(failure.value).toBe("not-a-uuid")
    }),
  )

  it.effect("newPhantom(): generates a fresh phantom id and exposes it on the remote handle", () =>
    Effect.gen(function* () {
      const { fake, layer } = yield* makeRpcRuntime
      yield* fake.setResponder(() => ({ tag: "ok", val: undefined }))
      const remote = yield* Effect.provide(
        Effect.gen(function* () {
          const remote = yield* Counter.client.newPhantom({ initial: 0 })
          yield* remote.add({ by: 1 })
          return remote
        }) as Effect.Effect<{ phantomId: string; add: any }, unknown, never>,
        layer,
      )
      expect(remote.phantomId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )
      const calls = yield* fake.getRecordedCalls
      const c = calls[0]!
      expect(c.phantomId).toBeDefined()
      expect((c.phantomId as any).lowBits).toBe(1n)
    }),
  )

  it.effect("RpcError from the host is surfaced as RpcCallError", () =>
    Effect.gen(function* () {
      const { fake, layer } = yield* makeRpcRuntime
      yield* fake.setResponder(() => ({
        tag: "throw",
        error: { tag: "remote-internal-error", val: "boom" },
      }))
      const result = yield* Effect.provide(
        Effect.result(
          Effect.gen(function* () {
            const remote = yield* Counter.client.get({ initial: 0 })
            return yield* remote.getValue({})
          }) as Effect.Effect<unknown, any, never>,
        ),
        layer,
      )
      expect(result._tag).toBe("Failure")
      if (result._tag !== "Failure") return
      const failure: any = result.failure
      expect(failure._tag).toBe("RpcCallError")
      expect(failure.cause).toEqual({ tag: "remote-internal-error", val: "boom" })
    }),
  )

  // The wasm-rquickjs host glue throws via `ctx.throw(IntoJs::into_js(err))`,
  // and in some async / wrapper paths the QuickJS runtime re-wraps the
  // bare tagged object inside a JS `Error` instance whose `.payload` (or
  // `.cause`) carries the actual variant. Without unwrapping, every
  // `denied / not-found / remote-internal-error / remote-agent-error`
  // would collapse into a misleading `protocol-error` containing the
  // Error's `.message` string — defeating typed-error pattern-matching
  // on `failure.cause.tag`.
  for (const tag of ["protocol-error", "denied", "not-found", "remote-internal-error"] as const) {
    it.effect(`Error.payload-wrapped ${tag} is surfaced with the original tag preserved`, () =>
      Effect.gen(function* () {
        const { fake, layer } = yield* makeRpcRuntime
        yield* fake.setResponder(() => {
          const err = new Error(`${tag}: boom`)
          ;(err as unknown as { payload: unknown }).payload = { tag, val: "boom" }
          return { tag: "throw", error: err }
        })
        const result = yield* Effect.provide(
          Effect.result(
            Effect.gen(function* () {
              const remote = yield* Counter.client.get({ initial: 0 })
              return yield* remote.getValue({})
            }) as Effect.Effect<unknown, any, never>,
          ),
          layer,
        )
        expect(result._tag).toBe("Failure")
        if (result._tag !== "Failure") return
        const failure: any = result.failure
        expect(failure._tag).toBe("RpcCallError")
        expect(failure.cause).toEqual({ tag, val: "boom" })
      }),
    )
  }

  it.effect("Error.cause-wrapped denied is surfaced with the original tag preserved", () =>
    Effect.gen(function* () {
      const { fake, layer } = yield* makeRpcRuntime
      yield* fake.setResponder(() => {
        const err = new Error("denied: nope")
        ;(err as unknown as { cause: unknown }).cause = { tag: "denied", val: "nope" }
        return { tag: "throw", error: err }
      })
      const result = yield* Effect.provide(
        Effect.result(
          Effect.gen(function* () {
            const remote = yield* Counter.client.get({ initial: 0 })
            return yield* remote.getValue({})
          }) as Effect.Effect<unknown, any, never>,
        ),
        layer,
      )
      expect(result._tag).toBe("Failure")
      if (result._tag !== "Failure") return
      const failure: any = result.failure
      expect(failure._tag).toBe("RpcCallError")
      expect(failure.cause).toEqual({ tag: "denied", val: "nope" })
    }),
  )

  it.effect(
    "Error.payload-wrapped remote-agent-error preserves the structured AgentError val",
    () =>
      Effect.gen(function* () {
        const { fake, layer } = yield* makeRpcRuntime
        // On the schema-value model a `custom-error` carries a
        // `typed-schema-value` (a value tree + its schema graph). This
        // payload is opaque to the client — it travels through the
        // RpcError channel untouched and is asserted via `toEqual`, so
        // the exact tree shape here is illustrative (an empty record).
        const agentError = {
          tag: "custom-error",
          val: { value: schemaValueToWit(v.record([])), schema: undefined },
        }
        yield* fake.setResponder(() => {
          const err = new Error("remote-agent-error: typed failure")
          ;(err as unknown as { payload: unknown }).payload = {
            tag: "remote-agent-error",
            val: agentError,
          }
          return { tag: "throw", error: err }
        })
        const result = yield* Effect.provide(
          Effect.result(
            Effect.gen(function* () {
              const remote = yield* Counter.client.get({ initial: 0 })
              return yield* remote.getValue({})
            }) as Effect.Effect<unknown, any, never>,
          ),
          layer,
        )
        expect(result._tag).toBe("Failure")
        if (result._tag !== "Failure") return
        const failure: any = result.failure
        expect(failure._tag).toBe("RpcCallError")
        expect(failure.cause.tag).toBe("remote-agent-error")
        expect(failure.cause.val).toEqual(agentError)
      }),
  )

  it.effect("Error without a tagged payload/cause falls back to protocol-error", () =>
    Effect.gen(function* () {
      const { fake, layer } = yield* makeRpcRuntime
      yield* fake.setResponder(() => ({
        tag: "throw",
        error: new Error("opaque host failure"),
      }))
      const result = yield* Effect.provide(
        Effect.result(
          Effect.gen(function* () {
            const remote = yield* Counter.client.get({ initial: 0 })
            return yield* remote.getValue({})
          }) as Effect.Effect<unknown, any, never>,
        ),
        layer,
      )
      expect(result._tag).toBe("Failure")
      if (result._tag !== "Failure") return
      const failure: any = result.failure
      expect(failure._tag).toBe("RpcCallError")
      expect(failure.cause).toEqual({ tag: "protocol-error", val: "opaque host failure" })
    }),
  )

  it.effect("Error whose .payload has an unknown tag falls back to protocol-error", () =>
    Effect.gen(function* () {
      const { fake, layer } = yield* makeRpcRuntime
      yield* fake.setResponder(() => {
        const err = new Error("looks tagged but isn't")
        ;(err as unknown as { payload: unknown }).payload = { tag: "not-a-real-tag", val: "x" }
        return { tag: "throw", error: err }
      })
      const result = yield* Effect.provide(
        Effect.result(
          Effect.gen(function* () {
            const remote = yield* Counter.client.get({ initial: 0 })
            return yield* remote.getValue({})
          }) as Effect.Effect<unknown, any, never>,
        ),
        layer,
      )
      expect(result._tag).toBe("Failure")
      if (result._tag !== "Failure") return
      const failure: any = result.failure
      expect(failure._tag).toBe("RpcCallError")
      expect(failure.cause).toEqual({ tag: "protocol-error", val: "looks tagged but isn't" })
    }),
  )
})

describe("AgentClient overrides (config)", () => {
  beforeEach(() => {
    __resetIdempotency()
  })

  class CounterCfg extends defineConfig("CounterClient.Cfg", {
    greeting: Schema.String,
    apiKey: Schema.Redacted(Schema.String),
  }) {}

  const Counter2 = defineAgent({
    name: "Counter2",
    config: CounterCfg,
    constructorParams: { initial: Schema.Number },
    methods: {
      noop: method({ params: {}, success: Schema.Void }),
    },
  }).implement(() =>
    Effect.succeed({
      noop: () => Effect.void,
    }),
  )

  it.effect(
    "forwards non-secret overrides to the WasmRpc constructor as TypedAgentConfigValue[]",
    () =>
      Effect.gen(function* () {
        const { fake, layer } = yield* makeRpcRuntime
        yield* fake.setResponder(() => ({ tag: "ok", val: undefined }))
        yield* Effect.provide(
          Effect.gen(function* () {
            const remote = yield* Counter2.client.get(
              { initial: 0 },
              { overrides: { greeting: "hi" } },
            )
            yield* remote.noop({})
          }) as Effect.Effect<void, unknown, never>,
          layer,
        )

        const calls = yield* fake.getRecordedCalls
        const c = calls[0]!
        // The override is encoded into the agentConfig array passed
        // to the WasmRpc constructor.
        const cfg = c.agentConfig
        expect(cfg.length).toBe(1)
        const cfgEntry: any = cfg[0]
        expect(cfgEntry.path).toEqual(["greeting"])
      }),
  )
})

describe("AgentClient (ephemeral)", () => {
  beforeEach(() => {
    __resetIdempotency()
  })

  it("ephemeral mode hides `get`; only phantom variants are present at runtime", () => {
    // `get` is stripped at the type level; cast for the runtime-only check.
    expect((Worker.client as any).get).toBeUndefined()
    expect(typeof Worker.client.getPhantom).toBe("function")
    expect(typeof Worker.client.newPhantom).toBe("function")
  })

  it.effect("newPhantom on ephemeral can invoke methods", () =>
    Effect.gen(function* () {
      const { fake, layer } = yield* makeRpcRuntime
      const okSv = yield* encodeSv(Schema.String, "done")
      yield* fake.setResponder(({ methodName }) => {
        if (methodName === "run") {
          return {
            tag: "ok",
            val: schemaValueToWit(okSv),
          }
        }
        return { tag: "throw", error: new Error("unexpected") }
      })
      const remote = yield* Effect.provide(
        Effect.gen(function* () {
          const remote = yield* Worker.client.newPhantom({ jobId: "j-1" })
          const out = yield* remote.run({ times: 3 })
          expect(out).toBe("done")
          return remote
        }) as Effect.Effect<{ phantomId: string }, unknown, never>,
        layer,
      )
      expect(remote.phantomId).toMatch(/^[0-9a-f-]{36}$/)

      const calls = yield* fake.getRecordedCalls
      expect(calls.length).toBe(1)
      expect(calls[0]!.agentTypeName).toBe("Worker")
      const inputSv = schemaValueFromWit(calls[0]!.input) as any
      const decoded = yield* decodeSv(Schema.Number, inputSv.fields[0])
      expect(decoded).toBe(3)
    }),
  )
})

describe("AgentClient (interruptibility)", () => {
  beforeEach(() => {
    __resetIdempotency()
  })

  // These tests rely on real-time scheduling (Effect.sleep + Fiber.interrupt
  // dance, Effect.raceFirst against Effect.sleep) — TestClock would block
  // indefinitely waiting for time advancement, so we use `it.live`.

  it.live("fiber-interrupt during in-flight invoke triggers fut.cancel() on the host", () =>
    Effect.gen(function* () {
      const { fake, layer } = yield* makeRpcRuntime
      yield* fake.setResponder(({ methodName }) =>
        methodName === "getValue" ? { tag: "pending" } : { tag: "throw", error: new Error("?") },
      )

      const exit = yield* Effect.provide(
        Effect.gen(function* () {
          const remote = yield* Counter.client.get({ initial: 0 })
          const fiber = yield* Effect.forkChild(remote.getValue({}))
          // Yield once so the fiber starts the invoke and parks on the
          // pollable's abortable promise.
          yield* Effect.sleep("1 millis")
          yield* Fiber.interrupt(fiber)
          return yield* Fiber.await(fiber)
        }) as Effect.Effect<Exit.Exit<unknown, unknown>, never, never>,
        layer,
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      expect(Cause.hasInterrupts(exit.cause)).toBe(true)

      const cancellations = yield* fake.getCancellations
      expect(cancellations.length).toBe(1)
      expect(cancellations[0]).toEqual({ kind: "async", methodName: "getValue" })

      // The producer ran exactly once (the initial `ensureResolved`
      // call); the post-interrupt no-op `resolvePending` was never
      // issued, so no second resumption could leak through.
      const count = yield* fake.getProduceCallCount("getValue")
      expect(count).toBe(1)
    }),
  )

  it.live("Effect.raceFirst interrupting an invoke triggers fut.cancel() (timeout pattern)", () =>
    Effect.gen(function* () {
      const { fake, layer } = yield* makeRpcRuntime
      yield* fake.setResponder(({ methodName }) =>
        methodName === "getValue" ? { tag: "pending" } : { tag: "throw", error: new Error("?") },
      )

      const exit = yield* Effect.provide(
        Effect.exit(
          Effect.gen(function* () {
            const remote = yield* Counter.client.get({ initial: 0 })
            // `raceFirst` returns the first effect to complete with ANY
            // outcome; the loser (the invoke) is interrupted. That
            // interrupt path MUST propagate to the host cancel via the
            // acquireUseRelease `release` clause.
            return yield* Effect.raceFirst(
              remote.getValue({}),
              Effect.sleep("5 millis").pipe(Effect.andThen(Effect.fail("timeout" as const))),
            )
          }) as Effect.Effect<number, "timeout" | unknown, never>,
        ),
        layer,
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      // The race produced a typed failure ("timeout") on the winning side.
      expect(Cause.hasFails(exit.cause)).toBe(true)

      const cancellations = yield* fake.getCancellations
      expect(cancellations.length).toBe(1)
      expect(cancellations[0]).toEqual({ kind: "async", methodName: "getValue" })
    }),
  )

  it.effect(
    "successful completion still calls fut.cancel() exactly once via release (WIT-contract no-op)",
    () =>
      Effect.gen(function* () {
        const { fake, layer } = yield* makeRpcRuntime
        const numSv = yield* encodeSv(Schema.Number, 99)
        yield* fake.setResponder(({ methodName }) => {
          if (methodName === "getValue") {
            return {
              tag: "ok",
              val: schemaValueToWit(numSv),
            }
          }
          return { tag: "throw", error: new Error("unexpected method") }
        })

        const result = yield* Effect.provide(
          Effect.gen(function* () {
            const remote = yield* Counter.client.get({ initial: 0 })
            return yield* remote.getValue({})
          }) as Effect.Effect<number, unknown, never>,
          layer,
        )
        expect(result).toBe(99)

        // The acquireUseRelease `release` clause runs on every exit
        // including success. The host's WIT contract guarantees this is a
        // no-op once the invocation has completed; if that ever changes,
        // this test is the canary.
        const cancellations = yield* fake.getCancellations
        expect(cancellations.length).toBe(1)
        expect(cancellations[0]).toEqual({ kind: "async", methodName: "getValue" })
      }),
  )

  it.effect("error completion still calls fut.cancel() from release", () =>
    Effect.gen(function* () {
      const { fake, layer } = yield* makeRpcRuntime
      yield* fake.setResponder(() => ({
        tag: "throw",
        error: { tag: "remote-internal-error", val: "boom" },
      }))

      const result = yield* Effect.provide(
        Effect.result(
          Effect.gen(function* () {
            const remote = yield* Counter.client.get({ initial: 0 })
            return yield* remote.getValue({})
          }) as Effect.Effect<number, unknown, never>,
        ),
        layer,
      )
      expect(result._tag).toBe("Failure")

      const cancellations = yield* fake.getCancellations
      expect(cancellations.length).toBe(1)
      expect(cancellations[0]).toEqual({ kind: "async", methodName: "getValue" })
    }),
  )

  it.effect(
    "WasmRpc constructor throw short-circuits before any future is created (no release)",
    () =>
      Effect.gen(function* () {
        const { fake, layer } = yield* makeRpcRuntime
        // Constructor failure happens during `Counter.client.get(...)`,
        // before `acquireUseRelease`'s acquire opens a future. Verifies
        // the SDK doesn't fabricate a phantom cancel in this path.
        yield* fake.failConstructorOnce(() => ({ tag: "protocol-error", val: "no remote" }))

        const result = yield* Effect.provide(
          Effect.result(
            Effect.gen(function* () {
              const remote = yield* Counter.client.get({ initial: 0 })
              return yield* remote.getValue({})
            }) as Effect.Effect<number, unknown, never>,
          ),
          layer,
        )
        expect(result._tag).toBe("Failure")

        // No future was created, so `release` had nothing to cancel.
        const cancellations = yield* fake.getCancellations
        expect(cancellations.length).toBe(0)
      }),
  )

  it.effect(
    "synchronous throw inside the Effect.callback register is converted to RemoteCallError",
    () =>
      Effect.gen(function* () {
        const { fake, layer } = yield* makeRpcRuntime
        // Drive the SDK's register-function-level try/catch by making
        // `fut.subscribe()` throw on the next call. Without the guard,
        // this would escape as an Effect defect.
        yield* fake.failSubscribeOnce(() => ({ tag: "protocol-error", val: "subscribe boom" }))

        const result = yield* Effect.provide(
          Effect.result(
            Effect.gen(function* () {
              const remote = yield* Counter.client.get({ initial: 0 })
              return yield* remote.getValue({})
            }) as Effect.Effect<number, unknown, never>,
          ),
          layer,
        )
        expect(result._tag).toBe("Failure")
        if (result._tag !== "Failure") return
        const failure: any = result.failure
        expect(failure._tag).toBe("RpcCallError")
        expect(failure.cause).toEqual({ tag: "protocol-error", val: "subscribe boom" })

        // The future WAS created by `acquireUseRelease`'s acquire (the
        // throw happens inside `use`). So `release` runs `fut.cancel()`
        // exactly once.
        const cancellations = yield* fake.getCancellations
        expect(cancellations.length).toBe(1)
        expect(cancellations[0]).toEqual({ kind: "async", methodName: "getValue" })
      }),
  )

  it.live("late resolvePending after interrupt does NOT leak a second resumption", () =>
    Effect.gen(function* () {
      const { fake, layer } = yield* makeRpcRuntime
      yield* fake.setResponder(({ methodName }) =>
        methodName === "getValue" ? { tag: "pending" } : { tag: "throw", error: new Error("?") },
      )

      const exit = yield* Effect.provide(
        Effect.gen(function* () {
          const remote = yield* Counter.client.get({ initial: 0 })
          const fiber = yield* Effect.forkChild(remote.getValue({}))
          yield* Effect.sleep("1 millis")
          yield* Fiber.interrupt(fiber)
          return yield* Fiber.await(fiber)
        }) as Effect.Effect<Exit.Exit<unknown, unknown>, never, never>,
        layer,
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      expect(Cause.hasInterrupts(exit.cause)).toBe(true)

      // After interrupt, `fut.cancel()` already marked the future
      // cancelled, so a late host resolution is silently dropped by the
      // fake's `resolve` guard. The producer ran exactly once.
      const beforeCount = yield* fake.getProduceCallCount("getValue")
      expect(beforeCount).toBe(1)

      // Drive the late resolution explicitly. It must not crash, and
      // the producer count must NOT increment (the future is already
      // cancelled). The cancellations list also stays at 1.
      const numSv = yield* encodeSv(Schema.Number, 7)
      yield* fake.resolvePending("getValue", {
        tag: "ok",
        val: schemaValueToWit(numSv),
      })

      const afterCount = yield* fake.getProduceCallCount("getValue")
      expect(afterCount).toBe(1)
      const cancellations = yield* fake.getCancellations
      expect(cancellations.length).toBe(1)
    }),
  )
})

// ---------------------------------------------------------------------------
// Typed errors — the wire response is a `result<S, E>` schema-value tree
// carried as the method's single output value. Verifies the *client* side
// of the "RemoteMethod over-promises typed remote failures" fix: the
// `RemoteMethod`'s typed E channel actually delivers when the host returns
// a `Result.fail(...)`-encoded value, and a successful Result unwraps to
// the bare success value.
// ---------------------------------------------------------------------------

const NotFoundErr = Schema.Struct({
  _tag: Schema.Literal("NotFoundErr"),
  resource: Schema.String,
})

const Lookup = defineAgent({
  name: "Lookup",
  mode: "durable",
  constructorParams: { realm: Schema.String },
  methods: {
    fetch: method({
      params: { id: Schema.String },
      success: Schema.Number,
      error: NotFoundErr,
    }),
    cmd: method({
      params: { fail: Schema.Boolean },
      success: Schema.Void,
      error: NotFoundErr,
    }),
  },
}).implement(() =>
  Effect.succeed({
    fetch: () => Effect.succeed(0),
    cmd: () => Effect.void,
  }),
)

describe("AgentClient — typed errors", () => {
  beforeEach(() => {
    __resetIdempotency()
  })

  it.effect("rpc response carrying Result.succeed unwraps to the bare success value", () =>
    Effect.gen(function* () {
      const { fake, layer } = yield* makeRpcRuntime
      // Server side encodes its handler's success as Result.succeed(N)
      // through `Schema.Result(Schema.Number, NotFoundErr)`.
      const okSv = yield* encodeSv(
        Schema.Result(Schema.Number, NotFoundErr),
        Result.succeed(123) as any,
      )
      yield* fake.setResponder(({ methodName }) => {
        if (methodName === "fetch") {
          return {
            tag: "ok",
            val: schemaValueToWit(okSv),
          }
        }
        return { tag: "throw", error: new Error("unexpected method") }
      })

      const value = yield* Effect.provide(
        Effect.gen(function* () {
          const remote = yield* Lookup.client.get({ realm: "users" })
          return yield* remote.fetch({ id: "alice" })
        }) as Effect.Effect<number, any, never>,
        layer,
      )
      expect(value).toBe(123)
    }),
  )

  it.effect("rpc response carrying Result.fail surfaces as the typed E (NOT RpcCallError)", () =>
    Effect.gen(function* () {
      const { fake, layer } = yield* makeRpcRuntime
      const errSv = yield* encodeSv(
        Schema.Result(Schema.Number, NotFoundErr),
        Result.fail({ _tag: "NotFoundErr" as const, resource: "alice" }) as any,
      )
      yield* fake.setResponder(({ methodName }) => {
        if (methodName === "fetch") {
          return {
            tag: "ok",
            val: schemaValueToWit(errSv),
          }
        }
        return { tag: "throw", error: new Error("unexpected method") }
      })

      const result = yield* Effect.provide(
        Effect.result(
          Effect.gen(function* () {
            const remote = yield* Lookup.client.get({ realm: "users" })
            return yield* remote.fetch({ id: "alice" })
          }) as Effect.Effect<number, any, never>,
        ),
        layer,
      )
      expect(result._tag).toBe("Failure")
      if (result._tag !== "Failure") return
      const failure: any = result.failure
      // Must be the user-typed error — NOT the legacy RpcCallError wrapper.
      expect(failure._tag).toBe("NotFoundErr")
      expect(failure.resource).toBe("alice")
    }),
  )

  it.effect("Schema.Void success + typed error: success arm round-trips as undefined", () =>
    Effect.gen(function* () {
      const { fake, layer } = yield* makeRpcRuntime
      // Server-side encodes the success arm as Result.succeed({}) over an
      // empty-record stand-in (component model has no unit type).
      const okSv = yield* encodeSv(
        Schema.Result(Schema.Struct({}), NotFoundErr),
        Result.succeed({}) as any,
      )
      yield* fake.setResponder(({ methodName }) => {
        if (methodName === "cmd") {
          return {
            tag: "ok",
            val: schemaValueToWit(okSv),
          }
        }
        return { tag: "throw", error: new Error("unexpected method") }
      })

      const value = yield* Effect.provide(
        Effect.gen(function* () {
          const remote = yield* Lookup.client.get({ realm: "users" })
          return yield* remote.cmd({ fail: false })
        }) as Effect.Effect<unknown, any, never>,
        layer,
      )
      // Caller observes plain undefined for void success even though the
      // wire carried `Result.succeed({})`.
      expect(value).toBeUndefined()
    }),
  )

  it.effect("Schema.Void success + typed error: a missing wire value is a wire-format violation", () =>
    Effect.gen(function* () {
      const { fake, layer } = yield* makeRpcRuntime
      // Methods declared with `Schema.Void` AND a typed error always
      // carry a `result<{}, E>` value on the wire (output schema is
      // `single`, never `unit`). A missing value (`option::none`) in
      // that case is malformed and must be rejected — even though
      // void+no-error methods accept it.
      yield* fake.setResponder(({ methodName }) => {
        if (methodName === "cmd") {
          return {
            tag: "ok",
            val: undefined,
          }
        }
        return { tag: "throw", error: new Error("unexpected method") }
      })

      const result = yield* Effect.provide(
        Effect.result(
          Effect.gen(function* () {
            const remote = yield* Lookup.client.get({ realm: "users" })
            return yield* remote.cmd({ fail: false })
          }) as Effect.Effect<unknown, any, never>,
        ),
        layer,
      )
      expect(result._tag).toBe("Failure")
      if (result._tag !== "Failure") return
      const failure: any = result.failure
      expect(failure._tag).toBe("RemoteResponseError")
      expect(failure.reason).toMatch(/expected a return value, got none/)
    }),
  )

  it.effect("Schema.Void success + typed error: failure arm surfaces typed E", () =>
    Effect.gen(function* () {
      const { fake, layer } = yield* makeRpcRuntime
      const errSv = yield* encodeSv(
        Schema.Result(Schema.Struct({}), NotFoundErr),
        Result.fail({ _tag: "NotFoundErr" as const, resource: "missing" }) as any,
      )
      yield* fake.setResponder(({ methodName }) => {
        if (methodName === "cmd") {
          return {
            tag: "ok",
            val: schemaValueToWit(errSv),
          }
        }
        return { tag: "throw", error: new Error("unexpected method") }
      })

      const result = yield* Effect.provide(
        Effect.result(
          Effect.gen(function* () {
            const remote = yield* Lookup.client.get({ realm: "users" })
            return yield* remote.cmd({ fail: true })
          }) as Effect.Effect<unknown, any, never>,
        ),
        layer,
      )
      expect(result._tag).toBe("Failure")
      if (result._tag !== "Failure") return
      const failure: any = result.failure
      expect(failure._tag).toBe("NotFoundErr")
      expect(failure.resource).toBe("missing")
    }),
  )

  it.effect("transport-layer RpcError still surfaces as RemoteCallError (NOT typed E)", () =>
    Effect.gen(function* () {
      const { fake, layer } = yield* makeRpcRuntime
      // Even on a typed-error method, transport / remote-internal errors
      // continue to flow through `RemoteCallError` — the typed-E channel
      // is reserved exclusively for the host returning a `result.err`
      // payload on the success DataValue.
      yield* fake.setResponder(() => ({
        tag: "throw",
        error: { tag: "remote-internal-error", val: "boom" },
      }))
      const result = yield* Effect.provide(
        Effect.result(
          Effect.gen(function* () {
            const remote = yield* Lookup.client.get({ realm: "users" })
            return yield* remote.fetch({ id: "alice" })
          }) as Effect.Effect<number, any, never>,
        ),
        layer,
      )
      expect(result._tag).toBe("Failure")
      if (result._tag !== "Failure") return
      const failure: any = result.failure
      expect(failure._tag).toBe("RpcCallError")
      expect(failure.cause).toEqual({ tag: "remote-internal-error", val: "boom" })
    }),
  )
})
