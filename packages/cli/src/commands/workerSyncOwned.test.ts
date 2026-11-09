// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { addCapability } from "../capabilities/add";
import { scaffoldProject } from "../project/scaffold";
import { linkKitPackages } from "../test-utils/linkKit";
import { expectConforms, runCaptured } from "../test-utils/payloadContract";

/** An app capability that declares one database, the way `organization` and `controlplane` do. */
const APP_CONFIG = `import { defineCapability } from "@pithy-sh/core/src/capability/capability";

const app = defineCapability({ name: "app", requiredBindings: [{ type: "d1", name: "DB" }] });

export default { capabilities: [], app };
`;

const manifest = CapabilityManifest.parse({
  name: "app",
  package: "@pithy-sh/app",
  requiredBindings: [{ type: "d1", name: "DB" }],
});

interface Entry {
  binding: string;
  database_name?: string;
  database_id?: string;
}

let dir: string;
let worker: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-worker-sync-own-"));
  await scaffoldProject({ targetDir: dir, appName: "my-app", worker: "other" });
  await linkKitPackages(dir, ["core"]);
  worker = join(dir, "apps", "other");
  // The bindings, scaffolded before the Worker owned anything: what `pithy add` writes for a shared DB.
  await addCapability({ workerDir: worker, manifest, project: "my-app" });
  await writeFile(join(worker, "pithy.config.ts"), APP_CONFIG);
  vi.spyOn(process, "cwd").mockReturnValue(dir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const topLevel = async (): Promise<Entry[] | undefined> =>
  (parse(await readFile(join(worker, "wrangler.jsonc"), "utf8")) as unknown as { d1_databases?: Entry[] }).d1_databases;

describe("pithy worker sync with ownBindings", () => {
  test("writes the owned top-level database_id when the entry is added, and removes it when it is taken out", async () => {
    expect(await topLevel()).toEqual([{ binding: "DB", database_name: "my-app-dev-db" }]);

    await writeFile(join(worker, "pithy.worker.jsonc"), '{\n  "ownBindings": ["DB"]\n}\n');
    const added = await runCaptured("worker sync", ["--worker", "other", "--json"]);
    await expectConforms("worker sync", added);
    expect(await topLevel()).toEqual([
      { binding: "DB", database_name: "my-app-dev-other---db", database_id: "my-app-dev-other---db" },
    ]);
    expect(JSON.parse(added.join("")).ownedBindings).toContainEqual({
      env: "dev",
      binding: "DB",
      field: "database_id",
      to: "my-app-dev-other---db",
    });

    await writeFile(join(worker, "pithy.worker.jsonc"), "{}\n");
    await runCaptured("worker sync", ["--worker", "other", "--json"]);
    expect(await topLevel()).toEqual([{ binding: "DB", database_name: "my-app-dev-db" }]);
  });

  test("refuses to own a global binding though the Worker composes no database", async () => {
    await writeFile(
      join(worker, "pithy.config.ts"),
      APP_CONFIG.replace('{ type: "d1", name: "DB" }', '{ type: "r2", name: "SUPPORT_BUCKET", scope: "global" }'),
    );
    await writeFile(join(worker, "pithy.worker.jsonc"), '{\n  "ownBindings": ["SUPPORT_BUCKET"]\n}\n');
    const before = await readFile(join(worker, "wrangler.jsonc"), "utf8");
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => err.push(String(chunk)) > 0) as never);
    const exited = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exited");
    }) as never);
    await runCaptured("worker sync", ["--worker", "other", "--json"]).catch(() => undefined);
    expect(exited).toHaveBeenCalled();
    expect(JSON.parse(err.join("").trim()).error.message).toMatch(/owns SUPPORT_BUCKET, which app declares global/);
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toBe(before);
  });

  test("refuses to own a binding the installed manifest declares global, before it writes the route its domains imply", async () => {
    // The shipped email package in the Worker's own node_modules, and a capability object that, like the
    // shipped one, says nothing of `scope`: the manifest is the only place EMAIL_SUPPRESSIONS is global.
    await linkKitPackages(worker, ["email"]);
    await writeFile(
      join(worker, "pithy.config.ts"),
      `import { defineCapability } from "@pithy-sh/core/src/capability/capability";

const email = defineCapability({ name: "email", requiredBindings: [{ type: "d1", name: "EMAIL_SUPPRESSIONS" }] });

export default { domains: { prod: { pattern: "api.acme.com", zone: "acme.com" } }, capabilities: [email] };
`,
    );
    await writeFile(join(worker, "pithy.worker.jsonc"), '{\n  "ownBindings": ["EMAIL_SUPPRESSIONS"]\n}\n');
    const before = await readFile(join(worker, "wrangler.jsonc"), "utf8");
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => err.push(String(chunk)) > 0) as never);
    const exited = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exited");
    }) as never);
    await runCaptured("worker sync", ["--worker", "other", "--json"]).catch(() => undefined);
    expect(exited).toHaveBeenCalled();
    expect(JSON.parse(err.join("").trim()).error.message).toMatch(
      /owns EMAIL_SUPPRESSIONS, which email declares global/,
    );
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toBe(before);
  });
});
