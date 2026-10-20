// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { InputRequiredError, PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readConsoleGate } from "../privacy/consoleGate";
import { loadProject, loadProjectPrivacy } from "../project/config";
import { scaffoldProject } from "../project/scaffold";
import { linkKitPackages } from "../test-utils/linkKit";
import { expectConforms, runCaptured } from "../test-utils/payloadContract";
import { removeTempDir } from "../test-utils/tempRepo";
import { snapshotTree } from "../test-utils/treeSnapshot";
import { collectClasses, composesAudit, offerAudit, offerPrivacy, renderScan } from "./privacy";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-privacy-"));
  await scaffoldProject({ targetDir: dir, appName: "acme", worker: "api" });
  await linkKitPackages(dir, ["core"]);
  // The fixture Worker's schemas import zod themselves, as an adopter's do.
  const zod = dirname(createRequire(import.meta.url).resolve("zod/package.json"));
  await symlink(await realpath(zod), join(dir, "node_modules", "zod")).catch(() => undefined);
  vi.spyOn(process, "cwd").mockReturnValue(dir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await removeTempDir(dir);
});

describe("collectClasses", () => {
  test("takes every --class, repeated, with `=`, or comma-separated", () => {
    expect(collectClasses(["--class", "pii", "--class=phi", "--class", "pci, secret", "--json"])).toEqual([
      "pii",
      "phi",
      "pci",
      "secret",
    ]);
    expect(collectClasses(["--json"])).toEqual([]);
  });
});

describe("pithy privacy enable", () => {
  test("--class pii --class phi --json writes the root key and the rule, needs no prompt, and conforms", async () => {
    const written = await runCaptured("privacy enable", ["--class", "pii", "--class", "phi", "--json"]);
    await expectConforms("privacy enable", written);
    expect(JSON.parse(written.join(""))).toMatchObject({
      command: "privacy enable",
      classes: ["pii", "phi"],
      configChanged: true,
      biomeChanged: true,
      consoleGate: { state: "enforced", file: "biome.jsonc", reason: null },
    });
    expect(loadProjectPrivacy(await loadProject(dir, { fresh: true }))).toEqual(["pii", "phi"]);
    expect((await readConsoleGate(dir)).state).toBe("enforced");
  });

  test("is idempotent on re-run: the second run writes nothing", async () => {
    await runCaptured("privacy enable", ["--class", "pii", "--class", "phi", "--json"]);
    const before = await snapshotTree(dir);
    const again = JSON.parse(
      (await runCaptured("privacy enable", ["--class", "phi", "--class", "pii", "--json"])).join(""),
    );
    expect(again).toMatchObject({ configChanged: false, biomeChanged: false, classes: ["pii", "phi"] });
    expect(await snapshotTree(dir)).toEqual(before);
  });

  test("refuses input/required, naming --class, when nothing can be asked", async () => {
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => err.push(String(chunk)) > 0) as never);
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exited");
    }) as never);
    await runCaptured("privacy enable", ["--json"]).catch(() => undefined);
    expect(JSON.parse(err.join("").trim()).error).toMatchObject({ code: "input/required", flag: "--class" });
    expect(new InputRequiredError()).toBeInstanceOf(PithyError);
  });
});

