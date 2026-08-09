// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Reading a thrown value that no type describes — the one place the kit records **what a runtime does to
 * an error on its way out** (#223).
 *
 * Nothing here classifies anything. Classification is policy and belongs to the surface that refuses;
 * this module holds only the facts about the shapes a runtime hands over, because those facts are not
 * derivable from the code that catches them and are wrong in ways no local test can reveal.
 */

/**
 * Read a property off an unknown throwable without widening anything to `any`.
 *
 * Deliberately duck-typed. Bun's `ResolveMessage` and `BuildMessage` — the two shapes the CLI's `bin` and
 * the vite plugin actually catch, since both run on Bun — are their own classes and are **not**
 * `instanceof Error`. An `instanceof` gate here passes a whole suite under vitest, which runs on Node,
 * and silently drops the parser's own sentence on the runtime that ships. That is #207, and it is why
 * every reader of a cause in this kit goes through this function.
 *
 * Non-enumerable properties are read too — `AggregateError.errors` is one, and {@link rootCause}
 * depends on it.
 */
export function prop(cause: unknown, key: string): unknown {
  if (typeof cause !== "object" || cause === null) return undefined;
  return (cause as Record<string, unknown>)[key];
}

/**
 * The diagnostic **inside** Bun's `AggregateError` wrapper — the thing a classifier must actually look at.
 *
 * `import()` on Bun hands one build diagnostic over bare and **two or more inside an `AggregateError`**,
 * whose own `message` is `N errors building "<absolute path>"` and whose `Object.keys` is empty. Node
 * throws the diagnostic directly, so no Node-shaped fixture can show this: it is found by running on Bun,
 * and only by running on Bun with a failure of the *realistic* shape.
 *
 * **And the realistic shape is the wrapped one.** A stray brace cascades — one missing `}` in a
 * `pithy.config.ts` produced four diagnostics on Bun 1.3.14 — so a syntax error arrives wrapped far more
 * often than bare. Classified as-is, the wrapper matches nothing: not a resolution failure, not a parse
 * error, just something with a message. The refusal then says *the config threw while loading, run the
 * file directly* while holding the line and column in its hand. #207 fixed the bare case and left this
 * one; #217 hit it in the capability loaders; #223 is it a third time, which is why it lives here.
 *
 * The **first** diagnostic only. The rest are the cascade, not the fault, and naming four positions
 * buries the one that matters.
 *
 * Bounded to four levels: a wrapper holding a wrapper is not a shape any runtime produces today, and an
 * unbounded walk over an adopter's own `errors` field is not something this should be talked into.
 * Anything else — a bare diagnostic, an empty `errors`, a non-array `errors` — is returned untouched, so
 * a runtime that stops wrapping needs no change here.
 */
export function rootCause(cause: unknown): unknown {
  let current = cause;
  for (let depth = 0; depth < 4; depth += 1) {
    const errors = prop(current, "errors");
    if (!Array.isArray(errors) || errors.length === 0 || errors[0] === undefined) return current;
    current = errors[0];
  }
  return current;
}

/** Bun's wrapper announces itself: `4 errors building "<absolute path>"`, and nothing else says that. */
const BUILD_FAILURE = /^\d+ errors? building "/;

/**
 * The wrapper **after the diagnostics are gone** — a build that failed, and that is all that is left.
 *
 * {@link rootCause} handles the first `import()`. It cannot handle the second: Bun caches a failed module
 * and re-throws an `AggregateError` with **no `errors` at all**, just the count and the path. There is
 * nothing to unwrap, so a classifier that only unwraps reads a syntax error as "it threw" from the second
 * caller onward — which is what `pithy doctor` shows an adopter, because resolving the project's account
 * loads the root config before the report does (#206, #223).
 *
 * Nothing else Bun throws degrades this way: a `ResolveMessage`, a bare `BuildMessage` and a module's own
 * `Error` are byte-identical on every import. Only the wrapper forgets.
 *
 * So the wrapper is recognised by its own message. **What it proves is narrow and worth stating:** the
 * module reached the builder and the builder produced diagnostics. It did not fail to resolve — Bun
 * throws the first `ResolveMessage` bare, wrapping nothing, even for a file with several bad imports —
 * and it did not run, so it cannot have thrown. It failed to parse or to build. A caller may say that
 * much and no more: the message itself carries an absolute path and a count, neither of which is the
 * adopter's business, so it is a *predicate* here rather than a string anyone is tempted to print.
 */
export function isBuildFailureWrapper(cause: unknown): boolean {
  const message = prop(cause, "message");
  return typeof message === "string" && BUILD_FAILURE.test(message);
}
