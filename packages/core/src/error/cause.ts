// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Reading a thrown value that no type describes — the one place the kit records **what a runtime does to
 * an error on its way out** (#223), and **the one place that decides whether what it says may be shown**
 * (#228).
 *
 * Nothing here classifies anything. Classification is policy and belongs to the surface that refuses:
 * which causes a loader recognizes, and what each refusal says, differ per surface and are meant to.
 * This module holds only what does not — the facts about the shapes a runtime hands over, and the filter
 * that decides whether one of its strings is safe to put in front of an adopter.
 *
 * **The filter is here for the same reason the facts are, and the argument took two issues to finish.**
 * #223 moved `rootCause`, `prop` and `isBuildFailureWrapper` in and deliberately left `safeReason` beside
 * the three refusals, on the reading that what a surface may say is that surface's business. That is true
 * of the sentences and false of the filter: whether a string carries a path, a stack frame or half a
 * parser's ANSI box is a property of the string, and the answer cannot differ between the CLI, a
 * capability loader and the vite plugin without one of them being wrong. It was three near-verbatim
 * copies, and the hole #223 found in it had to be closed three times (#228).
 *
 * `@pithy-sh/vite` depends on this package and on nothing else in the kit. That constraint is what made
 * core the right home for `rootCause`; it applies to the filter identically.
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
 * So the wrapper is recognized by its own message. **What it proves is narrow and worth stating:** the
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

/** Escape sequences a runtime colors its diagnostics with. They are formatting, and they never travel. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the control characters is the point.
const ANSI = /\u001b\[[0-9;]*m/g;

/** Anything that looks like the start of an absolute path — POSIX, `~`, or a Windows drive. */
const ABSOLUTE_PATH = /(^|[\s'"(])(\/|~\/|[A-Za-z]:[\\/])/;

/** A stack frame, in the one spelling every runtime here agrees on. */
const STACK_FRAME = /\bat \S+:\d+:\d+/;

/** The longest a reason may be before it has stopped being a sentence and started being a diagnostic. */
const REASON_LIMIT = 160;

/**
 * The thrown value's message, **de-colored** — `undefined` when it has none.
 *
 * Duck-typed for {@link prop}'s reason. The de-coloring is here rather than at each caller because an
 * escape sequence is formatting the runtime added, not something a surface has an opinion about — and
 * because the three copies of this had already drifted: two stripped with `\u001b`, the third with a
 * literal escape character sitting in its source where no reviewer would see it (#228).
 *
 * This says what the cause *says*. Whether any of it may be shown is {@link safeReason}.
 */
export function causeMessage(cause: unknown): string | undefined {
  const message = prop(cause, "message");
  return typeof message === "string" ? message.replace(ANSI, "") : undefined;
}

/**
 * The cause's own message, but **only when the whole of it is one safe sentence** — the kit's single
 * decision about whether a runtime's string may reach an adopter (#228).
 *
 * A parser's reason (`Expected identifier but found "{"`) is a sentence an adopter acts on. The
 * diagnostic a bundler wraps the same fault in is a multi-line ANSI box quoting an absolute path and the
 * source line, which is throw-site context wearing a message's clothes. What is dropped here still
 * reaches `detail`, which the CLI renderer never prints and the HTTP codec strips — so a refusal costs a
 * developer one frame of digging, and a mistake puts a path, a source line or a stack frame in a field
 * that is rendered.
 *
 * **Provenance first, then content.** Bun's build-failure wrapper is refused outright, before a single
 * content test runs. The content tests exist for a diagnostic that *might* be safe; the wrapper never is,
 * because its whole message is a count nobody asked for and a path that must not travel. Leaving it to
 * the content tests is what leaked: `2 errors building "app/config:12:5.ts"` has no leading slash, sailed
 * through the absolute-path check, and produced *The config does not parse: 2 errors building
 * "app/config:12:5.ts". Line 12, column 5.* — a path the adopter never wrote, and a position fabricated
 * out of a file name (#223). That suppression was written three times because the filter was. It is
 * written once here, and {@link failurePosition} refuses the same shape for the same reason.
 *
 * A trailing period comes off: every caller puts this inside a sentence of its own.
 */
export function safeReason(cause: unknown): string | undefined {
  if (isBuildFailureWrapper(cause)) return undefined;
  const text = (causeMessage(cause) ?? "").trim();
  if (text.length === 0 || text.length > REASON_LIMIT) return undefined;
  if (text.includes("\n")) return undefined;
  if (ABSOLUTE_PATH.test(text)) return undefined;
  if (STACK_FRAME.test(text)) return undefined;
  return text.replace(/\.$/, "");
}

/** Where a runtime says a failure was. Two numbers, and never the file they were quoted beside. */
export interface FailurePosition {
  /** 1-based line, as the runtime reported it. */
  line: number;
  /** Column, as the runtime reported it. */
  column: number;
}

/**
 * `line`/`column`, from the structured position where a runtime gives one, else from its own `…:LINE:COL`.
 *
 * A recorded fact about two runtimes: Bun's `BuildMessage` carries `position`, and a transform that has no
 * such field states the same thing in its message tail. Only the two numbers are lifted out — never the
 * path they are appended to. Whether a surface prints them is that surface's policy: two of the three
 * classifiers do, and the capability loader deliberately does not.
 *
 * Refuses Bun's build-failure wrapper on provenance, exactly as {@link safeReason} does. That message
 * holds a file name and a count and nothing about where anything failed, so a `:12:5` found in it is a
 * coincidence of the path's own characters — and a fabricated position reads as authoritative.
 */
export function failurePosition(cause: unknown): FailurePosition | undefined {
  if (isBuildFailureWrapper(cause)) return undefined;
  const position = prop(cause, "position");
  const line = prop(position, "line");
  const column = prop(position, "column");
  if (typeof line === "number" && line > 0 && typeof column === "number") return { line, column };
  const match = /:(\d+):(\d+)/.exec(causeMessage(cause) ?? "");
  if (!match?.[1] || !match[2]) return undefined;
  return { line: Number(match[1]), column: Number(match[2]) };
}

/**
 * The specifier that did not resolve.
 *
 * A recorded fact about two runtimes: Bun's `ResolveMessage` carries it as a **field**, and Node states it
 * in prose. The field is preferred wherever there is one, because the prose around it names the referrer's
 * absolute path — the specifier is the adopter's own import, the referrer is our frame.
 *
 * Whether a surface names it, and what it advises when it does, is that surface's policy and stays there.
 */
export function unresolvedSpecifier(cause: unknown): string | undefined {
  const field = prop(cause, "specifier");
  if (typeof field === "string" && field.length > 0) return field;
  const match = /Cannot find (?:package|module) ['"]([^'"]+)['"]/.exec(causeMessage(cause) ?? "");
  return match?.[1];
}
