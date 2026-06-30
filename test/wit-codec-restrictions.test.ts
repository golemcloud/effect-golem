import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { toWitCodec } from "../src/WitCodec.js"
import { Uint8, restrict } from "../src/WitTypes.js"

const bodyOf = (s: Schema.Top) =>
  Effect.gen(function* () {
    const wc = yield* toWitCodec(s as any)
    return wc.graph.root.body as any
  })

describe("numeric restrictions", () => {
  it.effect("Uint8.pipe(restrict({min,max})) carries unsigned restrictions + round-trips", () =>
    Effect.gen(function* () {
      const s = Uint8.pipe(restrict({ min: 1, max: 200 }))
      const body = yield* bodyOf(s)
      expect(body.tag).toBe("u8")
      expect(body.restrictions?.min).toEqual({ tag: "unsigned", val: 1n })
      expect(body.restrictions?.max).toEqual({ tag: "unsigned", val: 200n })
      const wc = yield* toWitCodec(s as any)
      const sv = yield* Schema.encodeEffect(wc.codec as any)(50)
      expect(yield* Schema.decodeEffect(wc.codec as any)(sv)).toBe(50)
    }),
  )

  it.effect("Schema.Number.pipe(restrict({max})) -> f64 float-bits restriction", () =>
    Effect.gen(function* () {
      const body = yield* bodyOf(Schema.Number.pipe(restrict({ max: 9 })))
      expect(body.tag).toBe("f64")
      expect(body.restrictions?.max?.tag).toBe("float-bits")
    }),
  )

  it.effect("a bare Uint8 has no restrictions", () =>
    Effect.gen(function* () {
      const body = yield* bodyOf(Uint8)
      expect(body.tag).toBe("u8")
      expect(body.restrictions).toBeUndefined()
    }),
  )
})
