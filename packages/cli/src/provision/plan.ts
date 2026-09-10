// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { FeatureResourceKind } from "@pithy-sh/core/src/naming/feature";
import type { ProvisionScope, SecretNameScope } from "@pithy-sh/core/src/naming/provisionScope";
import type { ManifestFault } from "../capabilities/manifests";
import { dim } from "../terminal/style";
import { type ProvisionWorker, provisionTargets } from "./environment";
import { boundSecretNames, workerSecretRegistry } from "./secretBindings";

/**
 * **What a provisioning run is about to do, said before it does any of it (#515).**
 *
 * `pithy provision` reached an account, resolved every Worker, minted secrets and created databases
 * without printing a character until all of it had settled. The silence that prompted this was mostly
 * *before* the work loop — loading config, resolving Workers, reaching the account — which is exactly the
 * stretch where an operator's instinct to interrupt arrives. Streaming the loop alone leaves it quiet.
 *
 * So the plan comes first, and it comes **before the confirmation**: `assertProvisionConfirmed` is the
 * moment an operator is asked to agree to real Cloudflare resources, and it asked without saying what they
 * were. Everything below is already computed by then — nothing is created to produce it.
 *
 * **It is the run's own input, not a second guess at it.** {@link provisionTargets} is the single answer
 * to *what will this touch*, and the work loop takes the same value from the same call. A plan built from
 * `provisionableBindings(capabilities)` here would list every resource a declining Worker had removed, and
 * the run that followed would quietly create fewer things than it announced — a plan that misleads is
 * worse than no plan, because an operator acts on it.
 *
 * It also answers the thing that makes an interrupted run recoverable. Provisioning is idempotent, but
 * idempotence only helps someone who knows where it stopped: the plan plus the last `▸` line printed
 * names both the whole job and the resource that was in flight.
 */

/** One resource the run will find-or-create: what it backs, and what it will be called here. */
export interface PlannedResource {
  /** The kind of Cloudflare resource. */
  kind: FeatureResourceKind;
  /** The Worker binding it backs. */
  binding: string;
  /** Its name in this environment, composed from the scope — the same string the loop will use. */
  name: string;
}

/** Everything one provisioning run will touch. */
export interface ProvisionPlan {
  /** The project — the leading segment of every name below, and the only key teardown finds them by. */
  project: string;
  /** The environment being provisioned: the scope's stanza. */
  env: string;
  /** Every resource, in provision order. */
  resources: PlannedResource[];
  /** Each Worker whose config this run will write, by its deploy name. */
  workers: string[];
  /** Every Secrets Store entry this run will bind or mint, by entry name. */
  secrets: string[];
  /**
   * **Installed packages whose `pithy.manifest.json` is present and unusable — the reason a row above may
   * be wrong.**
   *
   * A plan is a promise, and one of these makes it a promise about the wrong resource: since #513 a
   * binding's `scope` and `resource` come out of these files, so a manifest that will not parse is a
   * project-global database planned — and created — under a per-environment name, with nothing said
   * (#184). Named *here* as well as in the report because this is printed **before** the confirmation,
   * which is the one moment an operator can decline a run rather than undo one.
   */
  manifestFaults: ManifestFault[];
}

/** Build the plan for a run. Reads the filesystem; reaches no account. */
export async function provisionPlan(options: {
  /** The project root — where each Worker's composed manifests are resolved from. */
  projectDir: string;
  /** The project name, from the root `pithy.config.ts`. */
  project: string;
  /** The scope: what everything is named, and which stanza the ids land in. */
  scope: ProvisionScope;
  /** Every capability the environment spans, deduped by name. */
  capabilities: Capability[];
  /** The resolved Workers — the same set the run will provision for. */
  workers: readonly ProvisionWorker[];
}): Promise<ProvisionPlan> {
  const { bindings, manifestFaults } = await provisionTargets(options);
  return {
    project: options.project,
    env: options.scope.stanza,
    manifestFaults,
    // The names come from the targets rather than being composed again here. A plan that recomputed them
    // would be a second read of `node_modules` and therefore a second answer to what a binding is called
    // — the split #513 is about, reintroduced between the plan and the run it describes.
    resources: bindings.map(({ binding, kind, name }) => ({ kind, binding, name })),
    workers: options.workers.map((worker) => worker.name),
    secrets: plannedSecrets(options.workers, options.scope),
  };
}

