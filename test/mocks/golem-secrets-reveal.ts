// Mock for `golem:secrets/reveal@0.1.0`. Tests register a responder via
// {@link __setRevealImpl}; the default throws so a forgotten setup is loud.
let revealImpl: (s: any, expected: any) => any = () => {
  throw new Error("reveal not mocked")
}
export const reveal = (s: any, expected: any): any => revealImpl(s, expected)
export const __setRevealImpl = (fn: (s: any, expected: any) => any): void => {
  revealImpl = fn
}
export const __resetRevealImpl = (): void => {
  revealImpl = () => {
    throw new Error("reveal not mocked")
  }
}
