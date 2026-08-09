// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { assertEnvironmentProvisioned, unprovisionedBindings } from "./unprovisioned";

describe("unprovisionedBindings", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-unprovisioned-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function worker(name: string, wrangler: unknown): Promise<void> {
    const workerDir = join(dir, "apps", name);
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "wrangler.jsonc"), `${JSON.stringify(wrangler, null, 2)}\n`);
    await writeFile(join(workerDir, "pithy.worker.jsonc"), '{ "dev": { "autostart": true } }\n');
  }

  test("names every binding in the environment that has no id", async () => {
    await worker("board", {
      name: "replay-board",
      env: {
        staging: {
          d1_databases: [{ binding: "DB", database_name: "replay-staging-db" }],
          kv_namespaces: [{ binding: "CACHE", id: "already-there" }],
          r2_buckets: [{ binding: "ASSETS" }],
        },
      },
    });

    expect(await unprovisionedBindings(dir, "staging")).toEqual([
      { worker: "board", kind: "d1", binding: "DB" },
      { worker: "board", kind: "r2", binding: "ASSETS" },
    ]);
  });

  test("a fully provisioned environment reports nothing", async () => {
    await worker("board", {
      name: "replay-board",
      env: { staging: { d1_databases: [{ binding: "DB", database_id: "uuid" }] } },
    });
    expect(await unprovisionedBindings(dir, "staging")).toEqual([]);
  });

  /** A placeholder is what a scaffold leaves behind; it is not an id, and wrangler will not accept it. */
  test("a placeholder id counts as unprovisioned", async () => {
    await worker("board", {
      name: "replay-board",
      env: { staging: { d1_databases: [{ binding: "DB", database_id: "<database_id>" }] } },
    });
    expect(await unprovisionedBindings(dir, "staging")).toEqual([{ worker: "board", kind: "d1", binding: "DB" }]);
  });

  test("a Worker with no stanza for that environment contributes nothing to check", async () => {
    await worker("board", { name: "replay-board", env: { prod: {} } });
    expect(await unprovisionedBindings(dir, "staging")).toEqual([]);
  });

  test("refuses a deploy into an environment whose bindings have no ids, naming the command", async () => {
    await worker("board", {
      name: "replay-board",
      env: { staging: { d1_databases: [{ binding: "DB", database_name: "replay-staging-db" }] } },
    });

    const failure = await assertEnvironmentProvisioned(dir, "staging").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.action).toContain("pithy provision --env staging");
    expect((failure as PithyError).payload.message).toContain("DB");
  });

  test("lets a provisioned deploy through", async () => {
    await worker("board", {
      name: "replay-board",
      env: { staging: { d1_databases: [{ binding: "DB", database_id: "uuid" }] } },
    });
    await expect(assertEnvironmentProvisioned(dir, "staging")).resolves.toBeUndefined();
  });
});
