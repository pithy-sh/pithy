// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PurgeStep } from "@pithy-sh/core/src/capability/purge";
import type { WorkflowStepLike } from "@pithy-sh/core/src/workflow/faults";
import { describe, expect, test } from "vitest";
import { PURGE_START_PAGE, type PurgeOps, purgeUser, startDuePurges } from "./run";

/**
 * The purge's step structure (#622), against a step runner that behaves the way a Workflow does: a finished
 * step is served from the journal and never re-run, a step body that throws is attempted again up to the
 * platform's limit, and an instance that failed is replayed from the top against the same journal.
 */

class Terminal extends Error {}

/** A Workflow's journal and retry loop, in miniature. */
function workflow(attempts = 3) {
  const journal = new Map<string, unknown>();
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
      subject: "user",
      summary: `Erases ${name}'s rows.`,
      erase: async ({ subject }) => {
        erases += 1;
        log.push(`erase ${name} ${subject.id}`);
        if (erases <= failures) throw new Error(`${name} is down`);
      },
    },
  };
}

/** The account's records, recording what was asked of them in order. */
function ops(log: string[], due: "due" | "not_due" | "gone" = "due"): PurgeOps {
  let completed = false;
  return {
    due: async () => due,
    recordStep: async (userId, step, summary) => void log.push(`record ${step} ${userId}: ${summary}`),
    recordRetained: async (userId, step, basis) => void log.push(`retained ${step} ${userId}: ${basis}`),
    address: async (userId) => {
      log.push(`address ${userId}`);
      return due === "gone" ? null : "ada@example.test";
    },
    mailComplete: async (userId) => {
      log.push(`mail ${userId}`);
      return true;
    },
    complete: async (userId) => {
      log.push(`complete ${userId}`);
      const first = !completed;
      completed = true;
      return first;
    },
    fail: async (userId, step) => void log.push(`fail ${userId} at ${step}`),
  };
}

/** A contribution that keeps the account's rows, and counts every export and erase anybody asks of it. */
function retaining(name: string, log: string[]): PurgeStep {
  return {
    step: name,
    contribution: {
      subject: "user",
      summary: `Keeps ${name}'s rows.`,
      retain: { basis: `Kept by ${name}.` },
      export: async () => {
        log.push(`export ${name}`);
        return {};
      },
    },
  };
}

