// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { access } from "node:fs/promises";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { InternalError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { runnerImport } from "vite";

/** The default export of a Worker's `pithy.config.ts`, before it is trusted. */
interface WorkerConfigModule {
  default?: { capabilities?: unknown; app?: unknown };
}

/** One Worker's composed capabilities, indexed by name, plus the files the config was built from. */
export interface LoadedWorkerConfig {
  /** Capability name → the capability, library capabilities first and the app capability last. */
  capabilities: Map<string, Capability>;
  /** Every file the config transitively imported — what the dev server watches so an edit reloads. */
  dependencies: readonly string[];
}

/**
 * Why a `pithy.config.ts` would not load — and therefore what may be said about it (#217).
 *
 * This loader built the same refusal the CLI's did, with the same defect. #207 fixed the CLI's
 * (`packages/cli/src/project/config.ts`, `classifyConfigLoadFailure`); this file could not import that
 * fix, because `@pithy-sh/vite` depends on `@pithy-sh/core` and must not depend on the CLI. So it is
 * restated here, with the same rule behind it: **a `catch` reachable by more than one underlying failure
 * may not name a single specific remedy.** Classify, or hedge. The convention is in `docs/CONVENTIONS.md`.
 *
 * The shared home for both copies is `@pithy-sh/core`; moving `classifyConfigLoadFailure` there is a
 * follow-up, not this change, because the CLI's copy is load-bearing for #207's own tests.
 */
export type WorkerConfigFailureKind =
  /** An import in the config does not resolve. `bun install`, or a corrected specifier. */
  | "unresolved-import"
  /** The file does not parse. Installing will not help, and the adopter has read the opposite for years. */
  | "parse-error"
  /** The config loaded far enough to throw its own error. Neither of the above. */
  | "threw-on-load"
  /** None of the above. No remedy: a wrong action is worse than no action, because it is followed. */
  | "unknown";

