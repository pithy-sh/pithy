// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG } from "../capabilities/catalog";
import { packageDirFrom, packageInstalledFrom } from "../project/kitResolve";

/**
 * **Whether a capability the project composes is one the CLI can actually reach (#533).**
 *
 * A Worker's `pithy.config.ts` is imported by absolute path, so its own `import` statements resolve from
 * the file that wrote them — `apps/<name>/`. Every `pithy <capability> …` command resolves the *same*
 * package through `kitResolve(projectDir, …)`. Those were two different questions for as long as
 * `kitResolve` walked the project root alone, and a project could pass the first and fail the second:
 * install a capability under `apps/api/node_modules` alone — which is what "capabilities are per Worker"
 * invites, and what a package manager that does not hoist produces on its own — and the composition was
 * perfect while every command that reached into it refused.
 *
 * That refusal is the sentence #533 was reported about: *"The payments capability is not installed. Run
 * `pithy add payments`."* Both halves are wrong, and the action is the worse one, because `pithy add`
 * rewrites a hand-built `pithy.config.ts` to work around a resolution that is not broken. **The two
 * questions are now one:** `kitResolve` looks along the root's chain and then in each Worker's own
 * `node_modules`, so a per-Worker install is reached rather than reported, and this section is left with
 * the case no lookup can fix — a capability the project composes and has not installed anywhere.
 *
 * ## Why that case still earns a section
 *
 * Because nothing else says it until a command fails, one command at a time, and because the sentence a
 * failing command produces is about that command rather than about the project. `loadFailure.ts`'s last
 * branch ends ``Run `pithy doctor` to check what the project resolves``, and until this section doctor
 * could not: it read manifests out of `node_modules/@pithy-sh` and never once asked whether the composed
 * set and the installed set were the same set. A composed capability that is installed nowhere also
 * *looks like health* everywhere else in the report — it contributes no manifest to the root scan, so no
 * binding of its is checked and no config option of its is read.
 *
 * ## What it compares, and why that is the whole of it
 *
 * The composed capability names, against {@link packageInstalledFrom} — the identical lookup every
 * command's resolution is built on, which is what keeps the report and the commands from disagreeing.
 * Not the modules inside a package: which module a given command reaches for is that command's business,
 * and a table of them here would be a second copy of every loader's import list, kept true by a gate,
 * restating what the loaders already say. The package is where the answer stops being per command.
 *
 * ## The same walk answers a second question: do the Workers agree on the version (#539)
 *
 * Capabilities are per Worker, so a capability can be installed hoisted at the project root **or** under
 * `apps/<name>/node_modules` — and with no root copy, two Workers can hold their own copies at two
 * different versions. `kitResolve` takes the first `apps/*` match in directory order and takes no Worker
 * to resolve *for*, so `pithy payments provision` acting for `apps/api` builds its plan from api's
 * manifest and then loads and deploys **admin's** package. Silently, and at exit 0.
 *
 * That state should not exist — a project's Workers should never be out of sync on a capability — but it
 * is reachable, nothing refuses it, and until this nothing reported it. It is the same walk with one more
 * question asked of each Worker: which copy would *you* load, and what version does it declare.
 *
 * **The version is read from the resolved package's own `package.json`**, never from a range in a
 * manifest or a `dependencies` entry. A range is what somebody asked for; the file on disk is what would
 * load, and naming the wrong one is how a report agrees with a project that is wrong.
 *
 * **Per Worker means a walk up from `apps/<name>`**, which is Node's own answer for that Worker's
 * `pithy.config.ts` — its own copy first, then everything above it, ending at the root chain. So a hoisted
 * copy beside one per-Worker install is skew too, and it is reported as what each Worker would load rather
 * than as where the copies sit.
 *
 * **It reports and it does not fail `ok`.** {@link CapabilityReachHealth.unreachable} fails the exit
 * because every `pithy <capability>` command for it refuses today. Skew refuses nothing, and a hard fail
 * would redden `doctor` for a project legitimately mid-upgrade with one Worker bumped ahead of another —
 * a red on a state somebody is in the middle of leaving. `bindingScope.ts`'s `dev` stanza is the same
 * asymmetry one section over: reported, explained, and green.
 *
 * **A copy whose version nobody can read contributes nothing**, rather than a `null` or an `unknown` in a
 * list of versions. A workspace link, a half-written install and a `package.json` that will not parse are
 * all *this cannot be named*, and putting a word that is not a version beside two that are is a report
 * inventing the fact it exists to state.
 *
 * ## It reports the package and never the module, and there is no `partial`
 *
 * Every other check in this directory carries one, because every other check reads a file that can fail to
 * open. This reads a directory entry per composed capability and cannot half-run: `existsSync` answers, or
 * answers `false`, and a `false` about a `node_modules` nobody can stat is reported as the fault it will
 * behave as. A field pinned at `false` forever would be the report claiming a hole it cannot have.
 *
 * ## Only what the catalog knows
 *
 * A composed capability the catalog does not name is the adopter's own — their `app` capability, or a
 * capability they wrote — and there is no `@pithy-sh/<name>` to look for. Interpolating the scope onto an
 * unknown name is how a project composing `billing` gets told `@pithy-sh/billing` is missing. The cost is
 * a kit capability newer than this CLI's catalog going unchecked, which is the right way round: an
 * unreported fault beats a reported fiction.
 */

