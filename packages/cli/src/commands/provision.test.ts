// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { DeclaredEnvironments, FEATURE_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { requireManagedEnvironment } from "../project/environment";
import { runProvision } from "./provision";

/**
 * **The gate for #251's other half: exactly one of `--env` and `--feature`, refused at the flag.**
 *
 * The invariant is one sentence — **a provisioning run that named no environment, or two, is refused
 * before anything is read or built.** Not "before a Cloudflare client", which is a list of one forbidden
 * thing and would still pass if the refusal moved after the config load: it is stated against the
 * *earliest* observable step instead. Every case below runs against a directory that is not a Pithy
 * project at all, so any check that ran first would answer with `No pithy.config.ts here.` — and a
 * refusal that arrives after the project has been loaded, an account resolved, or a token read is a
 * refusal that arrived too late.
 *
 * `projectDir` is a seam for exactly that reason. The command uses the working directory; a test that had
 * to `chdir` could not make this assertion without racing every other suite in the pool.
 */

describe("pithy provision names exactly one environment", () => {
  let notAProject: string;

  beforeEach(async () => {
    notAProject = await mkdtemp(join(tmpdir(), "pithy-no-project-"));
  });
  afterEach(async () => {
    await rm(notAProject, { recursive: true, force: true });
  });

  /** The flags every case shares — the ones that are not the mode. */
  const rest = { yes: true, seed: false, json: true } as const;

  /** Run `act` and hand back whatever it threw, so a test asserts on the payload rather than the message. */
  function thrown(act: () => unknown): unknown {
    try {
      act();
      return undefined;
    } catch (error) {
      return error;
    }
  }

  /** Run the command and hand back whatever it threw, so the payload is what a test asserts on. */
  async function refusal(flags: { env?: string; feature: boolean }): Promise<PithyError> {
    const error = await runProvision({ projectDir: notAProject, ...rest, ...flags }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PithyError);
    return error as PithyError;
  }

  test("both flags is refused, before the project is even looked for", async () => {
    const error = await refusal({ env: "staging", feature: true });
    expect(error.payload.message).toMatch(/either --env or --feature, not both/i);
    expect(error.payload.message).not.toMatch(/pithy\.config/i);
  });

  /**
   * **`--feature` is the declaration, never an inference from the branch.** The fixture is a bare temp
   * directory with no git repository in it, so a mode that consulted the branch would have to answer with
   * whatever git said about a directory that is not a checkout. It answers about the flags instead,
   * because that is the only input the mode has.
   */
  test("neither flag is refused, and the refusal names both spellings", async () => {
    const error = await refusal({ feature: false });
    expect(error.payload.message).toMatch(/needs an environment/i);
    expect(error.payload.action).toMatch(/--env/);
    expect(error.payload.action).toMatch(/--feature/);
    expect(error.payload.message).not.toMatch(/pithy\.config/i);
  });

  /**
   * **`--env` cannot reach a branch's environment, and it is closed rather than checked.** `--env` admits
   * exactly what the project declared, and no project can declare this name: `feature` is a legal wrangler
   * stanza key and an illegal declaration, because a declared environment's ids are committed and a
   * feature's are generated. Both halves are asserted, since either alone leaves the door ajar.
   *
   * The other direction is `featureScope`'s, whose stanza is that one name and nothing else — pinned in
   * core's `provisionScope.test.ts`.
   */
  test("`--env feature` is not a way to reach a branch's environment", () => {
    expect(DeclaredEnvironments.safeParse([FEATURE_ENVIRONMENT]).success).toBe(false);
    const error = thrown(() => requireManagedEnvironment(FEATURE_ENVIRONMENT, ["staging", "prod"]));
    expect(error).toBeInstanceOf(PithyError);
    // And it names the flag rather than telling someone to declare what cannot be declared.
    expect((error as PithyError).payload.action).toMatch(/--feature/);
  });
});
