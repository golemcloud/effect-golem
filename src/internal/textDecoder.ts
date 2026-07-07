/**
 * A strict (fatal) UTF-8 `TextDecoder` that rejects invalid byte sequences,
 * falling back to a lenient decoder on runtimes that don't support the `fatal`
 * option. The QuickJS-backed agent guest is compiled without ICU, where
 * `new TextDecoder("utf-8", { fatal: true })` throws at construction — so the
 * eager module-scope decoders the SDK uses must degrade gracefully there.
 *
 * @internal
 */
export const strictTextDecoder = () => {
  try {
    return new TextDecoder("utf-8", { fatal: true })
  } catch {
    return new TextDecoder("utf-8")
  }
}
