// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { FeatureIdentity } from "@pithy-sh/core/src/naming/feature";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { afterEach, describe, expect, test } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import type { ProvisionWorker } from "../provision/environment";
import type { MintedThisRun } from "../provision/mintedThisRun";
import type { ResourceProvisioner, ResourceProvisioners } from "../provision/resources";
import { provisionFeature } from "./provision";

/**
 * **The wire from the minter to the seed, with the real minter on one end — #660.**
 *
 * `provisionFeature` writes each absent `cf-secrets-store` secret into the account's store and then
 * migrates and seeds in the same process. The store is write-only from the CLI, so the value exists
 * exactly between those two steps and nowhere else, ever. This holds that the seed step is handed it —
 * and that the second run, which creates nothing, is handed nothing.
 *
 * `seed/mintedSeed.test.ts` holds the other end: what `seedProject` does with the record once it has it.
 */

const identity: FeatureIdentity = { project: "acme", issue: "660", slug: "minted" };

/** One `cf-secrets-store` secret a random value satisfies — the kind `storeSecretMinter` creates. */
const REGISTRY = defineSecretRegistry({
  "connection-key": {
    backend: "cf-secrets-store",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    devValue: "random",
  },
});

/** An in-memory provisioner over a name→id map, mirroring the real find/create/delete semantics. */
function fakeKind(kind: string, store: Map<string, string>): ResourceProvisioner {
  let seq = 0;
  return {
    find: async (name: string) => (store.has(name) ? { id: store.get(name) as string } : null),
    create: async (name: string) => {
      seq += 1;
      const id = kind === "r2" ? name : `${kind}-${seq}`;
      store.set(name, id);
      return { id };
    },
    delete: async (id: string) => {
      for (const [name, value] of store) if (value === id) store.delete(name);
    },
  };
}

/** A full fake provisioner set. */
function fakeProvisioners(): ResourceProvisioners {
  return {
    d1: fakeKind("d1", new Map()),
    kv: fakeKind("kv", new Map()),
    r2: fakeKind("r2", new Map()),
  } as ResourceProvisioners;
}

/**
 * An in-memory Secrets Store, with the real create-if-absent semantics a feature's run relies on.
 *
 * `outcome` forces what `create` answers without changing what the store holds, which is how the two
 * cases that are not `created` are reached without a real race: `present` is the window between another
 * run's `exists` and its write, and `unconfirmed` is a create that failed over an entry that is there now.
 */
function fakeStore(outcome?: "present" | "unconfirmed") {
  const entries = new Map<string, string>();
  return {
    entries,
    store: {
      storeId: "store-1",
      exists: async (name: string) => entries.has(name),
      put: async (name: string, value: string) => void entries.set(name, value),
      create: async (name: string, value: string) => {
        if (outcome !== undefined) return outcome;
        if (entries.has(name)) return "present" as const;
        entries.set(name, value);
        return "created" as const;
      },
      remove: async (name: string) => entries.delete(name),
    },
  };
}

