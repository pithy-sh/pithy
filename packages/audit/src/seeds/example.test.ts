import { composeSeeds } from "@pithy-sh/core/src/seed/compose";
import { EXAMPLE_IDENTITIES } from "@pithy-sh/core/src/seed/exampleIdentities";
import { describe, expect, it } from "vitest";
import { audit } from "../capability";
import { AuditEventRow } from "../data/auditEvent";
import { auditExampleSeed } from "./example";

const castIds = new Set<string>(EXAMPLE_IDENTITIES.map((identity) => identity.id));

describe("auditExampleSeed", () => {
  it("is flagged as an example", () => {
    expect(auditExampleSeed.example).toBe(true);
  });

  it("never lists production — an example fixture is dev/staging only", () => {
    expect(auditExampleSeed.environments).not.toContain("production");
    expect(auditExampleSeed.environments).toEqual(["dev", "staging"]);
  });

  it("seeds audit events into the app database", () => {
    expect(auditExampleSeed.d1).toHaveLength(1);
    const [group] = auditExampleSeed.d1 ?? [];
    expect(group?.database).toBe("app");
    expect(group?.table).toBe("pithyAuditEvents");
    expect(group?.rows.length).toBeGreaterThan(0);
  });

  it("attributes every user event to the shared cast, so the trail lines up with the seeded users", () => {
    const [group] = auditExampleSeed.d1 ?? [];
    for (const row of group?.rows ?? []) {
      const event = row as { actorType: string; actorId: string | null };
      if (event.actorType === "user") {
        expect(event.actorId).not.toBeNull();
        expect(castIds.has(event.actorId as string)).toBe(true);
      }
    }
  });

  it("spans the taxonomy a dashboard filters on — every outcome and a range of severities", () => {
    const [group] = auditExampleSeed.d1 ?? [];
    const rows = (group?.rows ?? []) as { outcome: string; severity: string }[];
    expect(new Set(rows.map((row) => row.outcome))).toEqual(new Set(["success", "denied"]));
    expect(new Set(rows.map((row) => row.severity))).toEqual(new Set(["info", "warning", "critical"]));
  });

  it("every event validates against the real AuditEventRow schema (encode is the write-time gate)", () => {
    const [group] = auditExampleSeed.d1 ?? [];
    for (const row of group?.rows ?? []) {
      expect(() => AuditEventRow.encode(row as never)).not.toThrow();
    }
  });

  it("uses a unique eventId per row — the recorder's idempotency key", () => {
    const [group] = auditExampleSeed.d1 ?? [];
    const ids = (group?.rows ?? []).map((row) => (row as { eventId: string }).eventId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("audit() with seed.includeExamples", () => {
  it("composes the example set only when includeExamples is on", () => {
    const capability = audit();

    const withoutExamples = composeSeeds([capability], { env: "dev", includeExamples: false });
    expect(withoutExamples.sets).toHaveLength(0);

    const withExamples = composeSeeds([capability], { env: "dev", includeExamples: true });
    expect(withExamples.sets).toHaveLength(1);
    expect(withExamples.sets[0]?.key).toContain("audit");
  });

  it("never composes the example set for production, even with includeExamples on", () => {
    const capability = audit();

    const result = composeSeeds([capability], { env: "production", includeExamples: true });
    expect(result.sets).toHaveLength(0);
    expect(result.skippedByEnv.length).toBeGreaterThan(0);
  });
});
