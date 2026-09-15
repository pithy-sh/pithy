// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { composeFor, composeForSync } from "./composeFor";

/** Resolve on a later turn, so a composition really does span an `await`. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe("composeFor", () => {
  let before: string | undefined;
  beforeEach(() => {
    before = process.env.ENVIRONMENT;
    delete process.env.ENVIRONMENT;
  });
  afterEach(() => {
    if (before === undefined) delete process.env.ENVIRONMENT;
    else process.env.ENVIRONMENT = before;
  });

  test("stamps ENVIRONMENT for the composition, and removes a variable the process never had", async () => {
    const seen = await composeFor("staging", async () => {
      await tick();
      return process.env.ENVIRONMENT;
    });
    expect(seen).toBe("staging");
    expect(Object.hasOwn(process.env, "ENVIRONMENT")).toBe(false);
  });

  test("restores the value it found, when the composition throws too", async () => {
    process.env.ENVIRONMENT = "dev";
    await expect(
      composeFor("prod", async () => {
        throw new Error("the config refused prod");
      }),
    ).rejects.toThrow("the config refused prod");
    expect(process.env.ENVIRONMENT).toBe("dev");
  });

  test("two compositions never overlap, so neither sees the other's stamp or restores it out of order", async () => {
    const seen: string[] = [];
    const take = (environment: string) =>
      composeFor(environment, async () => {
        seen.push(`${environment}:${process.env.ENVIRONMENT}`);
        await tick();
        seen.push(`${environment}:${process.env.ENVIRONMENT}`);
      });
    await Promise.all([take("staging"), take("prod")]);
    expect(seen).toEqual(["staging:staging", "staging:staging", "prod:prod", "prod:prod"]);
    expect(Object.hasOwn(process.env, "ENVIRONMENT")).toBe(false);
  });

  test("a composition nested in one for the same environment runs in place rather than waiting on itself", async () => {
    const seen = await composeFor("staging", () => composeFor("staging", async () => process.env.ENVIRONMENT));
    expect(seen).toBe("staging");
  });

  test("a composition nested in one for another environment is refused", async () => {
    const nested = composeFor("staging", () => composeFor("prod", async () => "unreachable"));
    await expect(nested).rejects.toBeInstanceOf(PithyError);
    expect(Object.hasOwn(process.env, "ENVIRONMENT")).toBe(false);
  });

  test("the synchronous half stamps and restores around a registration-time read", () => {
    process.env.ENVIRONMENT = "staging";
    expect(composeForSync("dev", () => process.env.ENVIRONMENT)).toBe("dev");
    expect(process.env.ENVIRONMENT).toBe("staging");
    expect(() => composeForSync("prod", () => composeForSync("dev", () => 0))).toThrow(PithyError);
    expect(process.env.ENVIRONMENT).toBe("staging");
  });

  describe("the loader it hands out", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "pithy-compose-for-"));
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "pithy.config.ts"),
        'export default { capabilities: [{ name: "for-" + (process.env.ENVIRONMENT ?? "none"), requiredBindings: [] }] };\n',
      );
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const nameIn = (environment: string) =>
      composeFor(environment, async (load) => (await load(dir)).capabilities[0]?.name);

    test("evaluates a config for each environment it is asked for, in one process", async () => {
      expect(await nameIn("staging")).toBe("for-staging");
      expect(await nameIn("prod")).toBe("for-prod");
      // And the cached evaluation is still staging's, so asking for staging again reads it back.
      expect(await nameIn("staging")).toBe("for-staging");
    });
  });
});
