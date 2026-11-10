// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { commandName } from "@pithy-sh/core/src/cli/command";
import {
  causeMessage,
  type FailurePosition,
  failurePosition,
  prop,
  rootCause,
  safeReason,
} from "@pithy-sh/core/src/error/cause";
import { InternalError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import {
  nodeModulesProbe,
  packageEntryProbe,
  packageLoadFailure,
  unresolvedImport,
} from "@pithy-sh/core/src/error/unresolved";
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
 * Why a `pithy.config.ts` would not load — and therefore what may be said about it.
 *
 * The CLI refuses a config that will not load with `classifyConfigLoadFailure` in
 * `packages/cli/src/project/config.ts`. This plugin depends on `@pithy-sh/core` and must not depend on the CLI,
 * so the policy is restated here, with the same rule behind it: **a `catch` reachable by more than one underlying
 * failure may not name a single specific remedy.** Classify, or hedge. The convention is in `docs/CONVENTIONS.md`.
 *
 * What the copies *cannot* be allowed to disagree about is anything that is not a sentence, and all of it lives
 * in `@pithy-sh/core`, the one package this plugin depends on. What a runtime does to an error on its way out is
 * the first: `rootCause` and `prop`, facts no copy can derive. Whether one of its strings is safe to show is the
 * second: `safeReason`, `failurePosition` and `causeMessage`, because a path or a stack frame is a property of the
 * string and not of the surface quoting it, and a gap in that filter must close in one place. An import that did
 * not resolve is the third: which kind, whose, and what to do are `unresolvedImport`'s, so every surface gives one
 * remedy for one cause. A file inside an installed package that throws as it loads is the fourth,
 * `packageLoadFailure`'s, for the same reason.
 *
 * What stays restated here is the rest of the policy: a parse error, which file it is in, and the config's own
 * throw. Node's type stripping is not one of them: Vite's runner transforms the config's TypeScript itself.
 */
export type WorkerConfigFailureKind =
  /** An import in the config does not resolve. Which cause it was decides whether installing helps. */
  | "unresolved-import"
  /** A file inside an installed package would not load: its `"type"` contradicts its code, or it does not parse. */
  | "package-load"
  /** The config, or a module it imports, does not parse. Installing will not help. */
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

/**
 * The message, de-colored, for this classifier's own pattern tests — never for output.
 *
 * What may be *said* is core's {@link safeReason}, and only core's. This plugin cannot import the CLI's
 * refusals and never could, which is why the sentences below are restated here — but the *filter* those
 * sentences pass a string through is not a sentence. Whether a string carries an absolute path or half a
 * parser's ANSI box is a property of the string, so it is decided in `@pithy-sh/core`, the one package
 * this plugin depends on, and written once.
 */
function rawMessage(cause: unknown): string {
  return causeMessage(cause) ?? "";
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
 * Whether a package is installed where the importing file would look — core's walk over `node:fs`, the
 * same one the CLI passes, so a deep import of an absent package is told to install and one of an
 * installed package without that path is not. This plugin runs on Node, never in a Worker.
 */
const installed = nodeModulesProbe({ exists: existsSync, realpath: realpathSync });

/**
 * What an installed package's bare name resolves to, from its own `package.json`: core's read, the same the
 * CLI passes. Vite's runner says *Failed to resolve entry* for a package that declares no entry and for one
 * whose declared entry is not on disk, and names no importer for either.
 */
const entry = packageEntryProbe({
  exists: existsSync,
  realpath: realpathSync,
  read: (path) => readFileSync(path, "utf8"),
});

/**
 * Choose the refusal's `action` **from** the failure rather than asserting one over it.
 *
 * An unresolved import is core's {@link unresolvedImport}: the same sentence the CLI gives for the same
 * cause, naming the package the import is written in when it is not the config, and an
 * install only where an install can help. `relativeTo` is the config's directory, so an adopter's
 * own missing file is shown as the import they wrote and never as an absolute path. A parser's position in
 * `configFile` is the config's; one in a file the config imports is quoted with that file named, the same way.
 */
export function classifyWorkerConfigFailure(
  wrapped: unknown,
  relativeTo?: string,
  configFile?: string,
): WorkerConfigFailure {
  // Bun hands `import()` failures over inside an `AggregateError`. Classify what is inside it.
  const cause = rootCause(wrapped);
  // Which import, whose, and what to do: core's, for all three surfaces that refuse a module.
  const unresolved = unresolvedImport(cause, { installed, entry, relativeTo, loader: "@pithy-sh/vite" });
  if (unresolved !== undefined) return { kind: "unresolved-import", action: unresolved.remedy };

  // A package's own file that would not load is the package's, before it can read as the config's.
  const foreign = packageLoadFailure(cause, { loader: "@pithy-sh/vite" });
  if (foreign !== undefined) return { kind: "package-load", action: foreign.remedy };

  if (isParseError(cause)) {
    // Both of these can answer "nothing": a diagnostic that carries a path, a stack frame or a newline is
    // not quoted, and a position is never invented. That filter is core's, once.
    const reason = safeReason(cause);
    // A position in a file the config imports is not the config's: it is quoted with that file named, or not at all.
    const file = diagnosticFile(cause);
    const elsewhere = configFile !== undefined && file !== undefined && resolve(file) !== resolve(configFile);
    const imported = elsewhere ? importedPosition(cause, file, relativeTo) : undefined;
    const at = elsewhere ? imported : failurePosition(cause);
    const where = at ? ` Line ${at.line}, column ${at.column}.` : "";
    const subject = imported === undefined ? "The config" : `${imported.shown}, which the config imports,`;
    return {
      kind: "parse-error",
      action: `${subject} does not parse${reason ? `: ${reason}` : ""}.${where} ${imported === undefined ? "Fix the file" : "Fix that file"} — installing dependencies will not help.`,
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

/**
 * The file a parse diagnostic names: Bun's `position.file`, else the `id` Vite's runner sets to the module whose
 * transform failed, else that runner's `loc.file`. Only the file is read from `loc`: on Bun the runner's own
 * `loc.line` is a line of Vite's bundle, not of the module.
 */
function diagnosticFile(cause: unknown): string | undefined {
  for (const file of [prop(prop(cause, "position"), "file"), prop(cause, "id"), prop(prop(cause, "loc"), "file")]) {
    if (typeof file === "string" && file.length > 0) return file;
  }
  return undefined;
}

/**
 * The line and column of a parse diagnostic in `file`, a module the config imports, with that module's path from
 * the config's directory, written as an import from the config would write it. `undefined` for a relative `file`,
 * which is not guessed at, or a diagnostic with no position.
 */
function importedPosition(
  cause: unknown,
  file: string,
  relativeTo: string | undefined,
): (FailurePosition & { shown: string }) | undefined {
  if (!isAbsolute(file)) return undefined;
  const at = failurePosition(cause);
  if (at === undefined) return undefined;
  if (relativeTo === undefined) return { ...at, shown: basename(file) };
  const path = relative(relativeTo, file).split("\\").join("/");
  return { ...at, shown: path.startsWith("../") ? path : `./${path}` };
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
      // No command here: `pithy ui add` acts on one Worker and takes a framework, and a plugin that has
      // lost its config cannot say which of either. Pointing the plugin is the remedy that always applies.
      action: `Point the plugin at the Worker's pithy.config.ts with pithy({ configFile }). A front end scaffolded by ${commandName("ui add")} is pointed at it already.`,
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
    const { kind, action } = classifyWorkerConfigFailure(cause, dirname(configFile), configFile);
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