/** One composed capability the CLI cannot resolve anywhere the project keeps its packages. */
export interface UnreachableCapability {
  /** The capability, as `pithy <capability>` and `pithy add <capability>` name it. */
  capability: string;
  /** The npm package that carries it — the catalog's, never `@pithy-sh/<name>` interpolated. */
  package: string;
  /** Every Worker composing it, in report order. The Workers whose configs still load. */
  workers: string[];
}

/** One composed capability whose composing Workers do not all resolve the same version of it (#539). */
export interface SplitCapability {
  /** The capability, as `pithy <capability>` names it. */
  capability: string;
  /** The npm package that carries it — the catalog's, never `@pithy-sh/<name>` interpolated. */
  package: string;
  /**
   * Every composing Worker that resolves a copy, with the version that copy declares, in report order.
   *
   * Always two or more distinct versions — a list that agrees with itself is not a finding. A Worker whose
   * copy declares no readable version is absent from it rather than carried as an unnamed one.
   */
  at: { worker: string; version: string }[];
}

/** What `doctor` learned about reaching the capabilities this project composes. */
export interface CapabilityReachHealth {
  /**
   * False as soon as one composed capability cannot be reached.
   *
   * **It fails the exit**, and it is established from this project's own files alone: its composition
   * against its own `node_modules`. Nothing about an account is inferred and no network is touched. Every
   * `pithy <capability>` command for it refuses today, so a green CI over it is CI agreeing that a
   * command nobody can run is fine. `pithy upgrade` cannot clear it either — it writes bindings and config
   * keys, and this is an install.
   */
  ok: boolean;
  /** Every composed capability the CLI can reach, by name, deduplicated and in report order. */
  reachable: string[];
  /** Every composed capability it cannot, in report order. */
  unreachable: UnreachableCapability[];
  /**
   * Every composed capability whose Workers resolve two or more versions of it, in report order.
   *
   * **It does not fail `ok`** — see the `#539` section above. Nothing refuses a project in this state, and
   * a project mid-upgrade is meant to be able to pass through it.
   */
  split: SplitCapability[];
}

/** The minimum this check needs to know about a Worker — what `buildProjectHealth` already holds. */
export interface ComposedWorker {
  /** The Worker's name, as the health block labels it. */
  name: string;
  /** The Worker's directory — where its own `node_modules` would be. */
  dir: string;
  /**
   * Its composed capabilities, in composition order.
   *
   * Optional because the Worker resolver is a test seam, and a double that supplies no composition is a
   * Worker that composes nothing rather than a hole. The same reading `HealthWorker.config` is given, and
   * for the same reason: a fixture must not be able to turn a report red.
   */
  capabilities?: readonly { name: string }[];
}

