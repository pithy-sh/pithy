// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Retry a D1 write through transient faults. Ported from the CMS `withD1Retry`, adapted to
 * Pithy: no injected logger (core has none), an optional `onRetry` notifier instead, and a
 * documented idempotency guard. The shared helper every capability's D1 writes can wrap; the
 * audit recorder is its first consumer.
 *
 * D1 surfaces a whole family of transient failures by message — a statement that exceeded its
 * timeout, a database briefly locked/busy under contention, a dropped network connection to the
 * backing store, a storage object reset mid-flight, or an opaque internal error. All of these are
 * worth retrying with exponential backoff; a deterministic failure (a constraint violation, a SQL
 * error) is not. The matchers key off the error message because that is all D1 exposes; a
 * non-matching error is re-thrown untouched (this is a passthrough wrapper, never an originator — it
 * does not wrap foreign throws in a `PithyError`; the caller's own layer owns that). By default
 * **every** transient class is retried, so a caller gets robust coverage without enumerating D1's
 * error vocabulary.
 *
 * The idempotency guard is always active and independent of `retryOn`: a `unique-constraint`
 * failure **on a retry** (attempt > 0) means the prior attempt already committed the row before its
 * transport hiccup — the retry is the duplicate, not a real conflict — so the wrapper returns rather
 * than throwing. A unique-constraint never *initiates* a retry (it is not a transient fault), so on
 * the **first** attempt it is a genuine conflict and propagates. This is what makes a broad retry
 * policy safe for a write: pair it with a unique idempotency key (the audit recorder's `eventId`) and
 * a post-commit retry can never double-write.
 */

/** A retryable D1 fault class, matched against the error message. */
export const D1RetryableError = {
  /** A statement exceeded its execution timeout (`exceeded timeout`, `storage timeout`, `Timed out`). */
  TIMEOUT: "timeout",
  /** The database was locked or busy under contention (`database is locked/busy`, `SQLITE_BUSY`). */
  DATABASE_BUSY: "database-busy",
  /** The connection to the backing store dropped mid-request (`Network connection lost`, `connection … reset`). */
  NETWORK: "network",
  /** The storage object was reset mid-flight (`reset because its code was updated`, `caused object to be reset`). */
  STORAGE_RESET: "storage-reset",
  /** An opaque D1/storage internal error (`internal error`, `Cannot resolve D1`). */
  INTERNAL: "internal",
  /** A UNIQUE constraint failed — never a retry initiator; drives only the idempotency guard (see module doc). */
  UNIQUE_CONSTRAINT: "unique-constraint",
} as const;
export type D1RetryableError = (typeof D1RetryableError)[keyof typeof D1RetryableError];

/** Every transient (retry-initiating) fault class — the default `retryOn`. Excludes the guard-only `unique-constraint`. */
export const D1_TRANSIENT_ERRORS: readonly D1RetryableError[] = [
  D1RetryableError.TIMEOUT,
  D1RetryableError.DATABASE_BUSY,
  D1RetryableError.NETWORK,
  D1RetryableError.STORAGE_RESET,
  D1RetryableError.INTERNAL,
];

/** One D1 retry attempt's context, handed to {@link D1RetryOptions.onRetry}. */
export interface D1RetryInfo {
  /** The fault class that triggered the retry. */
  error: D1RetryableError;
  /** The attempt that just failed (0-based). */
  attempt: number;
  /** The configured maximum number of retries. */
  maxRetries: number;
  /** How long the wrapper will wait before the next attempt, in ms. */
  delayMs: number;
}

/** Options for {@link withD1Retry}. All optional; the defaults retry timeouts three times. */
export interface D1RetryOptions {
  /**
   * Which transient fault classes initiate a retry. Defaults to {@link D1_TRANSIENT_ERRORS} — every
   * transient class. Narrow it only when a caller deliberately wants to ignore some. Listing
   * `unique-constraint` here has no effect — it is never a retry initiator; it only ever drives the
   * always-on idempotency guard (see module doc).
   */
  retryOn?: readonly D1RetryableError[];
  /** Maximum retries after the initial attempt. Defaults to `3`. */
  maxRetries?: number;
  /** Backoff base delay, in ms. Defaults to `200`. */
  initialDelayMs?: number;
  /** Backoff growth factor. Defaults to `2` (200ms, 400ms, 800ms…). */
  backoffMultiplier?: number;
  /** Notified before each backoff wait — for an optional log line. Never throws into the retry. */
  onRetry?: (info: D1RetryInfo) => void;
}

/**
 * Lowercased message substrings that identify each fault class. Matching is case-insensitive (the
 * message is lowered first) and substring-based, because D1 wraps the same underlying fault in
 * varying envelopes (`D1_ERROR: …`, a bare SQLite message, a Workers runtime message). Each list is
 * the set of signatures Cloudflare is known to surface for that class.
 */
const errorMatchers: Record<D1RetryableError, readonly string[]> = {
  timeout: ["exceeded timeout", "storage timeout", "timed out"],
  "database-busy": ["database is locked", "database is busy", "sqlite_busy"],
  network: ["network connection lost", "connection was reset", "connection reset", "connection lost"],
  "storage-reset": ["reset because its code was updated", "caused object to be reset", "durable object reset"],
  internal: ["internal error", "cannot resolve d1", "an unknown error occurred"],
  "unique-constraint": ["unique constraint failed"],
};

/** Whether a lowercased message matches any signature of `fault`. */
function matchesFault(message: string, fault: D1RetryableError): boolean {
  return errorMatchers[fault].some((signature) => message.includes(signature));
}

/** Whether an error is a UNIQUE-constraint failure — the idempotency-guard signal. */
function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && matchesFault(error.message.toLowerCase(), D1RetryableError.UNIQUE_CONSTRAINT);
}

/**
 * The transient fault class an error matches within `retryOn`, or `null` if none. `unique-constraint`
 * is excluded from initiation — it is handled only by the idempotency guard — so listing it in
 * `retryOn` is a no-op.
 */
function matchTransient(error: unknown, retryOn: readonly D1RetryableError[]): D1RetryableError | null {
  if (!(error instanceof Error)) return null;
  const message = error.message.toLowerCase();
  for (const fault of retryOn) {
    if (fault === D1RetryableError.UNIQUE_CONSTRAINT) continue;
    if (matchesFault(message, fault)) return fault;
  }
  return null;
}

/**
 * Run `fn`, retrying it through the configured transient D1 faults with exponential backoff.
 * Returns `fn`'s result; on the idempotency-guard path (a unique-constraint on a retry) returns
 * `undefined` cast to `T`, since the prior attempt already produced the effect. A non-retryable
 * error, or exhausted retries, throws the last error untouched.
 */
export async function withD1Retry<T>(fn: () => Promise<T>, options?: D1RetryOptions): Promise<T> {
  const retryOn = options?.retryOn ?? D1_TRANSIENT_ERRORS;
  const maxRetries = options?.maxRetries ?? 3;
  const initialDelayMs = options?.initialDelayMs ?? 200;
  const backoffMultiplier = options?.backoffMultiplier ?? 2;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Idempotency guard: a unique-constraint hit on a retry means a prior attempt's write already
      // landed — the conflict is with our own earlier success, so treat it as done. On the first
      // attempt it is a genuine conflict and falls through to propagate.
      if (attempt > 0 && isUniqueConstraint(error)) return undefined as T;

      const fault = matchTransient(error, retryOn);
      if (!fault) throw error;

      if (attempt >= maxRetries) break;

      const delayMs = initialDelayMs * backoffMultiplier ** attempt;
      options?.onRetry?.({ error: fault, attempt, maxRetries, delayMs });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}