/** What may be said about a config that would not load. */
export interface WorkerConfigFailure {
  /** Which failure this was, decided from the cause and never asserted over it. */
  kind: WorkerConfigFailureKind;
  /** The remedy, chosen from the kind. Carries no absolute path, no source line, no stack. */
  action: string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the control characters is the point.
const ANSI = /\[[0-9;]*m/g;

/** Anything that looks like the start of an absolute path — POSIX, `~`, or a Windows drive. */
const ABSOLUTE_PATH = /(^|[\s'"(])(\/|~\/|[A-Za-z]:[\\/])/;

/** Read a property off an unknown throwable without widening anything to `any`. */
function prop(cause: unknown, key: string): unknown {
  if (typeof cause !== "object" || cause === null) return undefined;
  return (cause as Record<string, unknown>)[key];
}

/**
 * The thrown value's message, de-coloured — `undefined` when it has none.
 *
 * **Duck-typed, and that is not laxity.** `pithy dev` runs this plugin under **Bun**, whose
 * `ResolveMessage` and `BuildMessage` are their own classes and are **not** `instanceof Error`. #207's
 * first draft gated on `instanceof Error`, passed its whole suite under vitest on Node, and dropped the
 * parser's own sentence on the runtime that ships. Anything carrying a string `message` is read here.
 */
function causeMessage(cause: unknown): string | undefined {
  const message = prop(cause, "message");
  return typeof message === "string" ? message.replace(ANSI, "") : undefined;
}

/** The message, de-coloured, for pattern tests only — never for output. */
function rawMessage(cause: unknown): string {
  return causeMessage(cause) ?? "";
}

/**
 * The cause's own message, but **only when the whole of it is one safe sentence.**
 *
 * A parser's reason is a sentence the adopter acts on; the diagnostic vite wraps the same fault in is a
 * multi-line ANSI box quoting the file's absolute path and its source line, which is throw-site context
 * wearing a message's clothes. Told apart by content, not provenance. What is dropped still reaches
 * `detail`, which the CLI renderer never prints and the HTTP codec strips.
 */
function safeReason(cause: unknown): string | undefined {
  const text = rawMessage(cause).trim();
  if (text.length === 0 || text.length > 160) return undefined;
  if (text.includes("\n")) return undefined;
  if (ABSOLUTE_PATH.test(text)) return undefined;
  if (/\bat \S+:\d+:\d+/.test(text)) return undefined;
  return text.replace(/\.$/, "");
}

/**
 * The specifier that did not resolve. Bun's `ResolveMessage` carries it as a field; Node states it in
 * prose. Taken as a field wherever possible — the prose around it names the referrer's absolute path,
 * and that is our frame, not the adopter's import.
 */
function unresolvedSpecifier(cause: unknown): string | undefined {
  const field = prop(cause, "specifier");
  if (typeof field === "string" && field.length > 0) return field;
  const match = /Cannot find (?:package|module) ['"]([^'"]+)['"]/.exec(rawMessage(cause));
  return match?.[1];
}

/** `line`/`column`, from the structured position where a runtime gives one, else from `…:LINE:COL`. */
function failurePosition(cause: unknown): { line: number; column: number } | undefined {
  const position = prop(cause, "position");
  const line = prop(position, "line");
  const column = prop(position, "column");
  if (typeof line === "number" && line > 0 && typeof column === "number") return { line, column };
  // Only the two numbers are lifted out — never the path they are appended to.
  const match = /:(\d+):(\d+)/.exec(rawMessage(cause));
  if (!match?.[1] || !match[2]) return undefined;
  return { line: Number(match[1]), column: Number(match[2]) };
}

function isUnresolvedImport(cause: unknown): boolean {
  const code = prop(cause, "code");
  if (
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "MODULE_NOT_FOUND" ||
    code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ||
    code === "ERR_UNSUPPORTED_DIR_IMPORT"
  ) {
    return true;
  }
  if (prop(cause, "name") === "ResolveMessage") return true;
  return /Cannot find (?:package|module) |Failed to resolve (?:import|module)|Failed to load url /.test(
    rawMessage(cause),
  );
}

function isParseError(cause: unknown): boolean {
  const name = prop(cause, "name");
  if (name === "SyntaxError" || name === "BuildMessage") return true;
  if (prop(cause, "code") === "PARSE_ERROR") return true;
  return /Transform failed|\[PARSE_ERROR]|Parse (?:error|failure)|Unexpected (?:token|end of input)/.test(
    rawMessage(cause),
  );
}

/**
 * The diagnostic inside Bun's `AggregateError` wrapper.
 *
 * **Found by running this on Bun, not by a fixture — which is the whole lesson of #207 repeating.**
 * `import()` on Bun does not throw a `BuildMessage`; it throws an `AggregateError` whose `errors` array
 * holds them, whose own `message` is `2 errors building "<absolute path>"`, and whose `Object.keys` is
 * empty. Classified as-is that reads as "it threw", the parser's sentence and position are lost, and the
 * refusal hedges when it had the answer in hand. Node throws the diagnostic directly, so no Node-shaped
 * fixture can show this. Verified against Bun 1.3.14.
 *
 * One diagnostic arrives bare; two or more arrive wrapped — and a stray brace cascades, so wrapped is the
 * common case. The first diagnostic only: the rest are the cascade.
 */
function rootCause(cause: unknown): unknown {
  let current = cause;
  for (let depth = 0; depth < 4; depth += 1) {
    const errors = prop(current, "errors");
    if (!Array.isArray(errors) || errors.length === 0 || errors[0] === undefined) return current;
    current = errors[0];
  }
  return current;
}

/** Choose the refusal's `action` **from** the failure rather than asserting one over it (#217). */
export function classifyWorkerConfigFailure(wrapped: unknown): WorkerConfigFailure {
  // Bun hands `import()` failures over inside an `AggregateError`. Classify what is inside it.
  const cause = rootCause(wrapped);
  if (isUnresolvedImport(cause)) {
    const specifier = unresolvedSpecifier(cause);
    return {
      kind: "unresolved-import",
      action: specifier
        ? `Nothing resolves "${specifier}". Install the project's dependencies (bun install), or correct that import.`
        : "An import in the config does not resolve. Install the project's dependencies (bun install), then check its imports.",
    };
  }

  if (isParseError(cause)) {
    const reason = safeReason(cause);
    const at = failurePosition(cause);
    const where = at ? ` Line ${at.line}, column ${at.column}.` : "";
    return {
      kind: "parse-error",
      action: `The config does not parse${reason ? `: ${reason}` : ""}.${where} Fix the file — installing dependencies will not help.`,
    };
  }

  // Anything that carries a message, whether or not it extends `Error` — the config's own throw.
  if (causeMessage(cause) !== undefined) {
    const reason = safeReason(cause);
    return {
      kind: "threw-on-load",
      action: reason
        ? `The config threw while loading: ${reason}. Fix that in the config.`
        : "The config threw while loading. Run the file directly to see what it throws.",
    };
  }

  return { kind: "unknown", action: "Check pithy.config.ts. Run the file directly to see how it fails." };
}

function isCapability(value: unknown): value is Capability {
  return typeof value === "object" && value !== null && typeof (value as Capability).name === "string";
}

/**
 * Load a Worker's `pithy.config.ts` and index the capabilities it composes.
 *
 * `runnerImport` is Vite's own loader: it builds a throwaway runnable environment with
 * `configFile: false`, so the config's TypeScript, its extensionless relative imports, and its
 * `@pithy-sh/*` source imports all resolve — none of which a bare dynamic `import()` handles — and it
 * behaves identically under `vite dev` and `vite build`. It also reports the transitive files it
 * touched, which is what makes HMR on a config edit possible.
 */
export async function loadWorkerConfig(configFile: string): Promise<LoadedWorkerConfig> {
  try {
    await access(configFile);
  } catch {
    throw new NotFoundError({
      message: `No pithy.config.ts at ${configFile}.`,
      action: "Run pithy ui add from the project root, or point the plugin at it with pithy({ configFile }).",
    });
  }

  let module: WorkerConfigModule;
  let dependencies: readonly string[];
  try {
    const imported = await runnerImport<WorkerConfigModule>(configFile);
    module = imported.module;
    dependencies = imported.dependencies.filter((file) => typeof file === "string" && file.length > 0);
  } catch (cause) {
    // The config is there and would not load. Which of the four ways it failed decides what to tell the
    // adopter — see {@link classifyWorkerConfigFailure}. The raw cause still goes to `detail` and stops
    // there: the CLI renderer prints `message` and `action` only, and the HTTP codec strips `detail`.
    const { kind, action } = classifyWorkerConfigFailure(cause);
    throw new InternalError({
      message: `Could not load ${configFile}.`,
      action,
      detail: `${kind}: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }

  const config = module.default;
  if (!config || !Array.isArray(config.capabilities)) {
    throw new InternalError({
      message: `${configFile} doesn't default-export a worker config.`,
      action: "Export default { capabilities, app }.",
    });
  }

  const capabilities = new Map<string, Capability>();
  for (const entry of config.capabilities) {
    if (!isCapability(entry)) {
      throw new InternalError({
        message: `${configFile} lists something that isn't a capability.`,
        action: "Every entry in capabilities is a capability object with a name. Remove the odd one out.",
      });
    }
    capabilities.set(entry.name, entry);
  }
  // The app capability composes last, so a Worker's own projection wins over a library's.
  if (isCapability(config.app)) capabilities.set(config.app.name, config.app);

  return { capabilities, dependencies };
}
