import { describe, it, expect } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { toWitCodec } from "../src/WitCodec.js"
import { PrincipalSchema, type PrincipalValue } from "../src/Principal.js"

const roundtrip = (value: PrincipalValue) =>
  Effect.gen(function* () {
    const wc = yield* toWitCodec(PrincipalSchema as any)
    const codec = wc.codec as Schema.Codec<any, any, never, never>
    const wv = yield* Schema.encodeEffect(codec)(value)
    const back = yield* Schema.decodeEffect(codec)(wv)
    return { wc, wv, back }
  })

describe("PrincipalSchema → principal variant", () => {
  it.effect("emits a 4-case variant-type root (oidc/agent/golem-user/anonymous)", () =>
    Effect.gen(function* () {
      const { wc } = yield* roundtrip({ tag: "anonymous" })
      const root = wc.witType.nodes[0]!.type as {
        tag: string
        val: ReadonlyArray<readonly [string, number | undefined]>
      }
      expect(root.tag).toBe("variant-type")
      expect(root.val.map((c) => c[0])).toEqual(["oidc", "agent", "golem-user", "anonymous"])
      // The `anonymous` case has no payload.
      expect(root.val[3]![1]).toBeUndefined()
    }),
  )

  it.effect("round-trips a full OidcPrincipal", () =>
    Effect.gen(function* () {
      const value: PrincipalValue = {
        tag: "oidc",
        val: {
          sub: "user-123",
          issuer: "https://issuer.example",
          email: "a@example.test",
          name: "Ada",
          emailVerified: true,
          givenName: "Ada",
          familyName: "Lovelace",
          picture: "https://pics.example/ada.png",
          preferredUsername: "ada",
          claims: "{\"role\":\"admin\"}",
        },
      }
      const { back } = yield* roundtrip(value)
      expect(back).toEqual(value)
    }),
  )

  it.effect("round-trips a sparse OidcPrincipal (optional fields omitted)", () =>
    Effect.gen(function* () {
      const value: PrincipalValue = {
        tag: "oidc",
        val: { sub: "s", issuer: "i", claims: "{}" },
      }
      const { back } = yield* roundtrip(value)
      expect(back).toEqual(value)
    }),
  )

  it.effect("round-trips an anonymous principal", () =>
    Effect.gen(function* () {
      const value: PrincipalValue = { tag: "anonymous" }
      const { back } = yield* roundtrip(value)
      expect(back).toEqual(value)
    }),
  )

  it.effect("round-trips an agent principal", () =>
    Effect.gen(function* () {
      const value: PrincipalValue = {
        tag: "agent",
        val: {
          agentId: {
            componentId: { uuid: { highBits: 1n, lowBits: 2n } },
            agentId: "counter/foo",
          },
        },
      }
      const { back } = yield* roundtrip(value)
      expect(back).toEqual(value)
    }),
  )

  it.effect("round-trips a golem-user principal", () =>
    Effect.gen(function* () {
      const value: PrincipalValue = {
        tag: "golem-user",
        val: { accountId: { uuid: { highBits: 7n, lowBits: 8n } } },
      }
      const { back } = yield* roundtrip(value)
      expect(back).toEqual(value)
    }),
  )
})