describe("what a feature's provisioning hands its own seed step", () => {
  const made: string[] = [];
  afterEach(async () => {
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /** A project root with one Worker declaring the mintable secret above. */
  async function project(): Promise<{ dir: string; workers: ProvisionWorker[] }> {
    const dir = await mkdtemp(join(tmpdir(), "pithy-minted-feature-"));
    made.push(dir);
    const workerDir = join(dir, "apps", "board");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "wrangler.jsonc"), JSON.stringify({ name: "acme-board" }));
    return {
      dir,
      workers: [
        {
          name: "board",
          dir: workerDir,
          // The real `secrets` capability, because that is what makes a Worker's registry a registry:
          // `workerSecretRegistry` answers `null` for a Worker that composes none, and mints nothing.
          capabilities: [defineCapability({ name: "app", requiredBindings: [] }), secrets({ registry: REGISTRY })],
        } as ProvisionWorker,
      ],
    };
  }

  /** Provision once over the given store, capturing what the seed seam was handed. */
  async function provision(
    target: { dir: string; workers: ProvisionWorker[] },
    store: ReturnType<typeof fakeStore>["store"],
  ): Promise<{
    offered: MintedThisRun | undefined;
    audit: CliAuditEvent[];
    report: { secretBindings?: { secret: string; minted: boolean }[] };
  }> {
    let offered: MintedThisRun | undefined;
    const audit: CliAuditEvent[] = [];
    const report = await provisionFeature({
      projectDir: target.dir,
      capabilities: target.workers[0]?.capabilities ?? [],
      identity,
      provisioners: fakeProvisioners(),
      administersItself: false,
      resolveWorkers: async () => target.workers,
      migrate: async () => {},
      seed: async (args) => {
        offered = args.mintedThisRun;
      },
      store,
      audit: async (event) => void audit.push(event),
    });
    return { offered, audit, report: report as { secretBindings?: { secret: string; minted: boolean }[] } };
  }

  test("**the seed step is handed the value this run minted, as the store holds it**", async () => {
    const target = await project();
    const { store, entries } = fakeStore();

    const { offered } = await provision(target, store);

    const value = offered?.get("connection-key");
    expect(typeof value).toBe("string");
    expect(offered?.size).toBe(1);
    // It is the value that was actually written: the entry the Worker reads carries it. Anti-vacuous —
    // an empty string would pass a containment check against anything.
    expect(value).not.toBe("");
    const written = [...entries.values()];
    expect(written).toHaveLength(1);
    expect(written[0]).toContain(value as string);
  });

  test("the entry name is the scope's; the record is keyed by the registry name a set asks by", async () => {
    const target = await project();
    const { store, entries } = fakeStore();

    const { offered } = await provision(target, store);

    // The store entry is scoped to the feature; the record is not, because a prepared set asks for
    // `connection-key` and has no business composing an environment-scoped address.
    expect([...entries.keys()][0]).toContain("f660");
    expect(offered?.get("connection-key")).toBeDefined();
    expect(offered?.get([...entries.keys()][0] as string)).toBeUndefined();
  });

  /**
   * **A re-run creates nothing, so it offers nothing.** Absence is checked before anything is generated,
   * so the second run never mints — and an empty channel is the correct answer, not a failure.
   */
  test("a second run over the same store offers an empty channel", async () => {
    const target = await project();
    const { store } = fakeStore();

    const first = await provision(target, store);
    const second = await provision(target, store);

    expect(first.offered?.size).toBe(1);
    expect(second.offered?.size).toBe(0);
    expect(second.offered?.get("connection-key")).toBeUndefined();
  });

  /**
   * **A record of what the store did not take is worse than no record at all — #660 review.**
   *
   * `create` answers `created`, `present` or `unconfirmed`, and only the first means this run's value is
   * the one the Worker will read. `present` is the window between another run's `exists` and its write;
   * `unconfirmed` is a create that failed over an entry that is there now. In both, the entry holds
   * somebody else's value — and a set that seals a row under this run's discarded one writes a row
   * nothing can ever open, on a run that exits 0 saying it minted.
   */
  test.each([["present"], ["unconfirmed"]] as const)("**a store that answers %s records nothing**", async (outcome) => {
    const target = await project();
    const { store } = fakeStore(outcome);

    const { offered } = await provision(target, store);

    expect(offered?.size).toBe(0);
    expect(offered?.get("connection-key")).toBeUndefined();
  });

  /** And the report does not claim it either: `minted` is what this run created, not what it attempted. */
  test.each(["present", "unconfirmed"] as const)("a store that answers %s reports nothing minted", async (outcome) => {
    const target = await project();
    const { store } = fakeStore(outcome);

    const { report } = await provision(target, store);

    expect(report.secretBindings?.filter((binding) => binding.minted)).toEqual([]);
  });

  /** The trail records that a secret was created, by name and environment. Never what it is. */
  test("no audit event carries the value", async () => {
    const target = await project();
    const { store } = fakeStore();

    const { offered, audit } = await provision(target, store);

    const value = offered?.get("connection-key") as string;
    expect(value).toBeTruthy();
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(value);
  });
});
