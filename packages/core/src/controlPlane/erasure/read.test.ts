// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { AuditCitationQuery } from "../../audit/citations";
import { type Capability, defineCapability } from "../../capability/capability";
import type { ErasureHistoryRow, ErasureRecords } from "../../capability/erasure";
import { PithyError } from "../../error/pithyError";
import { ControlPlaneErasurePeriodResponse, ControlPlaneErasureSubjectResponse } from "../http/responses";
import { ERASURE_MAX_WINDOW_MS, erasureProviders, erasureWindow, readErasurePeriod, readErasureSubject } from "./read";

const DAY = 86_400_000;
const NOW = new Date("2026-10-27T00:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

function row(
  subjectId: string,
  action: ErasureHistoryRow["action"],
  when: Date,
  extra: Partial<ErasureHistoryRow> = {},
) {
  return {
    subjectId,
    action,
    actorType: "system",
    reason: null,
    step: null,
    mode: null,
    purgeAfter: null,
    at: when,
    ...extra,
  } satisfies ErasureHistoryRow;
}

/** A capability recording one subject's purges over a fixed set of rows. */
function recorder(subject: "user" | "organization", rows: ErasureHistoryRow[], asked: string[][] = []): Capability {
  const records: ErasureRecords = {
    subject,
    resourceType: subject,
    auditActions: {
      deleted: [`${subject}/deleted`],
      step: `${subject}/purge_step`,
      failed: `${subject}/purge_failed`,
      purged: `${subject}/purged`,
    },
    read: () => ({
      history: async (ids) => {
        asked.push([...ids]);
        return rows.filter((each) => ids.includes(each.subjectId));
      },
      subjectsIn: async () => [...new Set(rows.map((each) => each.subjectId))],
    }),
  };
  return defineCapability({ name: `${subject}-owner`, requiredBindings: [], erasureRecords: records });
}

function audit(queries: AuditCitationQuery[] = []): Capability {
  return defineCapability({
    name: "audit",
    requiredBindings: [],
    auditCitations: () => async (query) => {
      queries.push(query);
      return query.resourceIds.map((resourceId) => ({
        eventId: "ev-1",
        action: `${query.resourceType}/purged`,
        resourceId,
        occurredAt: ago(1),
        tenant: null,
        seq: 7,
        hash: "b".repeat(64),
        step: null,
      }));
    },
  });
}

const deps = (capabilities: Capability[]) => ({ composition: () => capabilities, now: () => NOW });

describe("erasureWindow", () => {
  test("defaults to the quarter before now", () => {
    expect(erasureWindow({}, NOW)).toEqual({ since: ago(90), until: NOW });
  });

  test("refuses a window that runs backwards, or longer than 366 days", () => {
    expect(() => erasureWindow({ since: NOW.toISOString(), until: ago(1).toISOString() }, NOW)).toThrow(PithyError);
    const since = new Date(NOW.getTime() - ERASURE_MAX_WINDOW_MS - 1).toISOString();
    expect(() => erasureWindow({ since, until: NOW.toISOString() }, NOW)).toThrow(/366 days/);
  });
});

describe("erasureProviders", () => {
  test("maps each subject to the capability that records it", () => {
    const providers = erasureProviders([recorder("user", []), audit(), recorder("organization", [])]);
    expect([...providers.keys()]).toEqual(["user", "organization"]);
  });
});

describe("readErasureSubject", () => {
  const rows = [row("u1", "deleted", ago(40), { purgeAfter: ago(10), mode: "soft" }), row("u1", "purged", ago(1))];

  test("attests one subject and cites its events through the composed audit", async () => {
    const queries: AuditCitationQuery[] = [];
    const response = await readErasureSubject({}, deps([recorder("user", rows), audit(queries)]), "user", "u1");
    expect(ControlPlaneErasureSubjectResponse.parse(response)).toEqual(response);
    expect(response.attestation).toMatchObject({ state: "complete", trail: "recorded", completion: { seq: 7 } });
    expect(queries).toEqual([
      {
        resourceType: "user",
        resourceIds: ["u1"],
        actions: ["user/deleted", "user/purge_step", "user/purge_failed", "user/purged"],
      },
    ]);
  });

  test("says the trail is absent when no audit is composed", async () => {
    const response = await readErasureSubject({}, deps([recorder("user", rows)]), "user", "u1");
    expect(response.attestation.trail).toBe("absent");
  });

  test("a subject with no deletion in force is a 404", async () => {
    await expect(readErasureSubject({}, deps([recorder("user", rows)]), "user", "nobody")).rejects.toMatchObject({
      payload: { code: "core/not_found", message: "No erasure on record for this subject." },
    });
  });

  test("a subject kind nothing here records is a 404 naming it", async () => {
    await expect(readErasureSubject({}, deps([recorder("user", rows)]), "organization", "o1")).rejects.toMatchObject({
      payload: { code: "core/not_found", message: "This Worker records no erasures for an organization." },
    });
  });
});

describe("readErasurePeriod", () => {
  test("reads every subject kind composed, counts, and names the failed one", async () => {
    const users = [
      row("u1", "deleted", ago(40), { purgeAfter: ago(10) }),
      row("u1", "purged", ago(9)),
      row("u2", "deleted", ago(40), { purgeAfter: ago(10) }),
      row("u2", "purge_failed", ago(9), { step: "ledger" }),
      row("u3", "deleted", ago(5)),
      row("u3", "restored", ago(4)),
    ];
    const orgs = [row("o1", "deleted", ago(30), { purgeAfter: ago(20) }), row("o1", "purged", ago(19))];
    const response = await readErasurePeriod(
      {},
      deps([recorder("user", users), recorder("organization", orgs), audit()]),
      {},
    );
    expect(ControlPlaneErasurePeriodResponse.parse(response)).toEqual(response);
    expect(response.subjects).toEqual(["user", "organization"]);
    expect(response.counts).toEqual({ scheduled: 0, inProgress: 0, complete: 2, failed: 1, overdue: 1 });
    expect(response.attention.map((entry) => [entry.subject.id, entry.stoppedAt])).toEqual([["u2", "ledger"]]);
    expect(response.purges.map((entry) => entry.subject.id)).toEqual(["o1", "u1", "u2"]);
  });

  test("reads history in chunks a D1 statement can bind", async () => {
    const many = Array.from({ length: 120 }, (_, index) => row(`u${index}`, "deleted", ago(3)));
    const asked: string[][] = [];
    await readErasurePeriod({}, deps([recorder("user", many, asked)]), {});
    expect(asked.map((ids) => ids.length)).toEqual([50, 50, 20]);
  });
});
