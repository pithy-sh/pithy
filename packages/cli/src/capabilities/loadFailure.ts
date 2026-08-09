// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import {
  causeMessage,
  isBuildFailureWrapper,
  prop,
  rootCause,
  safeReason,
  unresolvedSpecifier,
} from "@pithy-sh/core/src/error/cause";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";

/**
 * Why an optional capability would not load — and therefore what may be said about it (#217).
 *
 * Every capability loader in this folder is the same shape: several `import()` calls in one `try`, and
 * one `catch`. Fourteen of them answered that catch with ``Run `pithy add <cap>` `` whatever went
 * wrong. That sentence is right for exactly one of the failures the catch admits, and **wrong precisely
 * when the capability is installed and one of its own transitive dependencies is not** — #207's bug, one
 * level down the dependency graph. An adopter runs `pithy add payments`, the package is already there,
 * nothing changes, and the resolver's message — which named `stripe` — went to `detail` and stopped.
 *
 * `manifests.ts` worked this out first and wrote it down: *a manifest that is there and will not open is
 * not "not installed"*. Same sentence, one level up. This is that rule with a function behind it.
 *
 * The convention it implements is in `docs/CONVENTIONS.md` §Refusals: **a `catch` reachable by more than
 * one underlying failure may not name a single specific remedy.** Classify, or hedge.
 */
export type CapabilityLoadKind =
  /** The capability's own package does not resolve. `pithy add <cap>` is right, and earned. */
  | "not-installed"
  /** The capability resolves; something it imports does not. `pithy add` cannot fix this. */
  | "dependency-unresolved"
  /** Something does not resolve, and nothing names which package. Both remedies, neither asserted. */
  | "unresolved-import"
  /** The package is there and will not load — bad subpath, parse error, or its own throw. */
  | "broken"
  /** None of the above. No remedy at all: a wrong action is worse than no action. */
  | "unknown";

/** What a loader may say about a capability that would not load. */
export interface CapabilityLoadFailure {
  /** Which failure this was, decided from the cause and never asserted over it. */
  kind: CapabilityLoadKind;
  /** Client-safe refusal text. Only `not-installed` is allowed to claim the capability is absent. */
  message: string;
  /** The remedy, chosen from the kind. Carries no absolute path, no source line, no stack. */
  action: string;
  /** Throw-site context: kind, what was being resolved, and the raw cause. Never rendered to a client. */
  detail: string;
}

/**
 * The message, de-coloured, for this classifier's own pattern tests — never for output.
 *
 * What may be *said* is core's {@link safeReason}, and only core's. The filter that decides whether a
 * runtime's string is fit to show lived here, in `project/config.ts` and in the vite plugin, in three
 * near-verbatim copies; whether a string carries a path or a stack frame is a property of the string, and
 * three surfaces cannot hold three answers to it without two of them being wrong (#228). What stays here
 * is the policy: which causes this loader recognises, and what it tells an adopter about each.
 */
function rawMessage(cause: unknown): string {
  return causeMessage(cause) ?? "";
}

/** A resolution failure — the module graph, not the module's own code. */
function isUnresolvedImport(cause: unknown): boolean {
  const code = prop(cause, "code");
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || code === "ERR_UNSUPPORTED_DIR_IMPORT") {
    return true;
  }
  if (prop(cause, "name") === "ResolveMessage") return true;
  return /Cannot find (?:package|module) |Failed to resolve (?:import|module)|Failed to load url /.test(
    rawMessage(cause),
  );
}

/**
 * A subpath the installed package does not export.
 *
 * Deliberately **not** an unresolved import here, though Node groups them: the package resolved, so it
 * is installed, and `pithy add` would reinstall the same broken export map. Ejected from the resolution
 * branch on purpose — this is the one resolver error that proves the capability is present.
 */
function isBadSubpath(cause: unknown): boolean {
  const code = prop(cause, "code");
  return code === "ERR_PACKAGE_PATH_NOT_EXPORTED" || /is not defined by "exports"/.test(rawMessage(cause));
}

