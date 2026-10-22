// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { FieldKeyReport } from "@pithy-sh/secrets/src/rotation/fieldKeyRotation";
import { describe, expect, test } from "vitest";
import secrets from "../commands/secrets";
import { type RetireVersionDeps, retirePhrase, runRetireVersion } from "./retireFieldKey";

const guard: FieldKeyReport = {
  outcome: "guard",
  liveVersions: [3, 2, 1],
  retired: [],
  verdict: { blocked: true, reasons: ["stale", "unrotatable", "incomplete-coverage"], liveVersions: 3 },
  columns: [
    { table: "patients", column: "diagnosis", path: "diagnosis", stale: 4 },
    { table: "patients", column: "email", path: "email", stale: 0 },
    { table: "visits", column: "notes", path: "notes", stale: null },
  ],
  unrotatable: ["app:cache.tokens:value.token"],
  unread: ["apps/billing"],
};

function harness(answer: string | null) {
  const calls: string[] = [];
  const lines: string[] = [];
  const deps: RetireVersionDeps = {
    guard: async () => {
      calls.push("guard");
      return guard;
    },
    retire: async (version) => {
      calls.push(`retire ${version}`);
      return { ...guard, outcome: "retired", retired: [version], liveVersions: [3, 2] };
    },
    ask: async (question) => {
      calls.push(`ask ${question}`);
      return answer;
    },
    write: (line) => void lines.push(line),
  };
  return { deps, calls, lines };
}

const asked = { env: "prod", version: "1", pastGuard: true, json: false, interactive: true };

async function codeOf(run: Promise<unknown>): Promise<string> {
  const error = await run.catch((caught: unknown) => caught);
  return error instanceof PithyError ? error.payload.code : String(error);
}

describe("pithy secrets retire-version --past-guard", () => {
  test("prints the stale counts, unrotatable fields and unread sources, then asks for <env>/<v>", async () => {
    const { deps, calls, lines } = harness("prod/1");
    const report = await runRetireVersion(asked, deps);
    expect(report?.retired).toEqual([1]);
    expect(calls).toEqual(["guard", "ask Type prod/1 to retire it:", "retire 1"]);
    expect(lines).toContain("  patients.diagnosis (diagnosis): 4 rows still under a version due to leave.");
    expect(lines).toContain("  visits.notes (notes): could not be counted.");
    expect(lines).toContain("  Unrotatable, never re-sealed: app:cache.tokens:value.token.");
    expect(lines).toContain("  Not read by the guard: apps/billing.");
    expect(lines.join("\n")).not.toContain("patients.email");
    expect(retirePhrase("prod", 1)).toBe("prod/1");
  });

  test("anything but the phrase retires nothing: a near miss, another environment's, and a cancel", async () => {
    for (const answer of ["prod/2", "staging/1", "1", "yes", null]) {
      const { deps, calls, lines } = harness(answer);
      expect(await runRetireVersion(asked, deps)).toBeNull();
      expect(calls).not.toContain("retire 1");
      expect(lines.at(-1)).toBe("Not retired.");
    }
  });

  test("refuses with confirmation_required under --json and off a terminal, before anything is read", async () => {
    for (const run of [
      { ...asked, json: true },
      { ...asked, interactive: false },
    ]) {
      const { deps, calls } = harness("prod/1");
      expect(await codeOf(runRetireVersion(run, deps))).toBe("secrets/confirmation_required");
      expect(calls).toEqual([]);
    }
  });

  test("runs only past the guard, and only for a live version", async () => {
    const { deps, calls } = harness("prod/1");
    expect(await codeOf(runRetireVersion({ ...asked, pastGuard: false }, deps))).toBe("validation/invalid_input");
    expect(await codeOf(runRetireVersion({ ...asked, version: "one" }, deps))).toBe("validation/invalid_input");
    expect(calls).toEqual([]);
    expect(await codeOf(runRetireVersion({ ...asked, version: "9" }, deps))).toBe("validation/invalid_input");
    expect(calls).toEqual(["guard"]);
  });
});

/** **`retire-version` has no `--yes`, and no flag that answers for a person** (#390). */
describe("pithy secrets retire-version", () => {
  test("declares --past-guard and --env, and nothing that confirms on a person's behalf", () => {
    const sub = (secrets.subCommands as Record<string, { args?: Record<string, unknown> }>)["retire-version"];
    const args = Object.keys(sub?.args ?? {});
    expect(args).toEqual(["version", "env", "past-guard", "json"]);
    for (const bypass of ["yes", "confirm", "force"]) expect(args).not.toContain(bypass);
  });
});
