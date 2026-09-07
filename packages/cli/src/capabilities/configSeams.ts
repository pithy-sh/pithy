// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { CONFIG_SEAMS, type ConfigOption, type ConfigSeam } from "@pithy-sh/core/src/capability/manifest";
import { readOptionalFile } from "../project/readOptionalFile";
import type { ConfigValue } from "./add";

/**
 * The modules `pithy add` writes for a capability option whose value is **behavior**.
 *
 * Core names the seam — the identifier, the path, the import specifier — from a closed set, exactly as it
 * names `PUBLIC_ORIGIN`. This file is the other half of that arrangement, and it is here for the same
 * reason `workerScaffold.ts` is the one that writes `export const PUBLIC_ORIGIN = …`: the CLI is what puts
 * files in an adopter's repository, and a runtime package has no business carrying the source of one.
 *
 * **Nothing in a manifest reaches these strings.** A manifest states a key; the key selects a record here.
 * That is the whole of the injection argument, and it is the same one #183 settled for a capability's own
 * name.
 */

/** The source `pithy add` writes for one seam. Keyed by the same closed set core enumerates. */
const SEAM_MODULES: Record<ConfigSeam, string> = {
  paymentsSubject: `import { type PaymentsSubjectResolver, unimplementedSubject } from "@pithy-sh/payments/src/index";

// Which organization is this caller acting for.
//
// Payments has no members table and never guesses a holder. Under \`billingSubject: "organization"\` the
// answer is a fact about your own membership model, and only your code has it.
//
// Until this file exports a real resolver, this Worker refuses to boot. That is deliberate. A resolver
// that answered nothing would compose cleanly and then deny every paying customer, which is worse than a
// Worker that does not start.
//
// Answer with the organization the request is acting for, or \`undefined\` when there is none — a signed-in
// person with no organization selected is exactly that, and it counts as unentitled rather than as a
// fault. Roughly:
//
//   export const resolveSubject: PaymentsSubjectResolver = async (c) => {
//     const organizationId = await activeOrganizationFor(c.var.auth?.userId);
//     return organizationId ? { subjectType: "organization", subjectId: organizationId } : undefined;
//   };
//
// Replace the line below with yours.
export const resolveSubject: PaymentsSubjectResolver = unimplementedSubject;
`,
};

/** The note `pithy add` prints for one seam it wrote — what the adopter still owes the Worker. */
const SEAM_NOTES: Record<ConfigSeam, (path: string) => string> = {
  paymentsSubject: (path) =>
    `${path} is scaffolded, not written. This Worker refuses to boot until resolveSubject answers which organization a caller is acting for.`,
};

/** One seam a run resolved: which it is, and the option value that asked for it. */
export interface ResolvedSeam {
  /** The seam's key into `CONFIG_SEAMS`. */
  seam: ConfigSeam;
  /** The option that named it, for the message and for ordering. */
  option: string;
}

/**
 * The seams this run's config values ask for, in manifest order.
 *
 * A seam is asked for by a **choice**, never by an option on its own: `billingSubject` needs no code under
 * `"user"` and needs a resolver under `"organization"`, and it is the same option either way. So the value
 * being written is what decides, which means this is asked after `--set` and any prompt have settled it.
 */
export function seamsFor(
  options: readonly ConfigOption[],
  values: Readonly<Record<string, ConfigValue>>,
): ResolvedSeam[] {
  const resolved: ResolvedSeam[] = [];
  for (const option of options) {
    const value = values[option.key];
    if (typeof value !== "string") continue;
    const seam = option.choicesNeedingSeam?.[value];
    if (seam !== undefined) resolved.push({ seam, option: option.key });
  }
  return resolved;
}

/** What {@link writeSeamModule} did: the path it names, and whether this run is what put it there. */
export interface SeamWrite {
  /** The module's path relative to the Worker's directory — what a note and a refusal both name. */
  path: string;
  /** True when this run created the file; false when one was already there and was left alone. */
  written: boolean;
}

/**
 * Write one seam's module into the Worker, and **never over one that is already there**.
 *
 * This is the highest-risk write `pithy add` makes, because the file it writes is the file the adopter is
 * asked to replace. A second `pithy add payments --set billingSubject=organization` — in CI, in a script
 * re-applying a manifest, by a colleague who did not know it had been run — must not take a working
 * resolver back to the placeholder. So existence is the whole test: if anything is at that path, it is
 * theirs.
 */
export async function writeSeamModule(workerDir: string, seam: ConfigSeam): Promise<SeamWrite> {
  const module = CONFIG_SEAMS[seam].module;
  const path = join(workerDir, module);
  const existing = await readOptionalFile(path);
  if (existing !== null) return { path: module, written: false };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, SEAM_MODULES[seam]);
  return { path: module, written: true };
}

/**
 * The line `pithy add` prints for a seam, naming the module as the adopter will open it —
 * `apps/<worker>/src/billing/subject.ts`, project-relative like the `--eject` line beside it.
 *
 * Derived from the Worker's own directory rather than spelling `apps/`, so a note and a path cannot come
 * to disagree about where Workers live.
 */
export function seamNote(seam: ConfigSeam, workerDir: string): string {
  const projectDir = dirname(dirname(workerDir));
  return SEAM_NOTES[seam](relative(projectDir, join(workerDir, CONFIG_SEAMS[seam].module)));
}
