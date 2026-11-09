// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ResolvedWorker } from "../project/workerScope";
import {
  ownedVaultBinding,
  ownedVaultOf,
  projectOwnedVaults,
  secretsManagerOwner,
  secretsOwnerOf,
} from "./secretsOwner";

function worker(name: string, capabilities: Capability[], ownBindings: string[] = []): ResolvedWorker {
  const dir = `/proj/apps/${name}`;
  return { name, dir, config: {} as never, capabilities, target: { name, dir, ownBindings } };
}

const composed = secrets({ registry: {} });

describe("secretsOwnerOf", () => {
  test("a Worker owning SECRETS writes through its own manager", () => {
    expect(secretsOwnerOf(worker("two", [composed], ["SECRETS"]))).toBe("two");
  });

  test("a Worker owning only DB still shares the manager, which binds SECRETS alone", () => {
    expect(secretsOwnerOf(worker("two", [composed], ["DB"]))).toBeUndefined();
    expect(secretsOwnerOf(worker("one", [composed]))).toBeUndefined();
  });
});

describe("secretsManagerOwner", () => {
  test("no --worker is the shared manager, and resolves no Worker", async () => {
    const resolve = async () => {
      throw new Error("resolved a Worker");
    };
    expect(await secretsManagerOwner("/proj", undefined, resolve)).toBeUndefined();
  });

  test("--worker names the owner when it owns SECRETS, and the shared manager otherwise", async () => {
    const workers = { one: worker("one", [composed]), two: worker("two", [composed], ["SECRETS"]) };
    const resolve = async ({ worker: name }: { worker?: string }) => [workers[name as "one" | "two"]];
    expect(await secretsManagerOwner("/proj", "two", resolve)).toBe("two");
    expect(await secretsManagerOwner("/proj", "one", resolve)).toBeUndefined();
  });

  test("a Worker that does not compose secrets is refused", async () => {
    const resolve = async () => [worker("web", [])];
    const failure = await secretsManagerOwner("/proj", "web", resolve).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.message).toBe("web does not compose secrets.");
  });
});

/**
 * **What the shared manager binds for each owned vault.** The binding is the name its `OWNED_VAULTS` lists and its
 * at-rest rotation reads, so a stanza that names no real vault is no vault at all: binding a placeholder would deploy
 * a manager that cannot open the database it counts.
 */
describe("ownedVaultOf", () => {
  test("a stanza naming the owner's SECRETS database is the vault, bound as VAULT_<OWNER>", () => {
    const stanza = {
      d1_databases: [{ binding: "SECRETS", database_name: "acme-prod-two---secrets", database_id: "v-2" }],
    };
    expect(ownedVaultOf("two", stanza)).toEqual({
      binding: "VAULT_TWO",
      databaseName: "acme-prod-two---secrets",
      databaseId: "v-2",
    });
    expect(ownedVaultBinding("marketing-frontend")).toBe("VAULT_MARKETING_FRONTEND");
  });

  test("a placeholder, a <…> id, an empty one or no SECRETS entry is no vault yet", () => {
    for (const database_id of ["<filled-at-provision>", "placeholder-id", "  "]) {
      expect(ownedVaultOf("two", { d1_databases: [{ binding: "SECRETS", database_id }] })).toBeUndefined();
    }
    expect(ownedVaultOf("two", { d1_databases: [{ binding: "DB", database_id: "db-2" }] })).toBeUndefined();
    expect(ownedVaultOf("two", undefined)).toBeUndefined();
  });
});

describe("projectOwnedVaults", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-owned-vaults-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function at(name: string, ownBindings: string[], databaseId?: string): Promise<ResolvedWorker> {
    const workerDir = join(dir, name);
    await mkdir(workerDir);
    const stanza = databaseId === undefined ? {} : { d1_databases: [{ binding: "SECRETS", database_id: databaseId }] };
    await writeFile(join(workerDir, "wrangler.jsonc"), JSON.stringify({ env: { prod: stanza } }));
    return {
      name,
      dir: workerDir,
      config: {} as never,
      capabilities: [composed],
      target: { name, dir: workerDir, ownBindings },
    };
  }

  test("every Worker that owns SECRETS and names a vault in the environment, and no other", async () => {
    const workers = [
      await at("one", []),
      await at("two", ["SECRETS"], "v-2"),
      await at("three", ["SECRETS"]),
      await at("four", ["DB"], "v-4"),
    ];
    expect(await projectOwnedVaults(workers, "prod")).toEqual([
      { binding: "VAULT_TWO", databaseName: "VAULT_TWO", databaseId: "v-2" },
    ]);
  });
});
