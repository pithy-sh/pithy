// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { DevSecretsSeedReport } from "../devSecrets/seed";
import { devConfigPath } from "../feature/devConfig";
import type { WorkerTarget } from "../project/workers";
import { removeTempDir } from "../test-utils/tempRepo";
import type { DevSet } from "./devSet";
import { prepareDevCheckout } from "./prepare";

/**
 * **What `pithy dev` does before it starts anything, as one step `pithy setup` runs and stops after (#764).** Every
 * member of the dev set gets a pinned port, every Worker gets its generated `.dev.vars`, and the dev secrets reach
 * the local store. Nothing is spawned, and a second run moves nothing.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

async function project(): Promise<{ dir: string; registry: string; api: WorkerTarget; email: WorkerTarget }> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-dev-prepare-"));
  dirs.push(dir);
  const api = { name: "acme-api", dir: join(dir, "apps", "api"), hasWrangler: true };
  await mkdir(api.dir, { recursive: true });
  return {
    dir,
    registry: join(dir, ".config", "dev-ports.json"),
    api,
    email: { name: "email", dir: join(dir, "host") },
  };
}

/** The dev set: one app Worker and one capability host. */
function devSet(api: WorkerTarget, email: WorkerTarget): DevSet {
  return {
    project: "acme",
    members: [
      { worker: api, kind: "app", autostart: true, autostartLocal: false },
      { worker: email, kind: "host", autostart: true, autostartLocal: false },
    ],
    hosts: [],
    hostNames: new Set(["email"]),
    notes: [],
  };
}

const SEEDED: DevSecretsSeedReport = {
  seeded: ["auth-session-secret"],
  unchanged: [],
  minted: [],
  devVars: [],
  missing: [],
  undeclared: [],
  skipped: [],
};

describe("prepareDevCheckout", () => {
  test("pins a port for every member, generates each app Worker's .dev.vars, and seeds the dev secrets", async () => {
    const { dir, registry, api, email } = await project();
    const generated: string[][] = [];
    let seeded = 0;

    const prepared = await prepareDevCheckout({
      projectDir: dir,
      resolveSet: async () => devSet(api, email),
      ensureDeps: { registryPathFor: async () => registry, rootFor: async () => dir, branchFor: async () => "main" },
      generateDevVars: async ({ workerDirs }) => {
        generated.push(workerDirs ?? []);
        return { generated: workerDirs ?? [], unchanged: [], refused: [], relinked: [], names: [], unresolvable: [] };
      },
      seedSecrets: async () => {
        seeded += 1;
        return SEEDED;
      },
    });

    expect(prepared.allocated).toBe(true);
    expect(Object.keys(prepared.dev?.workers ?? {}).sort()).toEqual(["acme-api", "email"]);
    expect(JSON.parse(await readFile(devConfigPath(dir), "utf8"))).toEqual(prepared.dev);
    expect(generated).toEqual([[api.dir]]);
    expect(prepared.devVars).toEqual([api.dir]);
    expect(seeded).toBe(1);
    expect(prepared.seededSecrets).toEqual(["auth-session-secret"]);
  });

  test("a second run keeps every port where it was and allocates nothing", async () => {
    const { dir, registry, api, email } = await project();
    const options = {
      projectDir: dir,
      resolveSet: async () => devSet(api, email),
      ensureDeps: {
        registryPathFor: async () => registry,
        rootFor: async () => dir,
        branchFor: async () => "main",
      },
      generateDevVars: async () => ({
        generated: [],
        unchanged: [api.dir],
        refused: [],
        relinked: [],
        names: [],
        unresolvable: [],
      }),
      seedSecrets: async () => ({ ...SEEDED, seeded: [], unchanged: ["auth-session-secret"] }),
    };
    const first = await prepareDevCheckout(options);
    const before = await readFile(devConfigPath(dir), "utf8");

    const second = await prepareDevCheckout(options);

    expect(second.allocated).toBe(false);
    expect(second.dev).toEqual(first.dev);
    expect(second.devVars).toEqual([]);
    expect(second.seededSecrets).toEqual([]);
    expect(await readFile(devConfigPath(dir), "utf8")).toBe(before);
  });

  test("a dry run says it would allocate, and writes, generates and seeds nothing", async () => {
    const { dir, registry, api, email } = await project();
    let touched = false;

    const prepared = await prepareDevCheckout({
      projectDir: dir,
      dryRun: true,
      resolveSet: async () => devSet(api, email),
      ensureDeps: { registryPathFor: async () => registry, rootFor: async () => dir, branchFor: async () => "main" },
      generateDevVars: async () => {
        touched = true;
        throw new Error("a dry run generated .dev.vars");
      },
      seedSecrets: async () => {
        touched = true;
        throw new Error("a dry run seeded secrets");
      },
    });

    expect(prepared.allocated).toBe(true);
    expect(prepared.dev).toBeNull();
    expect(prepared.devVarsDirs).toEqual([api.dir]);
    expect(touched).toBe(false);
    expect(await readFile(devConfigPath(dir), "utf8").catch(() => null)).toBeNull();
  });

  test("a .dev.vars pithy did not write is named, and the run goes on", async () => {
    const { dir, registry, api, email } = await project();
    await writeFile(join(api.dir, ".dev.vars"), "MINE=1\n");

    const prepared = await prepareDevCheckout({
      projectDir: dir,
      resolveSet: async () => devSet(api, email),
      ensureDeps: { registryPathFor: async () => registry, rootFor: async () => dir, branchFor: async () => "main" },
      generateDevVars: async () => ({
        generated: [],
        unchanged: [],
        refused: ["apps/api/.dev.vars was not written by pithy, so it was left as it is."],
        relinked: [],
        names: [],
        unresolvable: [],
      }),
      seedSecrets: async () => SEEDED,
    });

    expect(prepared.notes).toContain("apps/api/.dev.vars was not written by pithy, so it was left as it is.");
  });
});
