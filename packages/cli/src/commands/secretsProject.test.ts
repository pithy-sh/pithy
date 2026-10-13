// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { WorkerConfig } from "../project/config";
import type { ResolvedWorker } from "../project/workerScope";
import { EXIT, exitCodeOf, fixOf } from "../terminal/exitClass";
import { linkKitPackages } from "../test-utils/linkKit";
import { mergedProjectSecrets } from "./secrets";

/**
 * **A project where no Worker composes `secrets` names the `pithy add` that composes it, runnable as written
 * (#697).** One Worker's config cannot say which Worker to wire, so the refusal leaves it to the project: the
 * only Worker needs no `--worker`, and several leave no single Worker to name, so no `fix` at all. No `pithy
 * secrets` subcommand takes `--worker`, so neither the action nor the fix ever offers one for this command.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-secrets-project-"));
  await linkKitPackages(dir, ["secrets"]);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Workers composing nothing, resolved as `resolveWorkers` would hand them over. */
function bare(...names: string[]) {
  return async (): Promise<ResolvedWorker[]> =>
    names.map((name) => ({
      name: `demo-${name}`,
      dir: join(dir, "apps", name),
      config: { capabilities: [] } as unknown as WorkerConfig,
      capabilities: [],
      target: { name: `demo-${name}`, dir: join(dir, "apps", name) } as ResolvedWorker["target"],
    }));
}

async function refusal(resolve: () => Promise<ResolvedWorker[]>): Promise<PithyError> {
  const error = await mergedProjectSecrets(dir, resolve).catch((caught: unknown) => caught);
  if (!(error instanceof PithyError)) throw new Error("mergedProjectSecrets resolved where a refusal was expected");
  return error;
}

describe("mergedProjectSecrets with no Worker composing secrets", () => {
  test("the only Worker: exit 3, and pithy add secrets", async () => {
    const error = await refusal(bare("api"));
    expect(exitCodeOf(error.payload)).toBe(EXIT.precondition);
    expect(fixOf(error)).toBe("pithy add secrets --worker api");
    // The sentence names the command the fix carries, from one builder (#711).
    expect(error.payload.action).toContain(`run \`${fixOf(error)}\``);
  });

  test("several Workers: still exit 3, and no Worker to name, so no fix", async () => {
    const error = await refusal(bare("api", "web"));
    expect(exitCodeOf(error.payload)).toBe(EXIT.precondition);
    expect(fixOf(error)).toBeUndefined();
    // The sentence still names what to run: one command per Worker, each runnable as written (#711).
    expect(error.payload.action).toContain(
      "(run `pithy add secrets --worker api` or `pithy add secrets --worker web`).",
    );
  });
});
