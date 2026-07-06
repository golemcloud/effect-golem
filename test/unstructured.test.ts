import { describe, it, expect } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { compileMethodSpec, method } from "../src/Method.js"
import {
  UnstructuredBinary,
  UnstructuredText,
  type BinaryReferenceValue,
  type TextReferenceValue,
} from "../src/Unstructured.js"
import type { SchemaValue } from "../src/internal/schema-model/model.js"

/** Round-trip a domain value through the compiled param's WitCodec. */
const encode = (codec: any, value: unknown) =>
  Schema.encodeEffect(codec)(value) as Effect.Effect<SchemaValue, unknown, never>
const decode = (codec: any, value: SchemaValue) =>
  Schema.decodeEffect(codec)(value) as Effect.Effect<unknown, unknown, never>

describe("UnstructuredText element", () => {
  it.effect("emits an unstructured-text variant schema and round-trips inline text", () =>
    Effect.gen(function* () {
      const echo = method({
        input: { msg: UnstructuredText() },
        returns: Schema.String,
      })
      const mc = yield* compileMethodSpec("echo", echo)
      expect(mc.inputCodecs.length).toBe(1)
      const param = mc.inputCodecs[0]!
      expect(param.name).toBe("msg")

      const root = param.codec.graph.root
      expect(root.body.tag).toBe("variant")
      expect(root.metadata.role?.tag).toBe("unstructured-text")
      if (root.body.tag !== "variant") throw new Error()
      // inline case carries a `text` body, url case carries a `url` body.
      expect(root.body.cases[0]!.name).toBe("inline")
      expect(root.body.cases[0]!.payload!.body.tag).toBe("text")
      expect(root.body.cases[1]!.name).toBe("url")
      expect(root.body.cases[1]!.payload!.body.tag).toBe("url")

      // Inline round-trip (with language).
      const input: TextReferenceValue = { _tag: "inline", val: "hello", languageCode: "en" }
      const sv = yield* encode(param.codec.codec, input)
      expect(sv.tag).toBe("variant")
      if (sv.tag !== "variant") throw new Error()
      expect(sv.caseIndex).toBe(0)
      expect(sv.payload).toEqual({ tag: "text", text: "hello", language: "en" })
      const back = yield* decode(param.codec.codec, sv)
      expect(back).toEqual(input)
    }),
  )

  it.effect("carries restrictions through to the text schema node", () =>
    Effect.gen(function* () {
      const m = method({
        input: { msg: UnstructuredText({ restrictions: [{ languageCode: "en" }] }) },
        returns: Schema.Void,
      })
      const mc = yield* compileMethodSpec("m", m)
      const root = mc.inputCodecs[0]!.codec.graph.root
      expect(root.metadata.role?.tag).toBe("unstructured-text")
      if (root.body.tag !== "variant") throw new Error()
      const inline = root.body.cases[0]!.payload!
      if (inline.body.tag !== "text") throw new Error()
      expect(inline.body.restrictions).toEqual({ languages: ["en"] })
    }),
  )

  it.effect("round-trips a url-style text reference", () =>
    Effect.gen(function* () {
      const m = method({
        input: { msg: UnstructuredText() },
        returns: Schema.String,
      })
      const mc = yield* compileMethodSpec("m", m)
      const codec = mc.inputCodecs[0]!.codec.codec
      const ref: TextReferenceValue = { _tag: "url", val: "https://example.com/x.txt" }
      const sv = yield* encode(codec, ref)
      expect(sv).toEqual({
        tag: "variant",
        caseIndex: 1,
        payload: { tag: "url", value: "https://example.com/x.txt" },
      })
      const back = yield* decode(codec, sv)
      expect(back).toEqual(ref)
    }),
  )

  it.effect("rejects a wrong-kind value at decode time", () =>
    Effect.gen(function* () {
      const m = method({
        input: { msg: UnstructuredText() },
        returns: Schema.Void,
      })
      const mc = yield* compileMethodSpec("m", m)
      const codec = mc.inputCodecs[0]!.codec.codec
      // A `string` value is not a `variant` — decode must fail.
      const exit = yield* Effect.exit(
        decode(codec, { tag: "string", value: "nope" } as SchemaValue),
      )
      expect(exit._tag).toBe("Failure")
    }),
  )
})

describe("UnstructuredBinary element", () => {
  it.effect("emits an unstructured-binary variant schema with restrictions", () =>
    Effect.gen(function* () {
      const m = method({
        input: { blob: UnstructuredBinary({ restrictions: [{ mimeType: "image/png" }] }) },
        returns: Schema.Void,
      })
      const mc = yield* compileMethodSpec("m", m)
      const root = mc.inputCodecs[0]!.codec.graph.root
      expect(root.body.tag).toBe("variant")
      expect(root.metadata.role?.tag).toBe("unstructured-binary")
      if (root.body.tag !== "variant") throw new Error()
      const inline = root.body.cases[0]!.payload!
      if (inline.body.tag !== "binary") throw new Error()
      expect(inline.body.restrictions).toEqual({ mimeTypes: ["image/png"] })
    }),
  )

  it.effect("round-trips inline + url binary references", () =>
    Effect.gen(function* () {
      const m = method({
        input: { blob: UnstructuredBinary() },
        returns: Schema.String,
      })
      const mc = yield* compileMethodSpec("m", m)
      const codec = mc.inputCodecs[0]!.codec.codec

      const inline: BinaryReferenceValue = {
        _tag: "inline",
        val: new Uint8Array([1, 2, 3]),
        mimeType: "image/png",
      }
      const sv = yield* encode(codec, inline)
      expect(sv.tag).toBe("variant")
      if (sv.tag !== "variant") throw new Error()
      expect(sv.caseIndex).toBe(0)
      expect(sv.payload).toEqual({
        tag: "binary",
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "image/png",
      })
      const backInline = yield* decode(codec, sv)
      expect(backInline).toEqual(inline)

      const url: BinaryReferenceValue = { _tag: "url", val: "https://example.com/x.png" }
      const svUrl = yield* encode(codec, url)
      expect(svUrl).toEqual({
        tag: "variant",
        caseIndex: 1,
        payload: { tag: "url", value: "https://example.com/x.png" },
      })
      const backUrl = yield* decode(codec, svUrl)
      expect(backUrl).toEqual(url)
    }),
  )

  it.effect("rejects an inline binary whose mime type is outside the allow-list", () =>
    Effect.gen(function* () {
      const m = method({
        input: { blob: UnstructuredBinary({ restrictions: [{ mimeType: "image/png" }] }) },
        returns: Schema.Void,
      })
      const mc = yield* compileMethodSpec("m", m)
      const codec = mc.inputCodecs[0]!.codec.codec
      const sv: SchemaValue = {
        tag: "variant",
        caseIndex: 0,
        payload: { tag: "binary", bytes: new Uint8Array([0]), mimeType: "image/jpeg" },
      }
      const exit = yield* Effect.exit(decode(codec, sv))
      expect(exit._tag).toBe("Failure")
    }),
  )
})
