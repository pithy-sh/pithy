// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PurgeStep } from "@pithy-sh/core/src/capability/purge";
import type { WorkflowStepLike } from "@pithy-sh/core/src/workflow/faults";
import { describe, expect, test } from "vitest";
import {
  ORGANIZATION_PURGE_START_PAGE,
  type OrganizationPurgeOps,
  purgeOrganization,
  startDueOrganizationPurges,
} from "./run";

/**
 * The organization purge's step structure (#623), against a step runner that behaves the way a Workflow does: a
 * finished step is served from the journal, a step body that throws is attempted again up to a limit, and an
 * instance replayed from the top runs only what had not finished.
 */

class Terminal extends Error {}

const ACME = "11111111-1111-4111-8111-111111111111";

/** A Workflow's journal and retry loop, in miniature. */
function workflow(attempts = 3, journal = new Map<string, unknown>()) {
  const ran: string[] = [];
  const step: WorkflowStepLike & {
    do<T>(name: string, configOrFn: unknown, maybeFn?: () => Promise<T>): Promise<T>;
  } = {
    async do<T>(name: string, configOrFn: unknown, maybeFn?: () => Promise<T>): Promise<T> {
      const fn = (typeof configOrFn === "function" ? configOrFn : maybeFn) as () => Promise<T>;
      if (journal.has(name)) return journal.get(name) as T;
      let last: unknown;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        ran.push(name);
        try {
          const value = await fn();
          journal.set(name, value);
          return value;
        } catch (error) {
          last = error;
          if (error instanceof Terminal) break;
        }
      }
      throw last;
    },
  };
  return { step, ran, journal };
}

/** A contribution that counts its erases, and fails the first `failures` of them. */
function contribution(name: string, log: string[], failures = 0): PurgeStep & { erases: () => number } {
  let erases = 0;
  return {
    step: name,
    erases: () => erases,
    contribution: {
      subject: "organization",
      summary: `Erases ${name}'s rows.`,
      erase: async ({ subject }) => {
        erases += 1;
        log.push(`erase ${name} ${subject.type}:${subject.id}`);
        if (erases <= failures) throw new Error(`${name} is down`);
      },
    },
  };
}

function ops(log: string[], due: "due" | "not_due" | "gone" = "due"): OrganizationPurgeOps {
  let completed = false;
  return {
    due: async () => due,
    recordStep: async (organizationId, step, summary) => void log.push(`record ${step} ${organizationId}: ${summary}`),
    recordRetained: async (organizationId, step, basis) =>
      void log.push(`retained ${step} ${organizationId}: ${basis}`),
    complete: async (organizationId) => {
      log.push(`complete ${organizationId}`);
      const first = !completed;
      completed = true;
      return first;
    },
    fail: async (organizationId, step) => void log.push(`fail ${organizationId} at ${step}`),
  };
}

describe("purgeOrganization", () => {
  test("a retained step is recorded as retained, in its own step, and nothing of it is erased (#814)", async () => {
    const log: string[] = [];
    const own = contribution("organization", log);
    const ledgerKept: PurgeStep = {
      step: "books",
      contribution: {
        subject: "organization",
        summary: "Keeps the organization's invoices.",
        retain: { basis: "Kept for tax records." },
        export: async () => ({}),
      },
    };
    const { step, ran } = workflow();
    const outcome = await purgeOrganization({ steps: [own, ledgerKept], env: {}, ops: ops(log) }, step, Terminal, {
      organizationId: ACME,
    });
    expect(outcome).toEqual({ organizationId: ACME, state: "purged", erased: ["organization"], retained: ["books"] });
    expect(ran.filter((name) => !name.startsWith("hold "))).toEqual([
      "due",
      "retain books",
      "erase organization",
      "complete",
    ]);
    expect(log).toContain(`retained books ${ACME}: Kept for tax records.`);
  });

  test("one step per contribution, in composition order, this capability's last, each recorded", async () => {
    const log: string[] = [];
    const own = contribution("organization", log);
    const media = contribution("media", log);
    const app = contribution("app", log);
    const { step, ran } = workflow();
    const outcome = await purgeOrganization({ steps: [own, media, app], env: {}, ops: ops(log) }, step, Terminal, {
      organizationId: ACME,
    });
    expect(outcome).toEqual({
      organizationId: ACME,
      state: "purged",
      erased: ["media", "app", "organization"],
      retained: [],
    });
    expect(ran.filter((name) => !name.startsWith("hold "))).toEqual([
      "due",
      "erase media",
      "erase app",
      "erase organization",
      "complete",
    ]);
    expect(log).toEqual([
      `erase media organization:${ACME}`,
      `record media ${ACME}: Erases media's rows.`,
      `erase app organization:${ACME}`,
      `record app ${ACME}: Erases app's rows.`,
      `erase organization organization:${ACME}`,
      `record organization ${ACME}: Erases organization's rows.`,
      `complete ${ACME}`,
    ]);
  });

  test("a failing contribution retries alone, and the ones that finished are not run again", async () => {
    const log: string[] = [];
    const own = contribution("organization", log);
    const media = contribution("media", log);
    const app = contribution("app", log, 2);
    const { step, ran } = workflow(5);
    await purgeOrganization({ steps: [own, media, app], env: {}, ops: ops(log) }, step, Terminal, {
      organizationId: ACME,
    });
    expect([media.erases(), app.erases(), own.erases()]).toEqual([1, 3, 1]);
    expect(ran.filter((name) => name === "erase app")).toHaveLength(3);
    expect(ran.filter((name) => name === "erase media")).toHaveLength(1);
  });

  test("an instance that failed on one contribution, replayed, re-runs that one and none that finished", async () => {
    const log: string[] = [];
    const own = contribution("organization", log);
    const media = contribution("media", log);
    const app = contribution("app", log, 3);
    const first = workflow(3);
    await expect(
      purgeOrganization({ steps: [own, media, app], env: {}, ops: ops(log) }, first.step, Terminal, {
        organizationId: ACME,
      }),
    ).rejects.toThrow("app is down");
    const replay = workflow(3, first.journal);
    await purgeOrganization({ steps: [own, media, app], env: {}, ops: ops(log) }, replay.step, Terminal, {
      organizationId: ACME,
    });
    expect(replay.ran.filter((name) => !name.startsWith("hold "))).toEqual([
      "erase app",
      "erase organization",
      "complete",
    ]);
    expect(media.erases()).toBe(1);
  });

  test("a purge that gives up records the step it stopped at, in its own step, and fails as it would have (#823)", async () => {
    const log: string[] = [];
    const { step, ran } = workflow(3);
    const run = {
      steps: [contribution("media", log, 3), contribution("organization", log)],
      env: {},
      ops: ops(log),
    };
    await expect(purgeOrganization(run, step, Terminal, { organizationId: "o1" })).rejects.toThrow("media is down");
    expect(log).toContain("fail o1 at media");
    expect(ran.at(-1)).toBe("fail");
  });

  test("a failure the purge cannot record still reports the failure that stopped it (#823)", async () => {
    const log: string[] = [];
    const broken = { ...ops(log), fail: async () => Promise.reject(new Error("database gone")) };
    const { step } = workflow();
    await expect(
      purgeOrganization({ steps: [contribution("media", log, 9)], env: {}, ops: broken }, step, Terminal, {
        organizationId: "o1",
      }),
    ).rejects.toThrow("media is down");
  });

  test("an organization not due, or gone, erases nothing and completes nothing", async () => {
    for (const due of ["not_due", "gone"] as const) {
      const log: string[] = [];
      const { step, ran } = workflow();
      const outcome = await purgeOrganization(
        { steps: [contribution("media", log)], env: {}, ops: ops(log, due) },
        step,
        Terminal,
        { organizationId: ACME },
      );
      expect(outcome).toEqual({ organizationId: ACME, state: due, erased: [], retained: [] });
      expect(ran).toEqual(["due"]);
      expect(log).toEqual([]);
    }
  });
});

