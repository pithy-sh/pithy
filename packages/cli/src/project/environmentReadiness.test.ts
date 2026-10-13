// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandPath, callerOf, rerunRemedy, workerDirOf } from "@pithy-sh/core/src/cli/command";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, describe, expect, test, vi } from "vitest";
import { EXIT, fixOf } from "../terminal/exitClass";
import {
  environmentOutcomes,
  environmentReadiness,
  formatEnvironmentOutcomes,
  narrowReadiness,
  readyStanza,
  requireReadyEnvironments,
  writeProvisionReport,
} from "./environmentReadiness";

/**
 * The rule this file holds: **an environment with no app database is skipped and reported, never fatal.**
 *
 * Six capability provisioning commands used to throw on the first such environment, from inside the
 * fan-out, after other environments' resources already existed. A deliberately staging-only bring-up
 * failed part way through naming production (pithy-sh/pithy#512). The decision now happens once, before
 * anything is created, and the tests below are the ones that fail if it moves back.
 */

/** The caller's run again, on the Worker `api`, as each provision command builds it. */
function again(path: CommandPath, given: Readonly<Record<string, unknown>> = {}) {
  return rerunRemedy(callerOf(path, given), { flags: { "--worker": workerDirOf({ dir: "apps/api" }) } });
}

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
  const error = await thrown(work);
  return error.payload;
}

/** The `PithyError` a thunk raised, for a test that reads what rides beside the payload too. */
async function thrown(work: () => unknown): Promise<PithyError> {
  try {
    await work();
  } catch (error) {
    if (error instanceof PithyError) return error;
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
      {
        env: "prod",
        reason: "env.prod has no DB database_id.",
        action:
          "`pithy provision --env prod --yes` with its --confirm phrase, which only a person gives, runs against prod, a production environment. That is a person's decision, not a fix.",
      },
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
      {
        env: "prod",
        reason: "env.prod has no DB database_id.",
        action:
          "`pithy provision --env prod --yes` with its --confirm phrase, which only a person gives, runs against prod, a production environment. That is a person's decision, not a fix.",
      },
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

    const error = await thrown(() => requireReadyEnvironments(readiness, again("email provision")));
    const payload = error.payload;

    expect(payload.message).toBe("No environment is ready — staging and prod have no DB database_id.");
    expect(payload.action).toBe(
      "Run pithy provision --env staging --yes to create its app database. `pithy provision --env prod --yes` with its --confirm phrase, which only a person gives, runs against prod, a production environment. That is a person's decision, not a fix. Once their app databases exist, run `pithy email provision --worker api` again.",
    );
    // The call was right and the account is not ready: exit 3, and the command that readies the first (#697).
    expect(payload.code).toBe("core/precondition_failed");
    expect(fixOf(error)).toBe("pithy provision --env staging --yes");
  });

  // Provisioning production needs the `--confirm` phrase too, a person's to give, so `--yes` alone would
  // end exit 5. A `fix` is runnable as written; production gets none (#697).
  test.each([
    ["prod", undefined],
    ["live", ["live"]],
  ])("a first skipped environment that is production, %s, carries no fix", async (env, productionEnvironments) => {
    const dir = await project({ [env]: null });
    const readiness = await environmentReadiness({
      workerDir: dir,
      label: "wrangler.jsonc",
      environments: [env],
      ...(productionEnvironments ? { productionEnvironments } : {}),
    });

    const error = await thrown(() => requireReadyEnvironments(readiness, again("email provision")));
    expect(error.payload.code).toBe("core/precondition_failed");
    expect(fixOf(error)).toBeUndefined();
    // …and the sentence does not hand an agent the bare command it would be refused (#711): it names the
    // phrase as a person's, in the skip reason and in the refusal alike.
    const step = `\`pithy provision --env ${env} --yes\` with its --confirm phrase, which only a person gives, runs against ${env}, a production environment. That is a person's decision, not a fix.`;
    expect(error.payload.action).toBe(
      `${step} Once its app database exists, run \`pithy email provision --worker api\` again.`,
    );
    expect(readiness.skipped[0]?.action).toBe(step);
  });

  // A remedy names every environment the fault applies to (#711): an agent that provisioned only the first ran the
  // command again with the rest still skipped, and was never told to provision them.
  test("several skipped environments are each named in the action, and no one command is the fix", async () => {
    const dir = await project({ staging: null, live: null });
    const readiness = await environmentReadiness({
      workerDir: dir,
      label: "wrangler.jsonc",
      environments: ["staging", "live"],
    });

    const error = await thrown(() => requireReadyEnvironments(readiness, again("email provision", { json: true })));
    expect(error.payload.action).toBe(
      "Run pithy provision --env staging --yes and pithy provision --env live --yes to create their app databases, then run `pithy email provision --json --worker api` again.",
    );
    expect(fixOf(error)).toBeUndefined();
  });

  // Staging is an agent's to provision and production a person's: the one command an agent can run is the fix,
  // and the action still names both.
  test("the one provision an agent can run is the fix, beside a production one a person decides", async () => {
    const dir = await project({ staging: null, prod: null });
    const readiness = await environmentReadiness({
      workerDir: dir,
      label: "wrangler.jsonc",
      environments: ["staging", "prod"],
    });

    const error = await thrown(() => requireReadyEnvironments(readiness, again("email provision")));
    expect(error.payload.action).toContain("pithy provision --env staging --yes");
    expect(error.payload.action).toContain("`pithy provision --env prod --yes` with its --confirm phrase");
    expect(fixOf(error)).toBe("pithy provision --env staging --yes");
  });

  // `pithy testers provision --env prod`: running it again is itself a production run, a person's decision.
  test("a run again that is a person's decision is said as one", async () => {
    const dir = await project({ prod: null });
    const readiness = await environmentReadiness({ workerDir: dir, label: "wrangler.jsonc", environments: ["prod"] });

    const error = await thrown(() => requireReadyEnvironments(readiness, again("testers provision", { env: "prod" })));
    expect(error.payload.action).toBe(
      "`pithy provision --env prod --yes` with its --confirm phrase, which only a person gives, runs against prod, a production environment. That is a person's decision, not a fix. Once its app database exists, this run is next: `pithy testers provision --env prod --worker api` runs against prod, a production environment. That is a person's decision, not a fix.",
    );
    expect(fixOf(error)).toBeUndefined();
  });

  test("one environment provisioned is a success, whatever else was skipped", async () => {
    const dir = await project({ staging: "db-staging", prod: null });
    const readiness = await environmentReadiness({
      workerDir: dir,
      label: "wrangler.jsonc",
      environments: ["staging", "prod"],
    });

    expect(() => requireReadyEnvironments(readiness, again("email provision"))).not.toThrow();
  });
});

