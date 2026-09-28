// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { defineSeed, type SeedPrepareContext } from "@pithy-sh/core/src/seed/seed";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { afterEach, describe, expect, test } from "vitest";
import type { WorkerScope } from "../migrations/run";
import { featureConfigPath } from "../provision/featureConfig";
import { mintedThisRun } from "../provision/mintedThisRun";
import { seedProject } from "./run";

/**
 * **A prepared set may use what this run just minted — #660.**
 *
 * `pithy provision` creates a random value for every `cf-secrets-store` secret the registry declares
 * mintable, writes it into the account's Secrets Store, and lets it go. Nothing reads an entry back: the
 * store is write-only from the CLI. Provisioning then migrates and seeds **in the same process**, so the
 * stretch between the write and the seed is the only time that value is reachable — and a fixture that
 * has to seal something at creation time can only do it there.
 *
 * What this file holds is the boundary: what a set is handed, and what it is still refused. `context.secret`
 * answers *what the environment holds* and refuses outside `dev`, absolutely (#159). `context.mintedThisRun`
 * answers the strictly narrower *did this run create one, a moment ago, in memory* — and answers
 * `undefined` for everything else, in every environment.
 *
 * Project `replay`, Worker `board`, deliberately unequal, and nothing here reaches Cloudflare.
 */

const PROJECT = "replay";
const SCRIPT = "replay-f660-minted--board";
/** A value with no substring anything else in a report could produce, so "it never appears" is checkable. */
const MINTED = "minted-value-zzq7f3b1c5e9a2d4";

/** One mintable `cf-secrets-store` secret, and one the registry declares but nothing may mint. */
const REGISTRY = defineSecretRegistry({
  "connection-key": {
    backend: "cf-secrets-store",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    devValue: "random",
  },
  "connection-partner-token": {
    backend: "cf-secrets-store",
    scope: "environment",
    rotatable: false,
    valueType: "text",
  },
});

/** What one prepared set saw of the run it was given. */
interface Seen {
  /** The value the run said it minted for `connection-key`. */
  minted: string | undefined;
  /** The value it said it minted for a secret no run mints. */
  unminted: string | undefined;
  /** What asking the *environment* for the same name did — the #159 boundary, from the other side. */
  environment: string | PithyError;
}

/** A capability whose one set records what the run offered it, and writes nothing. */
function capturing(seen: Seen[]): Capability {
  return defineCapability({
    name: "app",
    requiredBindings: [],
    secretRegistry: REGISTRY,
    seeds: [
      defineSeed({
        name: "records",
        order: 1000,
        environments: ["dev", "feature"],
        prepare: async (context: SeedPrepareContext) => {
          const environment = await context
            .secret("connection-key")
            .then((value) => value ?? "")
            .catch((error: unknown) => error as PithyError);
          seen.push({
            minted: context.mintedThisRun("connection-key"),
            unminted: context.mintedThisRun("connection-partner-token"),
            environment,
          });
          return {};
        },
      }),
    ],
  });
}

describe("what a run offers a prepared set of the secrets it just minted", () => {
  const made: string[] = [];
  afterEach(async () => {
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /** A project root holding Worker `board`, with the feature stanza provisioning generates for it. */
  async function project() {
    const dir = await mkdtemp(join(tmpdir(), "pithy-minted-seed-"));
    made.push(dir);
    const workerDir = join(dir, "apps", "board");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "wrangler.jsonc"), JSON.stringify({ name: "replay-board" }));
    await mkdir(dirname(featureConfigPath(workerDir)), { recursive: true });
    await writeFile(
      featureConfigPath(workerDir),
      JSON.stringify({ name: "replay-board", env: { feature: { name: SCRIPT } } }),
    );
    return {
      dir,
      worker: (capabilities: Capability[]): WorkerScope => ({ name: "board", dir: workerDir, capabilities }),
    };
  }

  /** Seed the feature environment, with whatever record the caller says this run filled. */
  async function seed(minted?: ReturnType<typeof mintedThisRun>): Promise<{ seen: Seen[]; report: unknown }> {
    const target = await project();
    const seen: Seen[] = [];
    const report = await seedProject({
      account: null,
      project: PROJECT,
      projectDir: target.dir,
      env: "feature",
      yes: true,
      workers: [target.worker([capturing(seen)])],
      workersSubdomain: async () => "acme",
      ...(minted ? { mintedThisRun: minted } : {}),
    });
    return { seen, report };
  }

  test("**a set is handed the value this run minted for it**", async () => {
    const minted = mintedThisRun();
    minted.record("connection-key", MINTED);

    const { seen } = await seed(minted);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.minted).toBe(MINTED);
  });

  /**
   * **#159 is untouched, and this is the assertion that says so.**
   *
   * The same set, in the same run, asking the *environment* for the very name this run minted. That is a
   * different question — what the environment holds — and it is refused outside `dev` whatever this run
   * created. The rule lives in `devSecretReader`; this holds that the new channel did not route around it.
   */
  test("asking the environment for the same secret is still refused outside dev", async () => {
    const minted = mintedThisRun();
    minted.record("connection-key", MINTED);

    const { seen } = await seed(minted);

    const refusal = seen[0]?.environment;
    expect(refusal).toBeInstanceOf(PithyError);
    expect((refusal as PithyError).payload.message).toContain("connection-key");
    // And nothing about the refusal carries the value it was refusing to reach.
    expect(JSON.stringify((refusal as PithyError).payload)).not.toContain(MINTED);
  });

  /** A name this run did not mint answers `undefined` — never the environment's value, never a guess. */
  test("a secret this run did not mint is undefined, wherever the run is", async () => {
    const minted = mintedThisRun();
    minted.record("connection-key", MINTED);

    const { seen } = await seed(minted);

    expect(seen[0]?.unminted).toBeUndefined();
  });

  /**
   * **A re-run mints nothing, so the channel is empty — and that is not an error.**
   *
   * Every store entry is already there on the second run, absence is checked before anything is
   * generated, and the record stays empty. The same shape as a standalone `pithy seed`, which mints
   * nothing at all: the set is handed `undefined` and decides for itself.
   */
  test("a run that minted nothing offers an empty channel, and nothing throws", async () => {
    const { seen } = await seed(mintedThisRun());

    expect(seen).toHaveLength(1);
    expect(seen[0]?.minted).toBeUndefined();
    expect(seen[0]?.unminted).toBeUndefined();
  });

  /** And a caller that says nothing at all gets the same answer, from the default rather than by luck. */
  test("a caller that offers no record is the empty channel too", async () => {
    const { seen } = await seed();

    expect(seen[0]?.minted).toBeUndefined();
  });

  /**
   * **No value reaches the report, which is what `--json` prints and what an operator reads.**
   *
   * The whole point of minting is that nobody ever sees the value; a run that hands one to a fixture and
   * then prints it has given the secret away to a log.
   */
  test("the value never reaches the report", async () => {
    const minted = mintedThisRun();
    minted.record("connection-key", MINTED);

    const { seen, report } = await seed(minted);

    // Anti-vacuous: the set really did receive it, so its absence below is about the report.
    expect(seen[0]?.minted).toBe(MINTED);
    expect(JSON.stringify(report)).not.toContain(MINTED);
  });
});
