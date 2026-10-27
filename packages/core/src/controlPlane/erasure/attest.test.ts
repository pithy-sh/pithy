// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { AuditCitation } from "../../audit/citations";
import type { ErasureAuditActions, ErasureHistoryRow } from "../../capability/erasure";
import { ErasureAttestation } from "../http/responses";
import {
  type AttestInput,
  attest,
  byDue,
  deletionInForce,
  ERASURE_OVERDUE_AFTER_MS,
  periodEntry,
  summarize,
} from "./attest";

const DAY = 86_400_000;
const T0 = new Date("2026-10-01T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

const ACTIONS: ErasureAuditActions = {
  deleted: ["auth/admin_user_soft_deleted", "auth/admin_user_hard_deleted"],
  step: "auth/admin_user_purge_step",
  failed: "auth/admin_user_purge_failed",
  purged: "auth/admin_user_purged",
};

function row(
  action: ErasureHistoryRow["action"],
  ms: number,
  extra: Partial<ErasureHistoryRow> = {},
): ErasureHistoryRow {
  return {
    subjectId: "u1",
    action,
    actorType: action === "deleted" || action === "restored" ? "control-plane" : "system",
    reason: null,
    step: null,
    mode: null,
    purgeAfter: null,
    at: at(ms),
    ...extra,
  };
}

const deleted = (ms = 0, extra: Partial<ErasureHistoryRow> = {}) =>
  row("deleted", ms, { mode: "soft", purgeAfter: at(ms + 30 * DAY), reason: "Asked to close.", ...extra });

function citation(action: string, ms: number, extra: Partial<AuditCitation> = {}): AuditCitation {
  return {
    eventId: `ev-${action}-${ms}`,
    action,
    resourceId: "u1",
    occurredAt: at(ms),
    tenant: null,
    seq: Math.floor(ms / 1000) + 1,
    hash: "a".repeat(64),
    step: null,
    ...extra,
  };
}

function input(rows: ErasureHistoryRow[], extra: Partial<AttestInput> = {}): AttestInput {
  return { subject: "user", subjectId: "u1", rows, citations: [], actions: ACTIONS, now: at(31 * DAY), ...extra };
}

describe("deletionInForce", () => {
  test("is the first deletion after the last restore", () => {
    const rows = [deleted(0), row("restored", DAY), deleted(2 * DAY), deleted(3 * DAY, { mode: "hard" })];
    expect(deletionInForce(rows)?.map((each) => each.at)).toEqual([at(2 * DAY), at(3 * DAY)]);
  });

  test("is none for a subject never deleted, or restored since", () => {
    expect(deletionInForce([])).toBeNull();
    expect(deletionInForce([deleted(0), row("restored", DAY)])).toBeNull();
  });
});

describe("attest", () => {
  test("a finished purge: the deletion, every step, complete, and each step's event by id and chain position", () => {
    const rows = [
      deleted(0),
      row("purge_step", 30 * DAY + 1, { step: "media", reason: "Erases the person's uploads." }),
      row("purge_retained", 30 * DAY + 2, { step: "payments", reason: "Kept for tax records." }),
      row("purge_step", 30 * DAY + 3, { step: "auth", reason: "Erases the account." }),
      row("purged", 30 * DAY + 4),
    ];
    const citations = [
      citation("auth/admin_user_soft_deleted", 5),
      citation(ACTIONS.step, 30 * DAY + 1, { step: "media" }),
      citation(ACTIONS.step, 30 * DAY + 2, { step: "payments" }),
      citation(ACTIONS.step, 30 * DAY + 3, { step: "auth" }),
      citation(ACTIONS.purged, 30 * DAY + 4),
    ];
    const attestation = attest(input(rows, { citations }));
    expect(ErasureAttestation.parse(attestation)).toEqual(attestation);
    expect(attestation).toMatchObject({
      subject: { type: "user", id: "u1" },
      deletion: {
        actorType: "control-plane",
        reason: "Asked to close.",
        mode: "soft",
        audit: { eventId: "ev-auth/admin_user_soft_deleted-5" },
      },
      state: "complete",
      overdue: false,
      stoppedAt: null,
      completedAt: at(30 * DAY + 4).toISOString(),
      completion: { action: ACTIONS.purged, seq: citations[4]?.seq },
      failure: null,
      trail: "recorded",
    });
    expect(attestation?.steps.map((step) => [step.capability, step.disposition, step.audit?.eventId])).toEqual([
      ["media", "erased", `ev-${ACTIONS.step}-${30 * DAY + 1}`],
      ["payments", "retained", `ev-${ACTIONS.step}-${30 * DAY + 2}`],
      ["auth", "erased", `ev-${ACTIONS.step}-${30 * DAY + 3}`],
    ]);
  });

  test("a retained step shows its basis as the reason and never reads as erased (#814)", () => {
    const rows = [deleted(0), row("purge_retained", 30 * DAY, { step: "payments", reason: "Kept for tax records." })];
    const step = attest(input(rows))?.steps[0];
    expect(step).toMatchObject({ disposition: "retained", reason: "Kept for tax records.", summary: null });
  });

  test("an erased step carries its summary, never a reason", () => {
    const rows = [deleted(0), row("purge_step", 30 * DAY, { step: "media", reason: "Erases uploads." })];
    expect(attest(input(rows))?.steps[0]).toMatchObject({
      disposition: "erased",
      reason: null,
      summary: "Erases uploads.",
    });
  });

  test("a deletion still inside its window is scheduled", () => {
    expect(attest(input([deleted(0)], { now: at(DAY) }))).toMatchObject({
      state: "scheduled",
      overdue: false,
      stoppedAt: null,
    });
  });

  test("a deletion recorded before #823 has no mode or due instant, and reads scheduled until something runs", () => {
    const legacy = row("deleted", 0);
    expect(attest(input([legacy]))).toMatchObject({ state: "scheduled", deletion: { mode: null, purgeAfter: null } });
    expect(attest(input([legacy, row("purge_step", DAY, { step: "media" })]))?.state).toBe("in_progress");
  });

  test("a due purge with nothing run is in progress, and overdue two days on, stopped at `due`", () => {
    expect(attest(input([deleted(0)], { now: at(30 * DAY + 1) }))).toMatchObject({
      state: "in_progress",
      overdue: false,
    });
    expect(attest(input([deleted(0)], { now: at(30 * DAY + ERASURE_OVERDUE_AFTER_MS + 1) }))).toMatchObject({
      state: "in_progress",
      overdue: true,
      stoppedAt: "due",
    });
  });

  test("an overdue purge names the last step it finished", () => {
    const rows = [deleted(0), row("purge_step", 30 * DAY, { step: "media" })];
    expect(attest(input(rows, { now: at(33 * DAY) }))).toMatchObject({ overdue: true, stoppedAt: "media" });
  });

  test("a failed purge names the step it gave up at, and cites the failure", () => {
    const rows = [
      deleted(0),
      row("purge_step", 30 * DAY, { step: "media" }),
      row("purge_failed", 30 * DAY + 5, { step: "ledger" }),
    ];
    const citations = [citation(ACTIONS.failed, 30 * DAY + 5, { step: "ledger" })];
    expect(attest(input(rows, { citations, now: at(30 * DAY + 10) }))).toMatchObject({
      state: "failed",
      overdue: false,
      stoppedAt: "ledger",
      failure: { action: ACTIONS.failed },
    });
  });

  test("a step run again after a failure puts the purge back in progress, and shows the step once, as it last finished", () => {
    const rows = [
      deleted(0),
      row("purge_step", 30 * DAY, { step: "media" }),
      row("purge_failed", 30 * DAY + 1, { step: "ledger" }),
      row("purge_step", 31 * DAY, { step: "media" }),
      row("purge_step", 31 * DAY + 1, { step: "ledger" }),
    ];
    const attestation = attest(input(rows, { now: at(31 * DAY + 2) }));
    expect(attestation?.state).toBe("in_progress");
    expect(attestation?.steps.map((step) => [step.capability, step.completedAt])).toEqual([
      ["media", at(31 * DAY).toISOString()],
      ["ledger", at(31 * DAY + 1).toISOString()],
    ]);
  });

  test("a hard deletion that brought a soft one forward reads as hard and comes due when it says", () => {
    const rows = [deleted(0), deleted(DAY, { mode: "hard", purgeAfter: at(DAY) })];
    expect(attest(input(rows, { now: at(DAY) }))?.deletion).toMatchObject({
      at: at(0).toISOString(),
      mode: "hard",
      purgeAfter: at(DAY).toISOString(),
    });
  });

  test("no audit composed: nothing is cited, and the trail says absent", () => {
    const attestation = attest(input([deleted(0), row("purged", 30 * DAY)], { citations: null }));
    expect(attestation).toMatchObject({ trail: "absent", completion: null, deletion: { audit: null } });
  });

  test("an event from an earlier, restored deletion is never cited", () => {
    const rows = [deleted(0), row("restored", DAY), deleted(2 * DAY)];
    const citations = [citation("auth/admin_user_soft_deleted", 5)];
    expect(attest(input(rows, { citations }))?.deletion.audit).toBeNull();
  });

  test("no deletion in force: nothing to attest", () => {
    expect(attest(input([deleted(0), row("restored", DAY)]))).toBeNull();
  });

  test("carries nothing about the subject beyond its id", () => {
    const attestation = attest(input([deleted(0), row("purged", 30 * DAY)]));
    const text = JSON.stringify(attestation);
    expect(text).not.toMatch(/@|email|address|name/i);
  });
});

describe("the period", () => {
  test("counts each state, counts overdue within them, and names each failed or overdue purge", () => {
    const now = at(40 * DAY);
    const make = (id: string, rows: ErasureHistoryRow[]) =>
      periodEntry(
        attest({
          ...input(rows.map((each) => ({ ...each, subjectId: id }))),
          subjectId: id,
          now,
        }) as ErasureAttestation,
      );
    const entries = [
      make("done", [deleted(0), row("purged", 30 * DAY)]),
      make("failed", [deleted(0), row("purge_failed", 30 * DAY, { step: "ledger" })]),
      make("stuck", [deleted(0), row("purge_step", 30 * DAY, { step: "media" })]),
      make("waiting", [deleted(20 * DAY)]),
    ];
    const { counts, attention } = summarize(entries);
    expect(counts).toEqual({ scheduled: 1, inProgress: 1, complete: 1, failed: 1, overdue: 2 });
    expect(attention.map((entry) => [entry.subject.id, entry.stoppedAt])).toEqual([
      ["failed", "ledger"],
      ["stuck", "media"],
    ]);
  });

  test("orders by due instant, the undated last", () => {
    const entry = (id: string, purgeAfter: string | null) => ({
      subject: { type: "user" as const, id },
      state: "complete" as const,
      overdue: false,
      purgeAfter,
      completedAt: null,
      stoppedAt: null,
    });
    const sorted = byDue([
      entry("c", null),
      entry("b", "2026-10-02T00:00:00.000Z"),
      entry("a", "2026-10-01T00:00:00.000Z"),
    ]);
    expect(sorted.map((each) => each.subject.id)).toEqual(["a", "b", "c"]);
  });
});
