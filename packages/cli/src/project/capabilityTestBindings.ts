// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { BindingType } from "@pithy-sh/core/src/capability/bindings";
import { appliedTestBindings, type TestBinding } from "@pithy-sh/core/src/capability/testBinding";
import type { LockfileSync } from "./rootConfigImports";
import { writeTestBindings } from "./workersTestConfig";
import { writeEnvBindings } from "./workersTestEnv";

/** A binding as a manifest or a composed capability lists it. */
interface RequiredBinding {
  type: BindingType;
  name: string;
  optional?: boolean;
}

/**
 * Write the test bindings that apply to one composition of a capability into the project's Workers test config and
 * the Worker's `Cloudflare.Env` declaration, returning the notes `pithy add` prints. They are the ones for the
 * bindings its manifest requires, and one for an optional binding when `composed` builds the capability as the
 * Worker's config has it and that instance requires the binding. `composed` runs only for a manifest declaring a
 * test binding for an optional binding, and one that throws or finds nothing leaves the manifest's required ones.
 * `sync` runs when a package a binding imports was declared at the root.
 */
export async function writeCapabilityTestBindings(options: {
  projectDir: string;
  workerDir: string;
  manifest: { name: string; requiredBindings: readonly RequiredBinding[]; testBindings: readonly TestBinding[] };
  composed: () => Promise<{ requiredBindings: readonly RequiredBinding[] } | undefined>;
  sync?: LockfileSync;
}): Promise<string[]> {
  const { projectDir, workerDir, manifest, composed, sync } = options;
  const optional = manifest.requiredBindings.filter((binding) => binding.optional === true);
  const declaresOptional = manifest.testBindings.some((binding) =>
    optional.some((candidate) => candidate.name === binding.name),
  );
  let instance: { requiredBindings: readonly RequiredBinding[] } | undefined;
  try {
    instance = declaresOptional ? await composed() : undefined;
  } catch {
    instance = undefined;
  }
  const applied = appliedTestBindings(manifest, instance);
  const notes = await writeTestBindings(projectDir, manifest.name, applied, sync);
  await writeEnvBindings(workerDir, applied);
  return notes;
}