describe("purgeUser", () => {
  test("a retained step is recorded as retained, in its own step, and nothing of it is erased (#814)", async () => {
    const log: string[] = [];
    const auth = contribution("auth", log);
    const payments = retaining("payments", log);
    const media = contribution("media", log);
    const { step, ran } = workflow();
    const outcome = await purgeUser({ steps: [auth, payments, media], env: {}, ops: ops(log) }, step, Terminal, {
      userId: "u1",
    });
    expect(outcome).toEqual({
      userId: "u1",
      state: "purged",
      erased: ["media", "auth"],
      retained: ["payments"],
      mailed: true,
    });
    expect(ran).toEqual(["due", "retain payments", "erase media", "mail", "erase auth", "complete"]);
    expect(log).toContain("retained payments u1: Kept by payments.");
    expect(log).not.toContain("record payments u1: Keeps payments's rows.");
    expect(log.filter((line) => line.startsWith("export"))).toEqual([]);
  });

  test("a step reads the account's address only when it asks, inside the step (#814)", async () => {
    const log: string[] = [];
    const seen: (string | null)[] = [];
    const testers: PurgeStep = {
      step: "testers",
      contribution: {
        subject: "user",
        summary: "Erases the membership.",
        erase: async (context) => {
          seen.push((await context.address?.()) ?? "no accessor");
        },
      },
    };
    const { step } = workflow();
    await purgeUser({ steps: [testers, contribution("auth", log)], env: {}, ops: ops(log) }, step, Terminal, {
      userId: "u1",
    });
    expect(seen).toEqual(["ada@example.test"]);
    expect(log.filter((line) => line.startsWith("address"))).toEqual(["address u1"]);
  });

  test("one step per contribution, in composition order, auth's last and the mail just before it", async () => {
    const log: string[] = [];
    const auth = contribution("auth", log);
    const media = contribution("media", log);
    const app = contribution("app", log);
    const { step, ran } = workflow();
    const outcome = await purgeUser({ steps: [auth, media, app], env: {}, ops: ops(log) }, step, Terminal, {
      userId: "u1",
    });
    expect(outcome).toEqual({
      userId: "u1",
      state: "purged",
      erased: ["media", "app", "auth"],
      retained: [],
      mailed: true,
    });
    expect(ran).toEqual(["due", "erase media", "erase app", "mail", "erase auth", "complete"]);
    expect(log).toEqual([
      "erase media u1",
      "record media u1: Erases media's rows.",
      "erase app u1",
      "record app u1: Erases app's rows.",
      "mail u1",
      "erase auth u1",
      "record auth u1: Erases auth's rows.",
      "complete u1",
    ]);
  });

  test("a failing contribution retries alone, and the ones that finished are not run again", async () => {
    const log: string[] = [];
    const auth = contribution("auth", log);
    const media = contribution("media", log);
    // Fails twice — an adopter's own table, briefly unreachable — and then succeeds on the platform's retry.
    const app = contribution("app", log, 2);
    const { step, ran } = workflow(5);
    await purgeUser({ steps: [auth, media, app], env: {}, ops: ops(log) }, step, Terminal, { userId: "u1" });
    expect([media.erases(), app.erases(), auth.erases()]).toEqual([1, 3, 1]);
    expect(ran.filter((name) => name === "erase app")).toHaveLength(3);
    expect(ran.filter((name) => name === "erase media")).toHaveLength(1);
  });

  test("an instance that failed on one contribution, replayed, re-runs that one and none that finished", async () => {
    const log: string[] = [];
    const auth = contribution("auth", log);
    const media = contribution("media", log);
    // Fails through the whole retry budget of the first run, so the instance fails there.
    const app = contribution("app", log, 3);
    const { step } = workflow(3);
    const run = { steps: [auth, media, app], env: {}, ops: ops(log) };
    await expect(purgeUser(run, step, Terminal, { userId: "u1" })).rejects.toThrow("app is down");
    expect(log).not.toContain("mail u1");
    expect(auth.erases()).toBe(0);

    // Replayed against the same journal: media is served from it, app is attempted again and now succeeds.
    const outcome = await purgeUser(run, step, Terminal, { userId: "u1" });
    expect(outcome.state).toBe("purged");
    expect([media.erases(), app.erases(), auth.erases()]).toEqual([1, 4, 1]);
    expect(log.filter((line) => line === "mail u1")).toHaveLength(1);
  });

  test("a purge that gives up records the step it stopped at, in its own step, and fails as it would have (#823)", async () => {
    const log: string[] = [];
    const ledger = contribution("ledger", log, 3);
    const { step, ran } = workflow(3);
    const run = { steps: [contribution("media", log), ledger, contribution("auth", log)], env: {}, ops: ops(log) };
    await expect(purgeUser(run, step, Terminal, { userId: "u1" })).rejects.toThrow("ledger is down");
    expect(log).toContain("fail u1 at ledger");
    expect(ran.at(-1)).toBe("fail");
  });

  test("a failure at the mail or the completion names that step (#823)", async () => {
    const log: string[] = [];
    const broken = { ...ops(log), mailComplete: async () => Promise.reject(new Terminal("mail binding down")) };
    const { step } = workflow();
    await expect(
      purgeUser({ steps: [contribution("auth", log)], env: {}, ops: broken }, step, Terminal, { userId: "u1" }),
    ).rejects.toThrow("mail binding down");
    expect(log).toContain("fail u1 at mail");
  });

  test("a failure the purge cannot record still reports the failure that stopped it (#823)", async () => {
    const log: string[] = [];
    const broken = { ...ops(log), fail: async () => Promise.reject(new Error("database gone")) };
    const { step } = workflow();
    await expect(
      purgeUser({ steps: [contribution("media", log, 9)], env: {}, ops: broken }, step, Terminal, { userId: "u1" }),
    ).rejects.toThrow("media is down");
  });

  test("an account that is not due, or not there, erases nothing and exits without error", async () => {
    for (const due of ["not_due", "gone"] as const) {
      const log: string[] = [];
      const media = contribution("media", log);
      const { step, ran } = workflow();
      const outcome = await purgeUser({ steps: [media], env: {}, ops: ops(log, due) }, step, Terminal, {
        userId: "u1",
      });
      expect(outcome).toEqual({ userId: "u1", state: due, erased: [], retained: [], mailed: false });
      expect(ran).toEqual(["due"]);
      expect(media.erases()).toBe(0);
    }
  });

  test("each contribution is handed the subject and this run's env", async () => {
    const seen: unknown[] = [];
    const env = { DB: "binding" };
    const step = workflow().step;
    await purgeUser(
      {
        steps: [
          {
            step: "app",
            contribution: { subject: "user", summary: "x", erase: async (context) => void seen.push(context) },
          },
        ],
        env,
        ops: ops([]),
      },
      step,
      Terminal,
      { userId: "u9" },
    );
    expect(seen).toEqual([{ subject: { type: "user", id: "u9" }, env, address: expect.any(Function) }]);
  });

  test("notify is handed to the mail", async () => {
    const asked: (boolean | undefined)[] = [];
    const base = ops([]);
    await purgeUser(
      {
        steps: [],
        env: {},
        ops: {
          ...base,
          mailComplete: async (_userId, notify) => {
            asked.push(notify);
            return false;
          },
        },
      },
      workflow().step,
      Terminal,
      { userId: "u1", notify: false },
    );
    expect(asked).toEqual([false]);
  });
});