/** The package's own source would not parse or build. */
function isParseError(cause: unknown): boolean {
  const name = prop(cause, "name");
  if (name === "SyntaxError" || name === "BuildMessage") return true;
  if (prop(cause, "code") === "PARSE_ERROR") return true;
  // Bun's build wrapper with its diagnostics already dropped — the shape every caller after the first
  // sees, since a failed module is cached and re-thrown emptied out. It proves a build produced
  // diagnostics, so it is a parse error with no reason to quote. See core's `cause.ts` (#223).
  if (isBuildFailureWrapper(cause)) return true;
  return /Transform failed|\[PARSE_ERROR]|Parse (?:error|failure)|Unexpected (?:token|end of input)/.test(
    rawMessage(cause),
  );
}

/** `@pithy-sh/payments` from `@pithy-sh/payments/src/workflows/worker` — the package, not the subpath. */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

/**
 * Choose a capability loader's refusal **from** the failure rather than asserting one over it (#217).
 *
 * @param capability the name `pithy add <name>` takes — `payments`, `vector`, `storage`.
 * @param target what the loader was resolving. Its package half decides "ours or theirs"; the rest is
 *   `detail` only, since a deep subpath is our implementation and not the adopter's business.
 * @param cause whatever the `try` caught. Read duck-typed, never `instanceof`.
 */
export function classifyCapabilityLoadFailure(
  capability: string,
  target: string,
  wrapped: unknown,
): CapabilityLoadFailure {
  // Bun hands `import()` failures over inside an `AggregateError`. Classify what is inside it.
  const cause = rootCause(wrapped);
  const pkg = packageOf(target);
  const raw = causeMessage(cause) ?? String(cause);
  const failure = (kind: CapabilityLoadKind, message: string, action: string): CapabilityLoadFailure => ({
    kind,
    message,
    action,
    detail: `${kind}: ${target} — ${raw}`,
  });

  // Present, and its export map or its source is wrong. Checked before resolution, because Node reports
  // a bad subpath with a resolver code and the package plainly resolved for it to be reached.
  if (isBadSubpath(cause)) {
    return failure(
      "broken",
      `The ${capability} capability is installed but incomplete.`,
      `${pkg} does not export what this command needs. Reinstall it, or report this to its maintainer.`,
    );
  }

  if (isUnresolvedImport(cause)) {
    const specifier = unresolvedSpecifier(cause);
    if (specifier === undefined) {
      return failure(
        "unresolved-import",
        `The ${capability} capability could not be loaded.`,
        `An import did not resolve. Run \`pithy add ${capability}\` if it is not installed, or bun install if it is.`,
      );
    }
    if (packageOf(specifier) === pkg) {
      return failure(
        "not-installed",
        `The ${capability} capability is not installed.`,
        `Run \`pithy add ${capability}\`, then re-run this command.`,
      );
    }
    return failure(
      "dependency-unresolved",
      `The ${capability} capability could not be loaded.`,
      `${pkg} is installed, but nothing resolves "${specifier}". Install the project's dependencies (bun install), then re-run this command.`,
    );
  }

  if (isParseError(cause)) {
    // `safeReason` can answer nothing, and Bun's build wrapper — a count and an absolute path, and
    // never anything else — is one of the reasons it does. That suppression is core's, written once
    // rather than here and in two other classifiers that each had to be found and patched (#223, #228).
    const reason = safeReason(cause);
    return failure(
      "broken",
      `The ${capability} capability is installed and will not load.`,
      `${pkg} does not parse${reason ? `: ${reason}` : ""}. Reinstall it, or report this to its maintainer.`,
    );
  }

  // Anything carrying a message, whether or not it extends `Error` — the package's own throw.
  if (causeMessage(cause) !== undefined) {
    const reason = safeReason(cause);
    return failure(
      "broken",
      `The ${capability} capability is installed and will not load.`,
      reason
        ? `${pkg} threw while loading: ${reason}. Fix that, or report it to its maintainer.`
        : `${pkg} threw while loading. Run \`pithy doctor\` to see what the project resolves.`,
    );
  }

  return failure(
    "unknown",
    `The ${capability} capability could not be loaded.`,
    `Run \`pithy doctor\` to check what the project resolves, then re-run this command.`,
  );
}

/**
 * The refusal a capability loader throws — {@link classifyCapabilityLoadFailure} with the error around it.
 *
 * `ValidationError` is kept from the fourteen sites this replaces: the code an adopter's tooling matches
 * on does not change because the sentence got honest.
 */
export function capabilityLoadError(capability: string, target: string, cause: unknown): ValidationError {
  const { message, action, detail } = classifyCapabilityLoadFailure(capability, target, cause);
  return new ValidationError({ message, action, detail }, { cause });
}
