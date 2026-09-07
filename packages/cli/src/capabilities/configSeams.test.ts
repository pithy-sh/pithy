// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityManifest, CONFIG_SEAMS } from "@pithy-sh/core/src/capability/manifest";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_WORKER, scaffoldProject } from "../project/scaffold";
import { addCapability } from "./add";
import { seamsFor } from "./configSeams";

/**
 * **Organization billing, without ever typing `user` — #500.**
 *
 * `billingSubject` is required, offers two values, and used to refuse one of them: the only route to
 * organization billing was `--set billingSubject=user`, a value that is wrong for the project, followed by
 * a hand-edit. The end state was right and both refusals that produced it were right. The path was the
 * bug — an adopter's git history recorded a command naming the mode they did not want.
 *
 * What replaces it is a **scaffolded seam**, and the whole of its safety is that the scaffold does not
 * answer. `pithy add` writes `src/billing/subject.ts` exporting a resolver branded unimplemented, imports
 * it, and passes it to `payments(...)`. The config loads, so every `pithy` command in the project keeps
 * working; the Worker's entrypoint refuses, so nothing serves a request until the adopter has written the
 * one thing only they can write. A stub returning `null` would have satisfied both halves and then denied
 * every paying customer, which is why one was never written.
 */

/** The real `@pithy-sh/payments` manifest — the contract this is about, not a fixture resembling it. */
const payments = CapabilityManifest.parse(
  JSON.parse(
    await readFile(join(dirname(fileURLToPath(import.meta.url)), "../../../payments/pithy.manifest.json"), "utf8"),
  ),
);

const SEAM = CONFIG_SEAMS.paymentsSubject;

let dir: string;
let worker: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-seam-"));
  await scaffoldProject({ targetDir: dir, appName: "seam-test" });
  worker = join(dir, "apps", DEFAULT_WORKER);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const configPath = () => join(worker, "pithy.config.ts");
const seamPath = () => join(worker, SEAM.module);
const readConfig = () => readFile(configPath(), "utf8");

describe("payments' manifest", () => {
  test("offers organization rather than refusing it", () => {
    const option = payments.configOptions.find((entry) => entry.key === "billingSubject");
    expect(option?.choices).toEqual(["user", "organization"]);
    // The refusal map is what made `--set billingSubject=organization` a dead end. It is empty now, and
    // that is what `coerceConfigValue` and `flagsFor` both read.
    expect(option?.choicesNeedingCode?.organization).toBeUndefined();
    expect(option?.choicesNeedingSeam?.organization).toBe("paymentsSubject");
  });
});

describe("seamsFor", () => {
  test("names a seam only for the choice that needs one", () => {
    expect(seamsFor(payments.configOptions, { billingSubject: "organization" })).toEqual([
      { seam: "paymentsSubject", option: "billingSubject" },
    ]);
    // The same option, the other value: `user` resolves from the authenticated caller and needs nothing.
    expect(seamsFor(payments.configOptions, { billingSubject: "user" })).toEqual([]);
    expect(seamsFor(payments.configOptions, {})).toEqual([]);
  });
});

describe("pithy add payments --set billingSubject=organization", () => {
  test("writes the choice, the seam module, and the wiring between them", async () => {
    const { notes } = await addCapability({
      workerDir: worker,
      manifest: payments,
      configValues: { billingSubject: "organization" },
    });

    const config = await readConfig();
    expect(config).toContain('billingSubject: "organization",');
    expect(config).toContain(`import { resolveSubject } from "${SEAM.specifier}";`);
    // Shorthand, inside the payments() call: the module exports the name the factory takes.
    expect(config).toMatch(/payments\(\{[\s\S]*\n\s{6}resolveSubject,\n[\s\S]*\}\),/);

    const module = await readFile(seamPath(), "utf8");
    expect(module).toContain("export const resolveSubject: PaymentsSubjectResolver = unimplementedSubject;");
    expect(module).toContain('from "@pithy-sh/payments/src/index"');

    // The one line that says the config loads and the Worker will not start.
    expect(notes).toHaveLength(1);
    // Project-relative, like every other path this command prints.
    expect(notes[0]).toContain(`apps/${DEFAULT_WORKER}/${SEAM.module}`);
    expect(notes[0]).toContain("refuses to boot");
  });

  test("the seam import sits under the capability's own, and both bind once", async () => {
    await addCapability({
      workerDir: worker,
      manifest: payments,
      configValues: { billingSubject: "organization" },
    });

    const config = await readConfig();
    expect(config.indexOf("import { payments }")).toBeLessThan(config.indexOf("import { resolveSubject }"));
    expect(config.match(/^import\s*\{\s*resolveSubject\s*\}/gm)).toHaveLength(1);
  });

  test("the other choice writes no module and no seam line", async () => {
    const { notes } = await addCapability({
      workerDir: worker,
      manifest: payments,
      configValues: { billingSubject: "user" },
    });

    expect(await readConfig()).not.toContain("resolveSubject");
    expect(notes).toEqual([]);
    await expect(readFile(seamPath(), "utf8")).rejects.toThrow();
  });
});

