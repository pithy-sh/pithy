// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { describe, expect, test, vi } from "vitest";
import { emitFromCLI } from "./emitFromCLI";
import type { ResolvedActor } from "./resolveActor";

/** A successful D1 `all()` result shape (kysely-d1 reads `error`/`meta`). */
const OK = { results: [], success: true, meta: { changes: 1, last_row_id: 1, duration: 0 } };

/**
 * A fake `D1Database` capturing every prepared statement. `handler` decides each `all()`'s outcome,
 * so a test can make the write succeed or fail. Only the `prepare().bind().all()` path kysely-d1
 * drives is implemented; the rest is cast away.
 */
function fakeD1(handler: (sql: string, params: unknown[]) => Promise<unknown> = async () => OK): {
  db: D1Database;
  calls: { sql: string; params: unknown[] }[];
} {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async all() {
              calls.push({ sql, params });
              return handler(sql, params);
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, calls };
}

const serviceActor: ResolvedActor = {
  actorType: "service",
  actorId: "ci-deployer",
  metadata: { cfTokenType: "account", cfTokenId: "tok-1" },
};

describe("emitFromCLI", () => {
  test("writes the event to pithy_audit_events with the resolved actor merged in", async () => {
    const { db, calls } = fakeD1();
    const onError = vi.fn();

    await emitFromCLI(
      db,
      { action: "migrate/applied", outcome: "success", severity: "info", metadata: { env: "production" } },
      serviceActor,
      { onError },
    );

    expect(onError).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toMatch(/insert into "pithy_audit_events"/);
    // The actor's type/id and the action are bound as parameters; the metadata merges actor + event.
    expect(calls[0]?.params).toContain("service");
    expect(calls[0]?.params).toContain("ci-deployer");
    expect(calls[0]?.params).toContain("migrate/applied");
    const metadataParam = (calls[0]?.params ?? []).find(
      (p): p is string => typeof p === "string" && p.includes("cfTokenId"),
    );
    expect(JSON.parse(metadataParam ?? "{}")).toEqual({
      cfTokenType: "account",
      cfTokenId: "tok-1",
      env: "production",
    });
  });

  test("a write failure is non-fatal: it resolves and reports an audit/write_failed error", async () => {
    const { db } = fakeD1(async () => {
      throw new Error("D1_ERROR: no such table: pithy_audit_events");
    });
    const onError = vi.fn();

    await expect(
      emitFromCLI(db, { action: "deploy/started", outcome: "success" }, serviceActor, { onError }),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0].payload.code).toBe("audit/write_failed");
  });
});