/**
 * **One outcome per `provision --json` run (#711).** A refusal is the error line alone, with its exit and `fix`.
 * A run that went ahead is its report alone, and the report's `exitCode` is what the process exits with.
 */
describe("writeProvisionReport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Everything the helper writes to stdout, in order. */
  function captureStdout(): string[] {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    return writes;
  }

  test("a run in which every environment skipped writes nothing, and refuses with the fix", async () => {
    const dir = await project({ staging: null, prod: null });
    const readiness = await environmentReadiness({
      workerDir: dir,
      label: "wrangler.jsonc",
      environments: ["staging", "prod"],
    });
    const writes = captureStdout();

    const error = await thrown(() =>
      writeProvisionReport({ command: "media provision" }, readiness, again("media provision")),
    );

    expect(writes).toEqual([]);
    expect(error.payload.code).toBe("core/precondition_failed");
    expect(fixOf(error)).toBe("pithy provision --env staging --yes");
    expect(error.payload.action).toBe(
      "Run pithy provision --env staging --yes to create its app database. `pithy provision --env prod --yes` with its --confirm phrase, which only a person gives, runs against prod, a production environment. That is a person's decision, not a fix. Once their app databases exist, run `pithy media provision --worker api` again.",
    );
  });

  test("a run that went ahead writes its report alone, as one line, with exitCode 0", async () => {
    const dir = await project({ staging: "db-staging", prod: null });
    const readiness = await environmentReadiness({
      workerDir: dir,
      label: "wrangler.jsonc",
      environments: ["staging", "prod"],
    });
    const writes = captureStdout();

    writeProvisionReport(
      { command: "media provision", skippedEnvironments: readiness.skipped },
      readiness,
      again("media provision"),
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]?.endsWith("\n")).toBe(true);
    expect(writes[0]?.trimEnd()).not.toContain("\n");
    const report = JSON.parse(writes[0] ?? "") as { command: string; exitCode: number; skippedEnvironments: unknown[] };
    expect(report.command).toBe("media provision");
    expect(report.exitCode).toBe(EXIT.ok);
    expect(report.skippedEnvironments).toHaveLength(1);
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
        "  prod     skipped — env.prod has no DB database_id. `pithy provision --env prod --yes` with its --confirm phrase, which only a person gives, runs against prod, a production environment. That is a person's decision, not a fix.\n",
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
    await refusal(() => requireReadyEnvironments(narrowed, again("testers provision", { env: "prod" })));
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