/** Due accounts, each under a deletion of its own. */
const dueOf = (ids: readonly string[]) => ids.map((userId, index) => ({ userId, deletedAt: 1_000 + index }));

describe("startDuePurges", () => {
  test("starts a purge for every due account, in pages, under its deletion, and reports how many", async () => {
    const ids = Array.from({ length: PURGE_START_PAGE + 3 }, (_, index) => `u${index}`);
    const started: { userId: string; deletedAt: number }[] = [];
    const { step, ran } = workflow();
    const result = await startDuePurges(
      {
        due: async () => dueOf(ids),
        start: async (due) => {
          started.push(due);
          return true;
        },
      },
      step,
      Terminal,
      {},
    );
    expect(result).toEqual({ started: ids.length });
    expect(started).toEqual(dueOf(ids));
    expect(ran).toEqual(["due", "start 1", "start 2"]);
  });

  test("counts only the purges that started: one the binding could not start is not reported as running", async () => {
    const ids = ["u0", "u1", "u2", "u3"];
    const { step } = workflow();
    const result = await startDuePurges(
      { due: async () => dueOf(ids), start: async ({ userId }) => userId === "u1" || userId === "u3" },
      step,
      Terminal,
      {},
    );
    expect(result).toEqual({ started: 2 });
    expect(
      await startDuePurges({ due: async () => dueOf(ids), start: async () => false }, workflow().step, Terminal, {}),
    ).toEqual({ started: 0 });
  });

  test("asks for the default page of due accounts, or the one named", async () => {
    const limits: number[] = [];
    const run = {
      due: async (limit: number) => {
        limits.push(limit);
        return [];
      },
      start: async () => true,
    };
    await startDuePurges(run, workflow().step, Terminal, {});
    await startDuePurges(run, workflow().step, Terminal, { limit: 7 });
    expect(limits).toEqual([500, 7]);
  });

  test("nothing due starts nothing", async () => {
    const { step, ran } = workflow();
    expect(await startDuePurges({ due: async () => [], start: async () => true }, step, Terminal, {})).toEqual({
      started: 0,
    });
    expect(ran).toEqual(["due"]);
  });

  test("a pass that died part-way resumes after the page it finished", async () => {
    const ids = Array.from({ length: PURGE_START_PAGE * 2 }, (_, index) => `u${index}`);
    const started: string[] = [];
    let failOnce = true;
    const run = {
      due: async () => dueOf(ids),
      start: async ({ userId }: { userId: string }) => {
        if (userId === `u${PURGE_START_PAGE}` && failOnce) {
          failOnce = false;
          throw new Terminal("the binding refused");
        }
        started.push(userId);
        return true;
      },
    };
    const { step } = workflow(1);
    await expect(startDuePurges(run, step, Terminal, {})).rejects.toThrow();
    await startDuePurges(run, step, Terminal, {});
    expect(started.filter((id) => id === "u0")).toHaveLength(1);
    expect(started.filter((id) => id === `u${PURGE_START_PAGE + 1}`)).toHaveLength(1);
  });
});