describe("the offers between privacy and audit", () => {
  test("enable offers auditing; declining leaves the project as it was", async () => {
    const run = vi.fn(async () => {});
    const before = await snapshotTree(dir);
    await offerAudit(dir, { confirm: async () => false, run });
    expect(run).not.toHaveBeenCalled();
    expect(await snapshotTree(dir)).toEqual(before);
    await offerAudit(dir, { confirm: async () => true, run });
    expect(run).toHaveBeenCalledOnce();
  });

  test("reads each Worker's config as it is now, so a run that just added audit is not offered it again", async () => {
    // `pithy add audit` loads the Worker's config before it wires audit in, then offers privacy, whose enable
    // offers audit. That last read must see the wiring, not the module an earlier import cached.
    const config = (name: string) => `import { defineCapability } from "@pithy-sh/core/src/capability/capability";

const app = defineCapability({ name: "${name}", requiredBindings: [] });

export default { capabilities: [], app };
`;
    const path = join(dir, "apps", "api", "pithy.config.ts");
    await writeFile(path, config("app"));
    expect(await composesAudit(dir)).toBe(false);
    await writeFile(path, config("audit"));
    expect(await composesAudit(dir)).toBe(true);
  });

  test("add audit offers privacy in return; declining leaves it as it was, and a declared project is not asked", async () => {
    const run = vi.fn(async () => {});
    const confirm = vi.fn(async () => false);
    await offerPrivacy(dir, { confirm, run });
    expect(run).not.toHaveBeenCalled();
    expect(loadProjectPrivacy(await loadProject(dir, { fresh: true }))).toEqual([]);
    await offerPrivacy(dir, { confirm: async () => true, run });
    expect(run).toHaveBeenCalledOnce();

    await runCaptured("privacy enable", ["--class", "pii", "--json"]);
    confirm.mockClear();
    await offerPrivacy(dir, { confirm, run });
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("pithy privacy scan", () => {
  /** A Worker whose own table holds an unmarked email beside a marked diagnosis. */
  async function writeClinic(): Promise<void> {
    await mkdir(join(dir, "apps", "api"), { recursive: true });
    await writeFile(
      join(dir, "apps", "api", "pithy.config.ts"),
      `import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { phi } from "@pithy-sh/core/src/privacy/classes";
import { z } from "zod";

const Patient = z
  .object({
    id: z.string().describe("The patient's id."),
    email: z.string().describe("Where reminders go."),
    diagnosis: phi(z.string().describe("The recorded condition.")),
  })
  .describe("A patient.");

const app = defineCapability({
  name: "app",
  requiredBindings: [],
  databases: { app: { binding: "DB", tables: { patients: Patient } } },
});

export default { capabilities: [], app };
`,
    );
  }

  test("reports an unmarked email as a pii candidate with its marker, a marked field as covered, and exits 0", async () => {
    await writeClinic();
    const before = await snapshotTree(dir);
    const written = await runCaptured("privacy scan", ["--json"]);
    await expectConforms("privacy scan", written);
    const payload = JSON.parse(written.join(""));
    expect(payload.findings).toEqual([
      expect.objectContaining({
        worker: "api",
        schema: "patients",
        path: "email",
        status: "candidate",
        class: "pii",
        marker: "pii(…)",
      }),
      expect.objectContaining({
        worker: "api",
        schema: "patients",
        path: "diagnosis",
        status: "covered",
        class: "phi",
      }),
    ]);
    expect(payload).toMatchObject({ candidates: 1, covered: 1, unreadable: [] });
    expect(process.exitCode).toBeUndefined();
    // Advice only: not a byte of the project moved.
    expect(await snapshotTree(dir)).toEqual(before);
  });

  test("the human report names the marker and says nothing was changed", async () => {
    await writeClinic();
    const written = (await runCaptured("privacy scan", [])).join("");
    expect(written).toContain("api app patients.email: reads as pii. Mark it pii(…)");
    expect(written).toContain("covered, phi.");
    expect(written).toContain("Advice only: nothing was changed.");
    expect(process.exitCode).toBeUndefined();
  });

  test("a Worker whose config does not load is reported, and the scan still exits 0", async () => {
    await writeFile(join(dir, "apps", "api", "pithy.config.ts"), "export default { nope: true };\n");
    const payload = JSON.parse((await runCaptured("privacy scan", ["--json"])).join(""));
    expect(payload.unreadable).toEqual([expect.objectContaining({ worker: "api" })]);
    expect(process.exitCode).toBeUndefined();
  });

  test("renderScan says a kit schema is the kit's to mark", async () => {
    const lines = renderScan(
      [
        {
          worker: "api",
          capability: "auth",
          owner: "kit",
          storage: "d1",
          container: "app",
          schema: "users",
          path: "email",
          status: "candidate",
          class: "pii",
          marker: "pii(…)",
        },
      ],
      [],
    );
    expect(lines[0]).toContain("the kit marks it, not you");
    expect(await readFile(join(dir, "pithy.config.ts"), "utf8")).toContain("acme");
  });
});
