// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CATALOG } from "../capabilities/catalog";
import { packageInstalledFrom } from "../project/kitResolve";

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
function composedCapabilities(workers: readonly ComposedWorker[]): Map<string, string[]> {
  const known = new Set(CATALOG.map((entry) => entry.name));
  const composed = new Map<string, string[]>();
  for (const worker of workers) {
    for (const capability of worker.capabilities ?? []) {
      if (!known.has(capability.name)) continue;
      const at = composed.get(capability.name) ?? [];
      if (!at.includes(worker.name)) at.push(worker.name);
      composed.set(capability.name, at);
    }
  }
  return composed;
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

  for (const [capability, at] of composedCapabilities(workers)) {
    const pkg = CATALOG.find((entry) => entry.name === capability)?.package ?? "";
    // The catalog is what `composedCapabilities` filtered on, so this cannot miss — the fallback is there
    // to keep the lookup total rather than to be reached, and an empty package name would find nothing.
    if (pkg !== "" && packageInstalledFrom(projectDir, pkg)) {
      reachable.push(capability);
      continue;
    }
    unreachable.push({ capability, package: pkg, workers: at });
  }

  return { ok: unreachable.length === 0, reachable, unreachable };
}
