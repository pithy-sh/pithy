// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { causeMessage, prop, rootCause, safeReason } from "@pithy-sh/core/src/error/cause";
import { type PithyError, PreconditionFailedError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { packageLoadFailure, type UnresolvedImport, unresolvedImport } from "@pithy-sh/core/src/error/unresolved";
import { packageOf } from "@pithy-sh/core/src/naming/packageName";
import { entryBeside, installedBeside, packageInstalledFrom } from "../project/kitResolve";
import { capabilityNotComposed } from "./notComposed";

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
  /** The capability's own package does not resolve, and does not resolve from the project either. */
  | "not-installed"
  /**
   * The package **is** in the project's `node_modules` and the module still would not resolve (#533).
   *
   * The one kind that may never say `pithy add`, and the reason the classifier now takes a project root
   * at all. An unresolved specifier looks identical whichever of two things is true — the adopter never
   * installed the package, or something asked the wrong `node_modules` — and only a *second, positive*
   * look at the project can tell them apart. The cause cannot: `importingPackage` reads `@pithy-sh/cli`
   * out of the referrer for a global install and a local one alike, because the failing import never knew
   * a project root to encode. See {@link packageInstalledFrom} for why that look is a directory check.
   *
   * Since #533 that second resolution is the same one the loader used, so what reaches here is the
   * honest remainder: an installed package that does not carry the module — version skew against a CLI
   * that is ahead of it, or a half-written install. Either way `pithy add` reinstalls the same copy.
   */
  | "unreachable"
  /** The capability resolves; something it imports does not. `pithy add` cannot fix this. */
  | "dependency-unresolved"
  /** Something does not resolve, and nothing names which package. Both remedies, neither asserted. */
  | "unresolved-import"
  /**
   * The package is there and will not load — bad subpath, parse error, its own throw, or an import that
   * names a path the installed tree does not have.
   */
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
 * The message, de-colored, for this classifier's own pattern tests — never for output.
 *
 * What may be *said* is core's {@link safeReason}, and only core's. The filter that decides whether a
 * runtime's string is fit to show lived here, in `project/config.ts` and in the vite plugin, in three
 * near-verbatim copies; whether a string carries a path or a stack frame is a property of the string, and
 * three surfaces cannot hold three answers to it without two of them being wrong (#228). What stays here
 * is the policy: which causes this loader recognizes, and what it tells an adopter about each.
 */
function rawMessage(cause: unknown): string {
  return causeMessage(cause) ?? "";
}

/** The package's own source would not parse or build. */
function isParseError(cause: unknown): boolean {
  const name = prop(cause, "name");
  if (name === "SyntaxError" || name === "BuildMessage") return true;
  if (prop(cause, "code") === "PARSE_ERROR") return true;
  return /Transform failed|\[PARSE_ERROR]|Parse (?:error|failure)|Unexpected (?:token|end of input)/.test(
    rawMessage(cause),
  );
}

/**
 * Choose a capability loader's refusal **from** the failure rather than asserting one over it (#217).
 *
 * @param capability the name `pithy add <name>` takes — `payments`, `vector`, `storage`.
 * @param target what the loader was resolving. Its package half decides "ours or theirs"; the rest is
 *   `detail` only, since a deep subpath is our implementation and not the adopter's business.
 * @param cause whatever the `try` caught. Read duck-typed, never `instanceof`.
 * @param projectDir the project root the loader resolved from, when the caller has one. **Supplying it is
 *   what makes `not-installed` earnable**: absent, an unresolved specifier is taken at face value, which
 *   is right for the pure-function callers that hand this a literal cause and wrong for every loader.
 *   Present, the claim is checked against the project's own `node_modules` before it is made.
 */
export function classifyCapabilityLoadFailure(
  capability: string,
  target: string,
  wrapped: unknown,
  projectDir?: string,
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

  // Which import, whose, and what to do are core's, for all three surfaces that refuse a module (#709).
  // What stays here is the one fact core cannot know: which package this loader was loading.
  const unresolved = unresolvedImport(cause, {
    installed: installedBeside,
    entry: entryBeside,
    relativeTo: projectDir,
    loader: "@pithy-sh/cli",
  });
  if (unresolved !== undefined) return unresolvedFailure(capability, pkg, unresolved, projectDir, failure);

  // A file inside an installed package that would not load names that package — the capability's own, or
  // one it imports — rather than the capability this loader happened to be loading (#709).
  const foreign = packageLoadFailure(cause, { loader: "@pithy-sh/cli" });
  // Bun's parse failure in the capability's own package is this loader's to word: the parser's reason is
  // carried below, and it names the same package.
  const ownBuild = foreign?.owner === pkg && prop(cause, "name") === "BuildMessage";
  if (foreign !== undefined && !ownBuild) {
    return failure("broken", `The ${capability} capability is installed and will not load.`, foreign.remedy);
  }

  if (isParseError(cause)) {
    // `safeReason` can answer nothing: a diagnostic that carries a path, a stack frame or a newline is not
    // quoted. That filter is core's, written once rather than here and in two other classifiers (#228).
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
 * A capability that would not load because an import did not resolve.
 *
 * Core's {@link unresolvedImport} has decided the kind, the owner and the remedy, and that remedy is the
 * `action` here — the same sentence the config loader and the vite plugin give for the same cause. Two
 * things are this loader's own, and both are about the **target**, never about an import:
 *
 * - **The capability's own package is absent.** That is `pithy add`, not `bun install`, and the claim is
 *   checked against the project before it is made (#533): `pithy add` on a package that is already there
 *   installs nothing and then rewrites a hand-built `pithy.config.ts`.
 * - **Nothing names the import.** Then the capability itself may be what is missing, so both remedies are
 *   named and neither is asserted.
 *
 * Everything else is the capability installed and not loading, or a dependency of it not installed.
 */
function unresolvedFailure(
  capability: string,
  pkg: string,
  unresolved: UnresolvedImport,
  projectDir: string | undefined,
  failure: (kind: CapabilityLoadKind, message: string, action: string) => CapabilityLoadFailure,
): CapabilityLoadFailure {
  const { kind, remedy } = unresolved;
  if (unresolved.package === pkg && (kind === "package" || kind === "undetermined")) {
    if (projectDir !== undefined && packageInstalledFrom(projectDir, pkg)) {
      return failure(
        "unreachable",
        `The ${capability} capability is installed and could not be reached.`,
        `${pkg} is in this project's node_modules but nothing resolves "${unresolved.shown ?? pkg}". Reinstall the project's dependencies (bun install) and check ${pkg} is up to date.`,
      );
    }
    return failure(
      "not-installed",
      `The ${capability} capability is not installed.`,
      `Run \`pithy add ${capability}\`, then re-run this command.`,
    );
  }
  if (kind === "unnamed") {
    return failure(
      "unresolved-import",
      `The ${capability} capability could not be loaded.`,
      `An import did not resolve. Run \`pithy add ${capability}\` if it is not installed, or bun install if it is.`,
    );
  }
  if (unresolved.installHelps) {
    return failure("dependency-unresolved", `The ${capability} capability could not be loaded.`, remedy);
  }
  // A path an installed package does not have, or does not export, or an entry it names and does not
  // carry, is an install that is incomplete.
  const incomplete = kind === "package-subpath" || kind === "package-entry" || kind === "package-file";
  const message = incomplete
    ? `The ${capability} capability is installed but incomplete.`
    : `The ${capability} capability is installed and will not load.`;
  return failure("broken", message, remedy);
}

/**
 * The refusal a capability loader throws — {@link classifyCapabilityLoadFailure} with the error around it.
 *
 * `ValidationError` is kept from the fourteen sites this replaces for every kind but one: the code an
 * adopter's tooling matches on does not change because the sentence got honest. **`not-installed` is the
 * exception (#697).** A capability the project never installed is a capability it does not compose, and
 * that is a precondition with `pithy add` as the step — exit 3 and the same `fix` as every other refusal of
 * its kind (`notComposed.ts`), never exit 2, which tells a script a different spelling would have worked.
 *
 * @param projectDir the root the loader resolved from — see {@link classifyCapabilityLoadFailure}. Without
 *   it no `fix` is named, because nothing says which Worker `pithy add` would wire.
 */
export async function capabilityLoadError(
  capability: string,
  target: string,
  cause: unknown,
  projectDir?: string,
): Promise<PithyError> {
  const failure = classifyCapabilityLoadFailure(capability, target, cause, projectDir);
  if (failure.kind !== "not-installed" || projectDir === undefined) return refusalFor(failure, cause);
  const { message, action, detail } = failure;
  return capabilityNotComposed(capability, { message, action, detail }, { projectDir }, cause);
}

/**
 * {@link capabilityLoadError} for a caller that cannot wait: a synchronous resolution, such as a generated
 * host entry. The same classes; a `not-installed` refusal names no `fix`, because naming one reads the
 * project's Workers and manifest, and its `action` already says `pithy add`.
 */
export function capabilityLoadErrorNow(
  capability: string,
  target: string,
  cause: unknown,
  projectDir?: string,
): PithyError {
  return refusalFor(classifyCapabilityLoadFailure(capability, target, cause, projectDir), cause);
}

/** The error around a classified failure: exit 3 for a capability that is not there, exit 2 otherwise. */
function refusalFor(failure: CapabilityLoadFailure, cause: unknown): PithyError {
  const { message, action, detail } = failure;
  if (failure.kind === "not-installed") return new PreconditionFailedError({ message, action, detail }, { cause });
  return new ValidationError({ message, action, detail }, { cause });
}