/**
 * **The highest-risk half of the change, and the one an adopter cannot recover from.**
 *
 * The file `pithy add` writes is the file the adopter is asked to replace. A second run — in CI, in a
 * script re-applying a manifest, by a colleague who did not know it had been run — must never take a
 * working resolver back to the placeholder. Losing real code is worse than the bug this fixes.
 */
describe("a re-run", () => {
  test("changes neither the config nor the seam module", async () => {
    await addCapability({
      workerDir: worker,
      manifest: payments,
      configValues: { billingSubject: "organization" },
    });
    const config = await readConfig();
    const module = await readFile(seamPath(), "utf8");

    const again = await addCapability({
      workerDir: worker,
      manifest: payments,
      configValues: { billingSubject: "organization" },
    });

    expect(await readConfig()).toBe(config);
    expect(await readFile(seamPath(), "utf8")).toBe(module);
    // Nothing was scaffolded, so nothing is reported — a second `Done.` must not repeat a warning about
    // a file this run did not touch.
    expect(again.notes).toEqual([]);
  });

  test("never overwrites an implemented resolver", async () => {
    await addCapability({
      workerDir: worker,
      manifest: payments,
      configValues: { billingSubject: "organization" },
    });
    const implemented =
      "export const resolveSubject = async () => ({ subjectType: 'organization', subjectId: 'acme' });\n";
    await writeFile(seamPath(), implemented);

    await addCapability({
      workerDir: worker,
      manifest: payments,
      configValues: { billingSubject: "organization" },
    });

    expect(await readFile(seamPath(), "utf8")).toBe(implemented);
  });

  test("does not wire a seam into a registration it is not rewriting", async () => {
    // The registration already answers `user`, and this run says `organization`. `add` never rewrites a
    // registration the adopter has, so the value stays `user` — and the seam must stay with it. Wiring it
    // anyway would leave an import nothing references, a file nobody asked for, and a config whose two
    // halves disagree about what this project bills.
    await addCapability({ workerDir: worker, manifest: payments, configValues: { billingSubject: "user" } });

    const { notes } = await addCapability({
      workerDir: worker,
      manifest: payments,
      configValues: { billingSubject: "organization" },
    });

    const config = await readConfig();
    expect(config).toContain('billingSubject: "user",');
    expect(config).not.toContain("resolveSubject");
    expect(notes).toEqual([]);
    await expect(readFile(seamPath(), "utf8")).rejects.toThrow();
  });

  test("leaves an adopter's own module alone even when the registration is new", async () => {
    // The registration was removed and payments is being composed again, over a resolver they wrote in
    // between. The wiring lands; the file does not.
    const mine = "export const resolveSubject = async () => undefined;\n";
    await mkdir(dirname(seamPath()), { recursive: true });
    await writeFile(seamPath(), mine);

    const { notes } = await addCapability({
      workerDir: worker,
      manifest: payments,
      configValues: { billingSubject: "organization" },
    });

    expect(await readFile(seamPath(), "utf8")).toBe(mine);
    expect(await readConfig()).toContain("resolveSubject,");
    // No note: the file is theirs, and calling it unimplemented would be a guess about code this command
    // deliberately did not read.
    expect(notes).toEqual([]);
  });
});

describe("a binding already taken", () => {
  test("is refused rather than shadowed", async () => {
    const config = await readConfig();
    await writeFile(configPath(), `import { resolveSubject } from "./src/mine";\n${config}`);

    const thrown = await addCapability({
      workerDir: worker,
      manifest: payments,
      configValues: { billingSubject: "organization" },
    }).catch((error: unknown) => error as PithyError);

    expect(thrown).toBeInstanceOf(PithyError);
    expect((thrown as PithyError).payload.message).toContain("./src/mine");
    // Nothing written: a refused seam leaves the file as it was, not half-wired.
    expect(await readConfig()).toBe(`import { resolveSubject } from "./src/mine";\n${config}`);
  });
});
