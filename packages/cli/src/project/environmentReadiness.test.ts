// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import {
  environmentOutcomes,
  environmentReadiness,
  formatEnvironmentOutcomes,
  narrowReadiness,
  readyStanza,
  requireReadyEnvironments,
} from "./environmentReadiness";

/**
 * The rule this file holds: **an environment with no app database is skipped and reported, never fatal.**
 *
 * Six capability provisioning commands used to throw on the first such environment, from inside the
 * fan-out, after other environments' resources already existed. A deliberately staging-only bring-up
 * failed part way through naming production (pithy-sh/pithy#512). The decision now happens once, before
 * anything is created, and the tests below are the ones that fail if it moves back.
 */

/** A `wrangler.jsonc` with one env stanza per entry — `null` for a stanza with no `DB` id at all. */
async function project(stanzas: Record<string, string | null>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-readiness-"));
  const env = Object.fromEntries(
    Object.entries(stanzas).map(([name, id]) => [
      name,
      { d1_databases: id === null ? [] : [{ binding: "DB", database_id: id }], vars: { ENVIRONMENT: name } },
    ]),
  );
  await writeFile(join(dir, "wrangler.jsonc"), JSON.stringify({ name: "api", env }, null, 2));
  return dir;
}

/** The operator payload a `PithyError` carries, or a failure naming what was thrown instead. */
async function refusal(work: () => unknown) {
  try {
    await work();
  } catch (error) {
    if (error instanceof PithyError) return error.payload;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("environmentReadiness", () => {
  test("an environment with no DB database_id is skipped, and the ready ones still provision", async () => {
    const dir = await project({ staging: "db-staging", prod: null });

    const readiness = await environmentReadiness({
      workerDir: dir,
      label: "api's wrangler.jsonc",
      environments: ["staging", "prod"],
    });

    expect(readiness.ready).toEqual(["staging"]);
    expect(readiness.skipped).toEqual([
      { env: "prod", reason: "env.prod has no DB database_id.", action: "Run pithy provision --env prod." },
    ]);
    expect(readyStanza(readiness, "staging").appDatabaseId).toBe("db-staging");
  });

  test("a DB binding that is present but has no id skips too — the shape `pithy add` writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pithy-readiness-"));
    await writeFile(
      join(dir, "wrangler.jsonc"),
      JSON.stringify({ env: { staging: { d1_databases: [{ binding: "DB" }] } } }),
    );

    const readiness = await environmentReadiness({
      workerDir: dir,
      label: "wrangler.jsonc",
      environments: ["staging"],
    });

    expect(readiness.ready).toEqual([]);
    expect(readiness.skipped[0]?.env).toBe("staging");
  });

  /**
   * **The empty string is the value a half-written `wrangler.jsonc` actually holds**, and it is the one the
   * six refusals this replaced all rejected (`if (!appDatabaseId)`). A readiness check written as
   * `?? null` reads `""` as an id, calls the environment ready, provisions it, and reports it deployed —
   * inverting the change for exactly the environment it exists to protect.
   */
  test('an empty database_id is unprovisioned, not ready — `""` is what a half-written stanza holds', async () => {
    const dir = await mkdtemp(join(tmpdir(), "pithy-readiness-"));
    await writeFile(
      join(dir, "wrangler.jsonc"),
      JSON.stringify({
        env: {
          staging: { d1_databases: [{ binding: "DB", database_id: "db-staging" }] },
          prod: { d1_databases: [{ binding: "DB", database_id: "" }] },
        },
      }),
    );

    const readiness = await environmentReadiness({
      workerDir: dir,
      label: "api's wrangler.jsonc",
      environments: ["staging", "prod"],
    });

    expect(readiness.ready).toEqual(["staging"]);
    expect(readiness.skipped).toEqual([
      { env: "prod", reason: "env.prod has no DB database_id.", action: "Run pithy provision --env prod." },
    ]);
    // And the stanza is unreachable, so nothing downstream can bind a Worker to the empty string.
    expect(() => readyStanza(readiness, "prod")).toThrow();
  });

  test("the second run, after the skipped environment is provisioned, finds both ready", async () => {
    const dir = await project({ staging: "db-staging", prod: "db-prod" });

    const readiness = await environmentReadiness({
      workerDir: dir,
      label: "wrangler.jsonc",
      environments: ["staging", "prod"],
    });

    expect(readiness.ready).toEqual(["staging", "prod"]);
    expect(readiness.skipped).toEqual([]);
    expect(readyStanza(readiness, "prod").appDatabaseId).toBe("db-prod");
  });

  test("a declared environment with no stanza is still refused — no command moves it out of that state", async () => {
    const dir = await project({ staging: "db-staging" });

    const payload = await refusal(() =>
      environmentReadiness({ workerDir: dir, label: "api's wrangler.jsonc", environments: ["staging", "prod"] }),
    );

    expect(payload.message).toBe("api's wrangler.jsonc has no env.prod stanza.");
    expect(payload.code).toBe("validation/invalid_input");
  });

  test("the stanza comes back whole, so a caller that resolves an address reads no file of its own", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pithy-readiness-"));
    await writeFile(
      join(dir, "wrangler.jsonc"),
      JSON.stringify({
        env: {
          prod: {
            d1_databases: [{ binding: "DB", database_id: "db-prod" }],
            routes: [{ pattern: "api.example.com/*" }],
          },
        },
      }),
    );

    const readiness = await environmentReadiness({ workerDir: dir, label: "w", environments: ["prod"] });

    expect(readyStanza(readiness, "prod").stanza.routes).toEqual([{ pattern: "api.example.com/*" }]);
  });
});

