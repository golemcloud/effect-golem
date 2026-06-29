import { describe, it, expect } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { compileMethodSpec, method } from "../src/Method.js"
import { multimodal, multimodalTextImage } from "../src/Multimodal.js"
import {
  UnstructuredBinary,
  UnstructuredText,
  type BinaryReferenceValue,
  type TextReferenceValue,
} from "../src/Unstructured.js"
import type { SchemaValue } from "../src/internal/schema-model/model.js"

const Meta = Schema.Struct({ prompt: Schema.String })
const Content = multimodal({
  text: UnstructuredText(),
  image: UnstructuredBinary(),
  meta: Meta,
} as const)

const encode = (codec: any, value: unknown) =>
  Schema.encodeEffect(codec)(value) as Effect.Effect<SchemaValue, unknown, never>
const decode = (codec: any, value: SchemaValue) =>
  Schema.decodeEffect(codec)(value) as Effect.Effect<unknown, unknown, never>

describe("multimodal()", () => {
  it.effect("emits a list<variant> schema with the multimodal role and one case per member", () =>
    Effect.gen(function* () {
      const m = method({
        params: { content: Content },
        success: Schema.String,
      })
      const mc = yield* compileMethodSpec("send", m)
      expect(mc.inputCodecs.length).toBe(1)
      const root = mc.inputCodecs[0]!.codec.graph.root
      expect(root.body.tag).toBe("list")
      expect(root.metadata.role?.tag).toBe("multimodal")
      if (root.body.tag !== "list") throw new Error()
      const variant = root.body.element
      expect(variant.body.tag).toBe("variant")
      if (variant.body.tag !== "variant") throw new Error()
      expect(variant.body.cases.map((c) => c.name)).toEqual(["text", "image", "meta"])
      // The text/image cases carry their unstructured variant roots; meta is a record.
      expect(variant.body.cases[0]!.payload!.body.tag).toBe("variant")
      expect(variant.body.cases[0]!.payload!.metadata.role?.tag).toBe("unstructured-text")
      expect(variant.body.cases[1]!.payload!.metadata.role?.tag).toBe("unstructured-binary")
      expect(variant.body.cases[2]!.payload!.body.tag).toBe("record")
    }),
  )

  it.effect("round-trips a multimodal value through the compiled codec", () =>
    Effect.gen(function* () {
      const m = method({
        params: { content: Content },
        success: Schema.Number,
      })
      const mc = yield* compileMethodSpec("count", m)
      const codec = mc.inputCodecs[0]!.codec.codec

      type Item =
        | { _tag: "text"; value: TextReferenceValue }
        | { _tag: "image"; value: BinaryReferenceValue }
        | { _tag: "meta"; value: { prompt: string } }

      const input: ReadonlyArray<Item> = [
        { _tag: "text", value: { _tag: "inline", val: "hi" } },
        { _tag: "image", value: { _tag: "url", val: "https://x/y.png" } },
        { _tag: "meta", value: { prompt: "p" } },
      ]

      const sv = yield* encode(codec, input)
      expect(sv.tag).toBe("list")
      if (sv.tag !== "list") throw new Error()
      expect(sv.elements.length).toBe(3)
      // Each element is a v.variant(caseIndex, payload).
      expect(sv.elements.map((e) => (e as { caseIndex: number }).caseIndex)).toEqual([0, 1, 2])

      const back = yield* decode(codec, sv)
      expect(back).toEqual(input)
    }),
  )

  it.effect("rejects non-sole multimodal parameters", () =>
    Effect.gen(function* () {
      const m = method({
        params: { content: Content, extra: Schema.String },
        success: Schema.Void,
      })
      const exit = yield* Effect.exit(compileMethodSpec("bad", m))
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.effect("multimodalTextImage builds a two-case multimodal", () =>
    Effect.gen(function* () {
      const C = multimodalTextImage()
      const wc = yield* C.compile()
      const root = wc.graph.root
      expect(root.body.tag).toBe("list")
      expect(root.metadata.role?.tag).toBe("multimodal")
      if (root.body.tag !== "list") throw new Error()
      const variant = root.body.element
      if (variant.body.tag !== "variant") throw new Error()
      expect(variant.body.cases.map((c) => c.name)).toEqual(["text", "image"])
    }),
  )
})
