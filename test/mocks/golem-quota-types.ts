/**
 * Runtime mock for `golem:quota/types@1.5.0` used by the test suite.
 *
 * The real host bindings are provided by the WASM runtime; this mock
 * implements the NEW free-function surface (`newToken`, `reserve`,
 * `split`, `merge`, and the static `Reservation.commit`) so the Effect
 * wrappers can be exercised in node-vitest.
 *
 * `QuotaToken` and `Reservation` are opaque carriers the mock constructs;
 * tokens carry just enough state (resource name, expected-use) for the
 * event log and the trap conditions (`split` overflow, `merge` resource
 * mismatch) the operational tests rely on.
 */

export type EnvironmentId = { uuid: { highBits: bigint; lowBits: bigint } }
export type Datetime = { seconds: bigint; nanoseconds: number }

export type FailedReservation = {
  estimatedWaitNanos?: bigint
}

/**
 * Test event log — appended to whenever the mock observes a host call.
 * Tests use this to assert the exact sequence of `reserve` / `commit` /
 * `split` / `merge` interactions without resorting to spies on the SDK.
 */
export type Event =
  | { tag: "construct"; resourceName: string; expectedUse: bigint }
  | { tag: "reserve"; resourceName: string; amount: bigint }
  | { tag: "commit"; resourceName: string; used: bigint; reservedAmount: bigint }
  | { tag: "split"; resourceName: string; childExpectedUse: bigint }
  | { tag: "merge"; resourceName: string; otherResource: string }

export const events: Array<Event> = []

let nextReservationId = 1
type ReserveBehavior =
  | { tag: "ok" }
  | { tag: "fail"; failure: FailedReservation }
  | { tag: "throw"; error: unknown }
let reserveBehavior: ReserveBehavior = { tag: "ok" }

let splitBehavior: { tag: "ok" } | { tag: "throw"; error: unknown } = { tag: "ok" }
let mergeBehavior: { tag: "ok" } | { tag: "throw"; error: unknown } = { tag: "ok" }
let commitBehavior: { tag: "ok" } | { tag: "throw"; error: unknown } = { tag: "ok" }

/** Reset the mock to the default "everything succeeds" state. */
export const __reset = (): void => {
  events.length = 0
  nextReservationId = 1
  reserveBehavior = { tag: "ok" }
  splitBehavior = { tag: "ok" }
  mergeBehavior = { tag: "ok" }
  commitBehavior = { tag: "ok" }
}

/** Make the next `reserve` (and all subsequent ones) throw a `failed-reservation`. */
export const __setReserveFails = (failure: FailedReservation = {}): void => {
  reserveBehavior = { tag: "fail", failure }
}

/** Make the next `reserve` throw an arbitrary host error (NOT a failed-reservation). */
export const __setReserveThrows = (error: unknown): void => {
  reserveBehavior = { tag: "throw", error }
}

/** Make `split` throw on its next call (simulating a WIT trap). */
export const __setSplitThrows = (error: unknown): void => {
  splitBehavior = { tag: "throw", error }
}

/** Make `merge` throw on its next call (simulating a WIT trap). */
export const __setMergeThrows = (error: unknown): void => {
  mergeBehavior = { tag: "throw", error }
}

/** Make `Reservation.commit` throw on its next call. */
export const __setCommitThrows = (error: unknown): void => {
  commitBehavior = { tag: "throw", error }
}

/**
 * Opaque quota-token carrier. In the real host this is an
 * `own<quota-token>` resource handle from `golem:core/types@2.0.0`; here it
 * is a plain object holding the mutable state the trap conditions need.
 */
export class QuotaToken {
  resourceName: string
  expectedUse: bigint

  constructor(resourceName: string, expectedUse: bigint) {
    this.resourceName = resourceName
    this.expectedUse = expectedUse
  }
}

/**
 * Opaque reservation carrier. The real host returns an
 * `own<reservation>` resource; here it back-references its token (for
 * resource-name event tagging) and the originally reserved amount.
 */
export class Reservation {
  /** @internal — surfaced for test assertions, not part of the real WIT shape. */
  readonly id: number
  /** @internal — the amount originally reserved, used for event-log clarity. */
  readonly reservedAmount: bigint
  /** @internal — back-reference for resource-name event tagging. */
  readonly token: QuotaToken
  /** @internal — flipped after commit so a duplicate raises like the host would. */
  consumed = false

  constructor(token: QuotaToken, reservedAmount: bigint) {
    this.id = nextReservationId++
    this.reservedAmount = reservedAmount
    this.token = token
  }

  /** Mirrors the static host `Reservation.commit(reservation, used)`. */
  static commit(this_: Reservation, used: bigint): void {
    if (this_.consumed) {
      throw new Error(`mock: reservation ${this_.id} already consumed`)
    }
    this_.consumed = true
    if (commitBehavior.tag === "throw") {
      const e = commitBehavior.error
      commitBehavior = { tag: "ok" }
      throw e
    }
    events.push({
      tag: "commit",
      resourceName: this_.token.resourceName,
      used,
      reservedAmount: this_.reservedAmount,
    })
  }
}

/** Mirrors the free function `newToken(resourceName, expectedUse)`. */
export function newToken(resourceName: string, expectedUse: bigint): QuotaToken {
  events.push({ tag: "construct", resourceName, expectedUse })
  return new QuotaToken(resourceName, expectedUse)
}

/** Mirrors the free function `reserve(token, amount)`. */
export function reserve(token: QuotaToken, amount: bigint): Reservation {
  if (reserveBehavior.tag === "fail") {
    // The WIT binding throws the FailedReservation record directly.
    throw reserveBehavior.failure as unknown
  }
  if (reserveBehavior.tag === "throw") {
    throw reserveBehavior.error
  }
  events.push({ tag: "reserve", resourceName: token.resourceName, amount })
  return new Reservation(token, amount)
}

/** Mirrors the free function `split(token, childExpectedUse)`. */
export function split(token: QuotaToken, childExpectedUse: bigint): QuotaToken {
  if (splitBehavior.tag === "throw") {
    const e = splitBehavior.error
    splitBehavior = { tag: "ok" }
    throw e
  }
  if (childExpectedUse > token.expectedUse) {
    throw new Error("mock: child-expected-use exceeds parent expected-use")
  }
  events.push({ tag: "split", resourceName: token.resourceName, childExpectedUse })
  token.expectedUse -= childExpectedUse
  return new QuotaToken(token.resourceName, childExpectedUse)
}

/** Mirrors the free function `merge(token, other)`. */
export function merge(token: QuotaToken, other: QuotaToken): void {
  if (mergeBehavior.tag === "throw") {
    const e = mergeBehavior.error
    mergeBehavior = { tag: "ok" }
    throw e
  }
  if (other.resourceName !== token.resourceName) {
    throw new Error("mock: cannot merge tokens of different resources")
  }
  events.push({
    tag: "merge",
    resourceName: token.resourceName,
    otherResource: other.resourceName,
  })
  token.expectedUse += other.expectedUse
}
