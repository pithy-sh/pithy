// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import type { BindingType } from "@pithy-sh/core/src/capability/bindings";
import { appliedTestBindings } from "@pithy-sh/core/src/capability/testBinding";
import { commandName, workerDirOf } from "@pithy-sh/core/src/cli/command";
import { addPlan, projectAddFacts } from "../capabilities/addCommand";
import { type AvailableManifests, composedManifests } from "../capabilities/manifests";
import { readOptionalFile } from "../project/readOptionalFile";
import { missingTestBindings, WORKERS_TEST_CONFIG } from "../project/workersTestConfig";

/**
 * **Does the Workers test config provide every test binding a composed capability declares?**
 *
 * The first request through a Worker's `fetch` checks every binding its composition requires, so a Workers
 * test that sends one fails on a binding the project-root `vitest.workers.config.ts` does not state. `pithy
 * add` writes them; this names the ones a project added before that, or removed by hand, and an optional one a
 * Worker's config came to require after its add. Files only, and a binding a test config cannot provide (`unbound`)
 * is never reported. It prints and never fails the exit: a project may test its Workers some other way.
 */

/** One composed capability whose test bindings the Workers config lacks. */
export interface MissingTestBindings {
  /** The capability's name. */
  capability: string;
  /** The Workers composing it, in report order. */
  workers: string[];
  /** The binding names the config does not provide, in declaration order. */
  bindings: string[];
  /** `pithy add` for the capability, on the first Worker composing it: a re-run writes the test bindings. */
  fix: string | null;
}

/** What the check established. */
export interface TestBindingsCheck {
  /**
   * `missing` when a composed capability's test bindings are absent; `ok` otherwise, or with no Workers test config;
   * `could-not-check` when reading the config or a manifest threw.
   */
  state: "ok" | "missing" | "could-not-check";
  /** One entry per capability, in the order the Workers compose them. */
  missing: MissingTestBindings[];
}

/**
 * A Worker as this check reads one: its name, directory, and what it composes. A capability's `requiredBindings`, as
 * the Worker's config builds it, decide which of its optional test bindings apply.
 */
export interface TestBindingsWorker {
  name: string;
  dir: string;
  capabilities: readonly {
    name: string;
    requiredBindings?: readonly { type: BindingType; name: string; optional?: boolean }[];
  }[];
}

/** Read the project's Workers test config against every composed capability's declared test bindings. */
export async function checkTestBindings(options: {
  projectDir: string;
  workers: readonly TestBindingsWorker[];
  /** Manifest seam; defaults to {@link composedManifests} for each Worker. */
  readManifests?: (projectDir: string, workerDir: string) => Promise<AvailableManifests>;
}): Promise<TestBindingsCheck> {
  const source = await readOptionalFile(join(options.projectDir, WORKERS_TEST_CONFIG));
  if (source === null) return { state: "ok", missing: [] };
  const read = options.readManifests ?? composedManifests;
  const byCapability = new Map<string, MissingTestBindings>();
  for (const worker of options.workers) {
    const { manifests } = await read(options.projectDir, worker.dir);
    for (const composed of worker.capabilities) {
      const { name } = composed;
      const manifest = manifests.find((candidate) => candidate.name === name);
      if (manifest === undefined) continue;
      const applied = appliedTestBindings(manifest, { requiredBindings: composed.requiredBindings ?? [] });
      const missing = missingTestBindings(source, applied).map((binding) => binding.name);
      if (missing.length === 0) continue;
      const entry = byCapability.get(name);
      if (entry === undefined) {
        // Composed already, so its config answers its options and its prerequisites are there.
        const fix =
          addPlan({
            capability: name,
            workers: [workerDirOf(worker)],
            factsFor: projectAddFacts(options.projectDir),
            composed: new Set(worker.capabilities.map((capability) => capability.name)),
            answered: new Set(manifest.configOptions.map((option) => option.key)),
          }).fix ?? null;
        byCapability.set(name, { capability: name, workers: [worker.name], bindings: missing, fix });
      } else if (!entry.workers.includes(worker.name)) entry.workers.push(worker.name);
    }
  }
  const missing = [...byCapability.values()];
  return { state: missing.length > 0 ? "missing" : "ok", missing };
}

/** One line per capability, none when nothing is missing, and one saying so when the check could not run. */
export function describeTestBindings(check: TestBindingsCheck): string[] {
  if (check.state === "could-not-check") {
    return [`Could not check ${WORKERS_TEST_CONFIG} against the composed capabilities' test bindings.`];
  }
  return check.missing.map(
    ({ capability, workers, bindings }) =>
      `${capability} (${workers.join(", ")}): ${bindings.join(", ")} missing from ${WORKERS_TEST_CONFIG}.`,
  );
}

/** The remedy line under the findings. */
export const TEST_BINDINGS_ACTION = `Run ${commandName("add")} <capability> again to write them, or add them by hand.`;
