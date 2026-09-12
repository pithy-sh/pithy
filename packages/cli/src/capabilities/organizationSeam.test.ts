// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityManifest, CONFIG_SEAMS } from "@pithy-sh/core/src/capability/manifest";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_WORKER, scaffoldProject } from "../project/scaffold";
import { addCapability } from "./add";

/**
 * **`pithy add organization` scaffolds the role catalog — a seam with no condition on it.**
 *
 * `payments`' `billingSubject` seam is asked for by a *choice*: `"user"` needs no code and
 * `"organization"` needs a resolver, and it is the same option either way. Tenancy has no such choice.
 * A capability whose whole subject is *who may do what* has no answer that is not the adopter's, so
 * there is no configuration under which the module is unnecessary and nothing to make it conditional
 * on — which is what the manifest-level `seams` field exists for.
 *
 * The two halves differ in one more way worth stating, because it changes what a re-run may cost. The
 * payments scaffold deliberately does **not** answer: it is branded unimplemented and the Worker
 * refuses to boot while the brand is on it, because a resolver returning nothing would compose cleanly
 * and then deny every paying customer. A starter role matrix *does* answer — three roles that nest, and
 * a project could ship on it — so the refusal cannot be a boot failure. What replaces it is the note:
 * a role name is stable forever once a membership holds one, so the cost of leaving the starter in
 * place is paid later and cannot be undone by editing this file.
 *
 * That is also why the never-overwrite rule matters more here than there, not less. A second
 * `pithy add organization` that reset a live matrix would silently change who may do what in every
 * organization, and nothing would fail.
 */

/** The real shipped manifest — the contract this is about, not a fixture resembling it. */
const organization = CapabilityManifest.parse(
  JSON.parse(
    await readFile(join(dirname(fileURLToPath(import.meta.url)), "../../../organization/pithy.manifest.json"), "utf8"),
  ),
);

const SEAM = CONFIG_SEAMS.organizationRoles;

let dir: string;
let worker: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-org-seam-"));
  await scaffoldProject({ targetDir: dir, appName: "org-seam-test" });
  worker = join(dir, "apps", DEFAULT_WORKER);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const configPath = () => join(worker, "pithy.config.ts");
const seamPath = () => join(worker, SEAM.module);
const readConfig = () => readFile(configPath(), "utf8");

describe("the shipped manifest", () => {
  test("declares the role catalog as a seam it always needs", () => {
    // Not `choicesNeedingSeam` on some option — there is no option it could hang off, and inventing one
    // would be a choice with one real answer.
    expect(organization.seams).toEqual(["organizationRoles"]);
  });

  test("names no option whose choice also asks for a seam", () => {
    // One mechanism per capability. A seam asked for twice would be written twice and wired twice.
    for (const option of organization.configOptions) {
      expect(option.choicesNeedingSeam ?? {}, option.key).toEqual({});
    }
  });
});

describe("pithy add organization", () => {
  test("writes the catalog module and wires it into the registration", async () => {
    const { notes } = await addCapability({ workerDir: worker, manifest: organization });

    const config = await readConfig();
    expect(config).toContain(`import { roles } from "${SEAM.specifier}";`);
    // Shorthand, inside the organization() call: the module exports the name the factory takes.
    expect(config).toMatch(/organization\(\{[\s\S]*\n\s{6}roles,\n[\s\S]*\}\),/);

    const module = await readFile(seamPath(), "utf8");
    expect(module).toContain("export const roles = defineRoles({");
    expect(module).toContain('from "@pithy-sh/organization/src/index"');
    // The starter matrix is a real one, not a placeholder that denies everything.
    expect(module).toContain('administrativePower: "organization:manage"');
    expect(module).toContain('unassignable: ["owner"]');

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`apps/${DEFAULT_WORKER}/${SEAM.module}`);
    // The cost that is paid later and cannot be undone by editing the file.
    expect(notes[0]).toContain("stable forever");
  });

  test("the seam import sits under the capability's own, and binds once", async () => {
    await addCapability({ workerDir: worker, manifest: organization });
    const config = await readConfig();
    expect(config.indexOf("import { organization }")).toBeLessThan(config.indexOf("import { roles }"));
    expect(config.match(/^import\s*\{\s*roles\s*\}/gm)).toHaveLength(1);
  });
});

describe("a re-run", () => {
  test("never takes a real matrix back to the starter", async () => {
    // The highest-risk write this command makes, and the one an adopter cannot recover from: resetting a
    // live matrix changes who may do what in every organization, and nothing fails.
    await addCapability({ workerDir: worker, manifest: organization });
    const theirs = 'export const roles = "this is mine";\n';
    await writeFile(seamPath(), theirs);

    const { notes } = await addCapability({ workerDir: worker, manifest: organization });

    expect(await readFile(seamPath(), "utf8")).toBe(theirs);
    // No note either: the note is the scaffold's, and telling them the file is a starter would be a
    // guess about code this command deliberately did not read.
    expect(notes).toEqual([]);
  });

  test("leaves the config exactly as it was", async () => {
    await addCapability({ workerDir: worker, manifest: organization });
    const before = await readConfig();
    await addCapability({ workerDir: worker, manifest: organization });
    expect(await readConfig()).toBe(before);
  });
});
