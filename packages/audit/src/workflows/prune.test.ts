// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { resolveRetention } from "@pithy-sh/core/src/retention/policy";
import type { WorkflowStepLike } from "@pithy-sh/core/src/workflow/faults";
import { describe, expect, test } from "vitest";
import { type AuditPruneRun, auditPruneRun, pruneAuditTrail } from "./prune";

class Terminal extends Error {}

/** A step runner that journals each named step, so a replay serves what the first run answered. */
function steps(journal = new Map<string, unknown>()) {
  const ran: string[] = [];
  const step: WorkflowStepLike & { do<T>(name: string, a: unknown, b?: () => Promise<T>): Promise<T> } = {
    async do<T>(name: string, a: unknown, b?: () => Promise<T>): Promise<T> {
      const fn = (typeof a === "function" ? a : b) as () => Promise<T>;
      if (journal.has(name)) return journal.get(name) as T;
      ran.push(name);
      const value = await fn();
      journal.set(name, value);
      return value;
    },
  };
  return { step, ran, journal };
}

/** A run over two chains, each two pages long, with a hold answer the test controls. */
function run(held: (tenant: string | null) => boolean, overrides: Partial<AuditPruneRun> = {}) {
  const pages: string[] = [];
  const value: AuditPruneRun = {
    prunes: async () => true,
    checkpointed: true,
    tenants: async () => [null, "acme"],
    held: async (tenant) => held(tenant),
    chainPage: async (tenant, afterSeq) => {
      pages.push(`${tenant ?? "-"}@${afterSeq}`);
      return { pruned: 2, refused: 0, next: afterSeq === 0 ? 10 : null };
    },
    unchainedPage: async () => ({ deleted: 1, next: null }),
    ...overrides,
  };
  return { value, pages };
}

describe("pruneAuditTrail", () => {
  test("prunes every chain a page per step, each behind its own hold check, then the unchained rows", async () => {
    const { step, ran } = steps();
    const { value, pages } = run(() => false);
    expect(await pruneAuditTrail(value, step, Terminal)).toEqual({ pruned: 8, refused: 0, unchained: 1, held: 0 });
    expect(pages).toEqual(["-@0", "-@10", "acme@0", "acme@10"]);
    expect(ran).toEqual([
      "policy",
      "tenants",
      "hold 1 1",
      "chain 1 1",
      "hold 1 2",
      "chain 1 2",
      "hold 2 1",
      "chain 2 1",
      "hold 2 2",
      "chain 2 2",
      "unchained 1",
    ]);
  });

  test("a held trail is left whole, and the others are pruned", async () => {
    const { value, pages } = run((tenant) => tenant === "acme");
    expect(await pruneAuditTrail(value, steps().step, Terminal)).toMatchObject({ pruned: 4, held: 1 });
    expect(pages).toEqual(["-@0", "-@10"]);
  });

  test("a hold placed while a pass runs stops that chain at its next page", async () => {
    let hold = false;
    const { value, pages } = run(() => hold, {
      chainPage: async (tenant, afterSeq) => {
        pages.push(`${tenant ?? "-"}@${afterSeq}`);
        hold = true;
        return { pruned: 1, refused: 0, next: afterSeq + 1 };
      },
    });
    const outcome = await pruneAuditTrail(value, steps().step, Terminal);
    expect(pages).toEqual(["-@0"]);
    expect(outcome).toMatchObject({ pruned: 1, held: 2 });
  });

  test("stops a chain at the page budget", async () => {
    const { value, pages } = run(() => false, {
      tenants: async () => ["acme"],
      chainPage: async (tenant, afterSeq) => {
        pages.push(`${tenant}@${afterSeq}`);
        return { pruned: 1, refused: 0, next: afterSeq + 1 };
      },
    });
    await pruneAuditTrail(value, steps().step, Terminal, { pages: 3 });
    expect(pages).toEqual(["acme@0", "acme@1", "acme@2"]);
  });

  test("a policy that prunes nothing runs no step past asking it", async () => {
    const { step, ran } = steps();
    expect(await pruneAuditTrail(run(() => false, { prunes: async () => false }).value, step, Terminal)).toEqual({
      pruned: 0,
      refused: 0,
      unchained: 0,
      held: 0,
    });
    expect(ran).toEqual(["policy"]);
  });

  test("without a checkpoint bucket no chain is touched, and the unchained rows still are", async () => {
    const { value, pages } = run(() => false, { checkpointed: false });
    expect(await pruneAuditTrail(value, steps().step, Terminal)).toMatchObject({ pruned: 0, unchained: 1 });
    expect(pages).toEqual([]);
  });

  test("a replay serves the journalled pages and prunes nothing twice", async () => {
    const journal = new Map<string, unknown>();
    const first = run(() => false);
    await pruneAuditTrail(first.value, steps(journal).step, Terminal);
    const second = run(() => false);
    await pruneAuditTrail(second.value, steps(journal).step, Terminal);
    expect(second.pages).toEqual([]);
  });
});

describe("auditPruneRun", () => {
  test("refuses an env with no audit database bound", () => {
    expect(() => auditPruneRun({}, "DB", () => null)).toThrow(/not bound/);
  });

  test("prunes only under a policy that prunes, and touches chains only with a bucket", async () => {
    const env = { DB: {} };
    expect(await auditPruneRun(env, "DB", () => null).prunes()).toBe(false);
    const keepAll = resolveRetention({}, { purgeWindows: [], lifecycleActions: [] });
    expect(await auditPruneRun(env, "DB", () => keepAll).prunes()).toBe(false);
    const short = resolveRetention({ audit: { default: "90d" } }, { purgeWindows: [], lifecycleActions: [] });
    const run = auditPruneRun(env, "DB", () => short);
    expect(await run.prunes()).toBe(true);
    expect(run.checkpointed).toBe(false);
    expect(auditPruneRun({ ...env, AUDIT_CHECKPOINTS: {} }, "DB", () => short).checkpointed).toBe(true);
  });
});
