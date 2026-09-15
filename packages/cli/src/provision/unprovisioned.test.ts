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
    await writeFile(join(workerDir, "pithy.worker.jsonc"), '{ "dev": {} }\n');
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

  test("a Worker with no stanza and no top-level bindings contributes nothing to check", async () => {
    await worker("board", { name: "replay-board", env: { prod: {} } });
    expect(await unprovisionedBindings(dir, "staging")).toEqual([]);
  });

  /**
   * **wrangler ships the top level for an environment it cannot find**, with a warning nobody reads in a
   * captured deploy. So a Worker with no `env.staging` deploys dev's bindings as staging, and those are
   * exactly the id-less ones.
   */
  test("a Worker with no stanza for that environment is held to the top level wrangler will ship", async () => {
    await worker("board", {
      name: "replay-board",
      d1_databases: [{ binding: "DB", database_name: "replay-dev-db" }],
      env: { prod: {} },
    });
    expect(await unprovisionedBindings(dir, "staging")).toEqual([{ worker: "board", kind: "d1", binding: "DB" }]);
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

  /**
   * **#589: the top-level stanza is what a bare deploy and `--env dev` ship, and it was never read.**
   *
   * `unprovisionedBindings(dir, "dev")` read `env.dev`, which no project may declare, so it found nothing;
   * a bare deploy did not ask at all. The stanza `pithy dev` runs holds `database_name`s Miniflare resolves
   * and no ids — the exact shape wrangler provisions from.
   */
  const LOCAL_ONLY = {
    name: "replay-board",
    d1_databases: [{ binding: "DB", database_name: "replay-dev-db" }],
    kv_namespaces: [{ binding: "CACHE" }],
    env: { staging: { d1_databases: [{ binding: "DB", database_id: "uuid" }] } },
  };

  test("a bare deploy is held to the top-level stanza", async () => {
    await worker("board", LOCAL_ONLY);
    expect(await unprovisionedBindings(dir, undefined)).toEqual([
      { worker: "board", kind: "d1", binding: "DB" },
      { worker: "board", kind: "kv", binding: "CACHE" },
    ]);
  });

  test("so is --env dev, because dev is the top level and not an env.dev", async () => {
    await worker("board", LOCAL_ONLY);
    expect(await unprovisionedBindings(dir, "dev")).toEqual([
      { worker: "board", kind: "d1", binding: "DB" },
      { worker: "board", kind: "kv", binding: "CACHE" },
    ]);
    // And the named environment beside it is still read from its own stanza.
    expect(await unprovisionedBindings(dir, "staging")).toEqual([]);
  });

  test("a bare deploy refuses, naming the bindings and the environments that have resources", async () => {
    await worker("board", LOCAL_ONLY);
    for (const env of [undefined, "dev"]) {
      const failure = (await assertEnvironmentProvisioned(dir, env).catch((error: unknown) => error)) as PithyError;
      expect(failure, String(env)).toBeInstanceOf(PithyError);
      expect(failure.payload.message).toContain("board.DB (d1)");
      expect(failure.payload.message).toContain("board.CACHE (kv)");
      // dev has nothing to provision — it is local — so the remedy is the environment that does.
      expect(failure.payload.action).toContain("--env staging");
      expect(failure.payload.action).toContain("--env prod");
      expect(failure.payload.action).not.toContain("pithy provision");
    }
  });

  test("a feature environment is held to its generated config, where its ids live", async () => {
    await worker("board", LOCAL_ONLY);
    const generated = join(dir, "apps", "board", ".wrangler", "pithy");
    await mkdir(generated, { recursive: true });
    await writeFile(
      join(generated, "wrangler.feature.jsonc"),
      JSON.stringify({
        name: "replay-board",
        env: { feature: { d1_databases: [{ binding: "DB", database_name: "x" }] } },
      }),
    );
    expect(await unprovisionedBindings(dir, "feature")).toEqual([{ worker: "board", kind: "d1", binding: "DB" }]);
    const failure = (await assertEnvironmentProvisioned(dir, "feature").catch((error: unknown) => error)) as PithyError;
    expect(failure.payload.action).toContain("pithy provision --feature");
  });

  test("the refusal says what wrangler would do now, which is fail rather than create", async () => {
    await worker("board", {
      name: "replay-board",
      env: { staging: { d1_databases: [{ binding: "DB", database_name: "replay-staging-db" }] } },
    });
    const failure = (await assertEnvironmentProvisioned(dir, "staging").catch((error: unknown) => error)) as PithyError;
    // The old detail said wrangler "validates a binding's id before it deploys". Under its default it
    // created the database instead — which is #589.
    expect(failure.payload.detail).not.toContain("validates");
    expect(failure.payload.detail).toContain("--experimental-provision=false");
  });
});