/**
 * Every Secrets Store entry the run will reach, deduped by entry name.
 *
 * **By entry, not by binding**, because that is what a run acts on: a `global` secret resolves to one
 * `<project>-global-<secret>` for every Worker that declares it, so listing it per Worker would announce
 * work that happens once. The plan cannot say which of these will be *minted* — that is `exists` in the
 * account, and the plan is written before anything reaches one — so it names what will be looked at.
 */
function plannedSecrets(workers: readonly ProvisionWorker[], scope: ProvisionScope): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const worker of workers) {
    const registry = workerSecretRegistry(worker.capabilities);
    if (!registry) continue;
    for (const binding of boundSecretNames(registry)) {
      const entry = registry[binding];
      if (!entry) continue;
      const name = scope.secretEntry(binding, entry.scope as SecretNameScope);
      if (seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/** The row label for each provisionable kind — the plural of the thing, as Cloudflare names it. */
const KIND_LABEL: Record<FeatureResourceKind, string> = { d1: "databases", kv: "namespaces", r2: "buckets" };

/** The order the rows read in, so two runs of one project never shuffle their plan. */
const KIND_ORDER: readonly FeatureResourceKind[] = ["d1", "kv", "r2"];

/**
 * Render the plan: a sentence, then one row per group of things.
 *
 * Plain lines, aligned by whitespace (docs/CLI.md §3.5) with the row labels dimmed as section labels
 * (§3.4). No spinner and no redraw anywhere near this: a repainting line loses the scrollback that is the
 * whole point of printing it, and is noise in a CI log.
 *
 * The labels are padded **before** they are dimmed — the escape codes are not characters, and padding a
 * colored string aligns the ANSI rather than the text.
 */
export function formatProvisionPlan(plan: ProvisionPlan): string {
  const rows: { label: string; items: string[] }[] = [];
  for (const kind of KIND_ORDER) {
    const named = plan.resources.filter((resource) => resource.kind === kind).map((resource) => resource.name);
    if (named.length > 0) rows.push({ label: KIND_LABEL[kind], items: named });
  }
  if (plan.workers.length > 0) rows.push({ label: "workers", items: plan.workers });
  if (plan.secrets.length > 0) rows.push({ label: "secrets", items: plan.secrets });

  const headline = `Provisioning ${plan.env} for ${plan.project}.`;
  // **Above the rows, because it is about what is missing from them.** A fault is not a row: naming the
  // broken package beside the databases would read as a thing being made. It comes first for the reason it
  // is printed at all — an operator reading a short plan has to be able to see why it is short, *before*
  // agreeing to it.
  const faults = manifestFaultLines(plan.manifestFaults).map((line) => `  ${line}`);
  // A project that composes nothing provisionable still gets the sentence. An empty column under it would
  // read as output that failed to render rather than as a run with nothing to make.
  const body = rows.length === 0 ? [] : [renderRows(rows)];
  return [headline, ...faults, ...body].join("\n\n");
}

/** The aligned rows, as one block. Separated from the headline so a fault block can sit between them. */
function renderRows(rows: { label: string; items: string[] }[]): string {
  const width = Math.max(...rows.map((row) => row.label.length));
  return rows.map((row) => `  ${dim(row.label.padEnd(width))}  ${row.items.join(", ")}`).join("\n");
}

/**
 * The lines for a manifest that is installed and unusable — `pithy upgrade`'s two lines, in `provision`'s
 * words (#184).
 *
 * A capability with one of these appears nowhere else in a plan or a report, and the run still provisions
 * for it: its bindings come from the **composed instance**, which is fine, while its `scope`, its
 * `resource` and its declines come from this file, which nobody read. So the resource is created under
 * the generic name and a decline of it reads as `unrecognized`. The sentence says which half was lost,
 * because that is the half an operator has to go and check.
 */
export function manifestFaultLines(faults: readonly ManifestFault[]): string[] {
  return faults.flatMap((fault) => [
    `${fault.package}: malformed pithy.manifest.json. Its resource naming and declines went unread.`,
    ...fault.reason.split("\n").map((line) => `  ${line}`),
  ]);
}
