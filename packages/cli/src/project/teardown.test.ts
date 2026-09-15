// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { DEFAULT_ENVIRONMENTS } from "@pithy-sh/core/src/naming/environment";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { describe, expect, test } from "vitest";
import { confineTeardown } from "./teardown";

/**
 * A deprovisioner shaped like the CLI's: `#private` state, methods reading it. What the confined copy calls must
 * reach the original, `this` intact, or every real deprovisioner would throw on its first field read.
 */
class Recorder {
  readonly #running: ReadonlySet<string>;
  readonly calls: string[] = [];

  constructor(running: readonly string[]) {
    this.#running = new Set(running);
  }

  async hasWorker(env: ManagedEnvironment): Promise<boolean> {
    return this.#running.has(env);
  }

  async deleteWorker(env: ManagedEnvironment): Promise<void> {
    this.calls.push(`deleteWorker:${env}`);
  }

  async deleteBucket(): Promise<void> {
    this.calls.push("deleteBucket");
  }

  async deleteToken(): Promise<void> {
    this.calls.push("deleteToken");
  }
}

const BUCKET = { what: "the support bucket", flag: "--storage" };

/** The refusal a call made, as its payload. */
async function refusal(run: () => Promise<unknown>): Promise<PithyError["payload"]> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(PithyError);
    return (error as PithyError).payload;
  }
  return expect.unreachable("expected a refusal");
}

describe("confineTeardown", () => {
  // #591 under version skew: an installed orchestrator older than the shared check removes first and refuses after.
  // The CLI asks before handing it anything, so there is no deprovisioner to remove with.
  test("refuses a shared part while another environment runs, before anything can be called", async () => {
    const recorder = new Recorder(["prod"]);
    const payload = await refusal(() =>
      confineTeardown({
        kit: "@pithy-sh/support",
        target: "staging",
        declared: DEFAULT_ENVIRONMENTS,
        runs: (env) => recorder.hasWorker(env),
        deprovisioner: recorder,
        rules: { hasWorker: "read", deleteWorker: "environment", deleteBucket: BUCKET, deleteToken: "refused" },
      }),
    );
    expect(payload.message).toBe(
      "The support bucket is shared by every environment, and prod still runs. Nothing was deleted.",
    );
    expect(payload.action).toBe("Deprovision prod first, or drop --storage.");
    expect(recorder.calls).toEqual([]);
  });

  test("lets the shared part go with the last environment", async () => {
    const recorder = new Recorder(["prod"]);
    const confined = await confineTeardown({
      kit: "@pithy-sh/support",
      target: "prod",
      declared: DEFAULT_ENVIRONMENTS,
      runs: (env) => recorder.hasWorker(env),
      deprovisioner: recorder,
      rules: { hasWorker: "read", deleteWorker: "environment", deleteBucket: BUCKET, deleteToken: "refused" },
    });
    await confined.deleteWorker("prod");
    await confined.deleteBucket();
    expect(recorder.calls).toEqual(["deleteWorker:prod", "deleteBucket"]);
  });

  // The walk every installed orchestrator did before #591: every declared environment, in order.
  test("refuses a per-environment delete naming any environment but the target, and does not make it", async () => {
    const recorder = new Recorder([]);
    const confined = await confineTeardown({
      kit: "@pithy-sh/storage",
      target: "staging",
      declared: DEFAULT_ENVIRONMENTS,
      deprovisioner: recorder,
      rules: { hasWorker: "read", deleteWorker: "environment", deleteBucket: "refused", deleteToken: "refused" },
    });
    await confined.deleteWorker("staging");
    const payload = await refusal(() => confined.deleteWorker("prod"));
    expect(payload.message).toBe(
      '@pithy-sh/storage asked for deleteWorker("prod") while tearing down staging. Refused.',
    );
    expect(payload.action).toBe("Update @pithy-sh/storage to match this CLI, then run it again.");
    expect(recorder.calls).toEqual(["deleteWorker:staging"]);
  });

  test("refuses a delete the operator did not ask for", async () => {
    const recorder = new Recorder([]);
    const confined = await confineTeardown({
      kit: "@pithy-sh/support",
      target: "prod",
      declared: DEFAULT_ENVIRONMENTS,
      deprovisioner: recorder,
      rules: { hasWorker: "read", deleteWorker: "environment", deleteBucket: "refused", deleteToken: "refused" },
    });
    const payload = await refusal(() => confined.deleteBucket());
    expect(payload.message).toBe("@pithy-sh/support asked for deleteBucket() while tearing down prod. Refused.");
    expect(recorder.calls).toEqual([]);
  });

  // A re-mintable credential is kept, not refused: the run goes on, the credential stays.
  test("keeps a last-only part while another environment runs, and removes it when none does", async () => {
    const kept = new Recorder(["prod"]);
    const whileRunning = await confineTeardown({
      kit: "@pithy-sh/secrets",
      target: "staging",
      declared: DEFAULT_ENVIRONMENTS,
      runs: (env) => kept.hasWorker(env),
      deprovisioner: kept,
      rules: { hasWorker: "read", deleteWorker: "environment", deleteBucket: "refused", deleteToken: "last" },
    });
    await whileRunning.deleteToken();
    expect(kept.calls).toEqual([]);

    const removed = new Recorder([]);
    const atLast = await confineTeardown({
      kit: "@pithy-sh/secrets",
      target: "prod",
      declared: DEFAULT_ENVIRONMENTS,
      runs: (env) => removed.hasWorker(env),
      deprovisioner: removed,
      rules: { hasWorker: "read", deleteWorker: "environment", deleteBucket: "refused", deleteToken: "last" },
    });
    await atLast.deleteToken();
    expect(removed.calls).toEqual(["deleteToken"]);
  });

  test("a read reaches the original for any environment, private state and all", async () => {
    const recorder = new Recorder(["prod"]);
    const confined = await confineTeardown({
      kit: "@pithy-sh/email",
      target: "staging",
      declared: DEFAULT_ENVIRONMENTS,
      deprovisioner: recorder,
      rules: { hasWorker: "read", deleteWorker: "environment", deleteBucket: "refused", deleteToken: "refused" },
    });
    expect(await confined.hasWorker("prod")).toBe(true);
    expect(await confined.hasWorker("staging")).toBe(false);
  });

  // A shared rule with no way to ask whether another environment runs would have to guess. It refuses instead.
  test("refuses a shared rule it has no `runs` to check", async () => {
    const recorder = new Recorder([]);
    const payload = await refusal(() =>
      confineTeardown({
        kit: "@pithy-sh/support",
        target: "prod",
        declared: DEFAULT_ENVIRONMENTS,
        deprovisioner: recorder,
        rules: { hasWorker: "read", deleteWorker: "environment", deleteBucket: BUCKET, deleteToken: "refused" },
      }),
    );
    expect(payload.code).toBe("core/internal");
  });
});