describe("purgeOrganization under a legal hold", () => {
  test("a hold standing before the first step erases nothing and completes nothing", async () => {
    const log: string[] = [];
    const { step } = workflow();
    const outcome = await purgeOrganization(
      {
        steps: [contribution("media", log), contribution("organization", log)],
        env: {},
        ops: ops(log),
        held: async () => true,
      },
      step,
      Terminal,
      { organizationId: ACME },
    );
    expect(outcome).toEqual({ organizationId: ACME, state: "held", erased: [], retained: [] });
    expect(log).toEqual([]);
  });

  test("a hold placed mid-run stops at the next step, and the purge after release finishes it", async () => {
    const log: string[] = [];
    let hold = false;
    let released = false;
    const media = {
      step: "media",
      contribution: {
        subject: "organization" as const,
        summary: "Deletes media.",
        erase: async () => {
          log.push("erase media");
          // Counsel calls while the first purge's first step runs, and only then.
          if (!released) hold = true;
        },
      },
    };
    const steps = [media, contribution("organization", log)];
    const first = await purgeOrganization(
      { steps, env: {}, ops: ops(log), held: async () => hold },
      workflow().step,
      Terminal,
      { organizationId: ACME },
    );
    expect(first).toMatchObject({ state: "held", erased: ["media"] });
    expect(log.some((line) => line.includes("organization"))).toBe(false);

    hold = false;
    released = true;
    const second = await purgeOrganization(
      { steps, env: {}, ops: ops(log), held: async () => hold },
      workflow().step,
      Terminal,
      { organizationId: ACME },
    );
    expect(second).toMatchObject({ state: "purged", erased: ["media", "organization"] });
  });
});

describe("startDueOrganizationPurges", () => {
  test("starts no purge for a held organization", async () => {
    const started: string[] = [];
    const result = await startDueOrganizationPurges(
      {
        due: async () => [
          { organizationId: "a", deletedAt: 1 },
          { organizationId: "b", deletedAt: 2 },
        ],
        start: async ({ organizationId }) => {
          started.push(organizationId);
          return true;
        },
        held: async (organizationId) => organizationId === "a",
      },
      workflow().step,
      Terminal,
      {},
    );
    expect(started).toEqual(["b"]);
    expect(result).toEqual({ started: 1 });
  });

  test("starts one purge per due organization, a page per step, and counts only what started", async () => {
    const due = Array.from({ length: ORGANIZATION_PURGE_START_PAGE + 2 }, (_, index) => ({
      organizationId: `org-${index}`,
      deletedAt: index,
    }));
    const asked: number[] = [];
    const { step, ran } = workflow();
    const result = await startDueOrganizationPurges(
      {
        due: async (limit) => {
          asked.push(limit);
          return due;
        },
        start: async (each) => each.organizationId !== "org-1",
      },
      step,
      Terminal,
      {},
    );
    expect(asked).toEqual([500]);
    expect(ran).toEqual(["due", "start 1", "start 2"]);
    expect(result).toEqual({ started: due.length - 1 });
  });
});