/** Every catalog capability this project composes, mapped to the Workers composing it, in report order. */
function composedCapabilities(workers: readonly ComposedWorker[]): Map<string, ComposedWorker[]> {
  const known = new Set(CATALOG.map((entry) => entry.name));
  const composed = new Map<string, ComposedWorker[]>();
  for (const worker of workers) {
    for (const capability of worker.capabilities ?? []) {
      if (!known.has(capability.name)) continue;
      const at = composed.get(capability.name) ?? [];
      if (!at.some((seen) => seen.name === worker.name)) at.push(worker);
      composed.set(capability.name, at);
    }
  }
  return composed;
}

/**
 * The version the copy `base` would load declares, or `null` where nothing there declares one.
 *
 * {@link packageDirFrom} rather than a resolver, on the same rule the rest of this family follows: a walk
 * asks the filesystem a question with one answer, so Node and Bun cannot differ about it, and every
 * `@pithy-sh/*` package exports `./src/*` alone — so `require.resolve("@pithy-sh/payments")` throws on an
 * install that is perfectly healthy.
 *
 * `null` covers three states that are one fact — nothing installed, a `package.json` that will not parse,
 * and one carrying no `version` — because each is *this copy cannot be named*, and a caller that must not
 * invent a version has nothing to do differently between them.
 */
function resolvedVersion(base: string, pkg: string): string | null {
  const home = packageDirFrom(base, pkg);
  if (home === null) return null;
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(home, "package.json"), "utf8"));
    const version = (manifest as { version?: unknown }).version;
    return typeof version === "string" && version !== "" ? version : null;
  } catch {
    return null;
  }
}

/**
 * The finding for one capability its Workers do not agree on, or `null` where they do.
 *
 * Keyed on the **version** and not on the resolved path, because the version is what the report names and
 * what would actually behave differently: two copies of one release are two copies of one package, and a
 * line saying `api has 5.0.0, admin has 5.0.0` states a fault that is not one.
 */
function splitAcross(capability: string, pkg: string, at: readonly ComposedWorker[]): SplitCapability | null {
  const found: { worker: string; version: string }[] = [];
  for (const worker of at) {
    const version = resolvedVersion(worker.dir, pkg);
    if (version !== null) found.push({ worker: worker.name, version });
  }
  if (new Set(found.map((entry) => entry.version)).size < 2) return null;
  return { capability, package: pkg, at: found };
}

/**
 * Compare what this project composes against what the CLI can resolve for it.
 *
 * Never throws — a diagnostic has to work in the broken project it exists to diagnose — and answers a
 * clean bill for a project that composes nothing the catalog knows, which is the honest reading of "the
 * question does not arise".
 */
export async function capabilityReachHealth(
  projectDir: string,
  workers: readonly ComposedWorker[],
): Promise<CapabilityReachHealth> {
  const reachable: string[] = [];
  const unreachable: UnreachableCapability[] = [];
  const split: SplitCapability[] = [];

  for (const [capability, at] of composedCapabilities(workers)) {
    const pkg = CATALOG.find((entry) => entry.name === capability)?.package ?? "";
    // The catalog is what `composedCapabilities` filtered on, so this cannot miss — the fallback is there
    // to keep the lookup total rather than to be reached, and an empty package name would find nothing.
    if (pkg !== "" && packageInstalledFrom(projectDir, pkg)) {
      reachable.push(capability);
      // Only here: a capability nothing resolves has no version anywhere to disagree about, and reporting
      // it twice would say two things about one install.
      const skew = splitAcross(capability, pkg, at);
      if (skew !== null) split.push(skew);
      continue;
    }
    unreachable.push({ capability, package: pkg, workers: at.map((worker) => worker.name) });
  }

  // `split` is deliberately not counted. See the `#539` section above: nothing refuses this state, and a
  // red on it is a red on a project in the middle of leaving it.
  return { ok: unreachable.length === 0, reachable, unreachable, split };
}