describe("requireReadyEnvironments", () => {
  test("every environment skipped is a non-zero exit naming each one and the command that fixes it", async () => {
    const dir = await project({ staging: null, prod: null });
    const readiness = await environmentReadiness({
      workerDir: dir,
      label: "wrangler.jsonc",
      environments: ["staging", "prod"],
    });

    const payload = await refusal(() => requireReadyEnvironments(readiness, "pithy email provision"));

    expect(payload.message).toBe("No environment is ready — staging and prod have no DB database_id.");
    expect(payload.action).toBe(
      "Run pithy provision --env staging to create its app database, then run pithy email provision again.",
    );
  });

  test("one environment provisioned is a success, whatever else was skipped", async () => {
    const dir = await project({ staging: "db-staging", prod: null });
    const readiness = await environmentReadiness({
      workerDir: dir,
      label: "wrangler.jsonc",
      environments: ["staging", "prod"],
    });

    expect(() => requireReadyEnvironments(readiness, "pithy email provision")).not.toThrow();
  });
});

describe("the report", () => {
  test("names every declared environment, in declaration order, and a skip never reads as a success", async () => {
    const dir = await project({ staging: "db-staging", prod: null });
    const readiness = await environmentReadiness({
      workerDir: dir,
      label: "wrangler.jsonc",
      environments: ["staging", "prod"],
    });

    const report = formatEnvironmentOutcomes(environmentOutcomes(readiness, () => "email worker deployed"));

    expect(report).toBe(
      "  staging  email worker deployed\n" +
        "  prod     skipped — env.prod has no DB database_id. Run pithy provision --env prod.\n",
    );
  });

  test("declaration order holds when the skipped environment comes first", async () => {
    const dir = await project({ staging: null, prod: "db-prod" });
    const readiness = await environmentReadiness({
      workerDir: dir,
      label: "wrangler.jsonc",
      environments: ["staging", "prod"],
    });

    const report = formatEnvironmentOutcomes(environmentOutcomes(readiness, () => "worker deployed"));

    expect(report.split("\n")[0]).toContain("staging  skipped");
    expect(report.split("\n")[1]).toContain("prod     worker deployed");
  });

  test("no environments at all is an empty string, never a stray blank line", () => {
    expect(formatEnvironmentOutcomes([])).toBe("");
  });
});

describe("narrowReadiness", () => {
  test("--env and readiness are two narrowings, and the report keeps both straight", async () => {
    const dir = await project({ staging: "db-staging", prod: null });
    const readiness = await environmentReadiness({
      workerDir: dir,
      label: "wrangler.jsonc",
      environments: ["staging", "prod"],
    });

    // The operator asked for prod alone, and prod has no app database.
    const narrowed = narrowReadiness(readiness, ["prod"]);

    expect(narrowed.declared).toEqual(["prod"]);
    expect(narrowed.ready).toEqual([]);
    expect(narrowed.skipped.map((entry) => entry.env)).toEqual(["prod"]);
    await refusal(() => requireReadyEnvironments(narrowed, "pithy testers provision"));
  });

  test("narrowing to a ready environment keeps its stanza reachable", async () => {
    const dir = await project({ staging: "db-staging", prod: null });
    const readiness = await environmentReadiness({
      workerDir: dir,
      label: "wrangler.jsonc",
      environments: ["staging", "prod"],
    });

    const narrowed = narrowReadiness(readiness, ["staging"]);

    expect(narrowed.ready).toEqual(["staging"]);
    expect(readyStanza(narrowed, "staging").appDatabaseId).toBe("db-staging");
  });
});
