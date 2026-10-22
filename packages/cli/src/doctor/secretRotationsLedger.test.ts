// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { FIELD_KEY_ROTATION_NAME } from "@pithy-sh/secrets/src/data/secretRotations";
import { type ClosedRotation, rotationFailureText } from "@pithy-sh/secrets/src/rotation/rotationLedger";
import { RotationTracker } from "@pithy-sh/secrets/src/store/rotationTracker";
import { afterEach, describe, expect, test, vi } from "vitest";
import { readFailedRotations } from "./secretRotations";

/**
 * **The field key's ledger row, as doctor reads it (#390).** Recorded under a sentinel no registry declares, so the
 * status read never lists it, and this branch is the only thing between a field-key failure and silence. The fan-out
 * over the project's `secrets` databases and the status read are stubbed; the branch under test is not.
 */

vi.mock("../migrations/run", async (original) => ({
  ...(await original<typeof import("../migrations/run")>()),
  readProjectDatabases: async <T>(_options: unknown, database: string, read: (d1: D1Database) => Promise<T>) => [
    { database, binding: "SECRETS", workers: ["api"], value: await read({} as D1Database) },
  ],
}));
vi.mock("@pithy-sh/secrets/src/admin/status", () => ({ readSecretStatus: async () => [] }));

/** The ledger's newest closed field-key row, and the names it was asked about. */
function ledger(row: ClosedRotation | null): string[] {
  const asked: string[] = [];
  vi.spyOn(RotationTracker, "fromD1").mockReturnValue({
    lastClosed: async (name: string) => {
      asked.push(name);
      return row;
    },
  } as unknown as RotationTracker);
  return asked;
}

const read = () => readFailedRotations({ projectDir: "/project", env: "prod", account: null, workers: [] }, {});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readFailedRotations — the field key", () => {
  test("reports a failed field-key pass under PITHY_FIELD_KEYS, with its code and when it closed", async () => {
    const asked = ledger({
      status: "failed",
      completedAt: new Date("2026-10-18T03:00:04.000Z"),
      errorMessage: rotationFailureText("field-key-overdue"),
    });
    expect(await read()).toEqual([
      { name: "PITHY_FIELD_KEYS", at: "2026-10-18T03:00:04.000Z", reason: "field-key-overdue" },
    ]);
    expect(asked).toEqual([FIELD_KEY_ROTATION_NAME]);
  });

  test("reads every field-key code back off its sentence", async () => {
    for (const code of ["field-key-ceiling", "field-key-unconfirmed", "field-key-incomplete"] as const) {
      ledger({
        status: "failed",
        completedAt: new Date("2026-10-18T03:00:04.000Z"),
        errorMessage: rotationFailureText(code),
      });
      expect((await read())[0]?.reason).toBe(code);
    }
  });

  test("reports nothing for a pass that succeeded, or for a ledger with no closed pass", async () => {
    ledger({ status: "success", completedAt: new Date("2026-10-18T03:00:04.000Z"), errorMessage: null });
    expect(await read()).toEqual([]);
    ledger(null);
    expect(await read()).toEqual([]);
    ledger({ status: "failed", completedAt: null, errorMessage: rotationFailureText("field-key-overdue") });
    expect(await read()).toEqual([]);
  });

  test("a failure in words this release does not write is reported with no code, never dropped", async () => {
    ledger({ status: "failed", completedAt: new Date("2026-10-18T03:00:04.000Z"), errorMessage: "something else" });
    expect(await read()).toEqual([{ name: "PITHY_FIELD_KEYS", at: "2026-10-18T03:00:04.000Z", reason: null }]);
  });
});
