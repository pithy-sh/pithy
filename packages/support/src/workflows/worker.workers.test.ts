// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { WorkflowEvent } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import type { SupportAi } from "../ai/classify";
import { SUPPORT_MIGRATION_ORDER } from "../capability";
import { SupportMessage } from "../data/message";
import { SUPPORT_MESSAGES_TABLE, SUPPORT_THREADS_TABLE, supportDatabase } from "../data/tables";
import { SupportThread } from "../data/thread";
import { support_0001_threads } from "../migrations/0001_threads";
import { SupportClassifyWorkflow, type SupportWorkerEnv } from "./worker";

/**
 * **The classification, driven through the shipped `WorkflowEntrypoint` in workerd** (pithy-sh/pithy#348).
 *
 * The unit tests beside `retryPolicy.ts` prove what `supportWorkflowRetry` decides. This proves the
 * decision is wired into the class the platform actually runs, against real D1 and the real
 * `NonRetryableError` from `cloudflare:workflows` — the two things a fake cannot stand in for, because
 * the engine recognises a terminal error by that class's own name and #338 measured what happens when
 * it does not: 32.6 seconds against 0.92.
 *
 * **The attempt count is the assertion.** "It threw" was true before any of this — the platform default
 * throws too, five attempts later. The number is the whole difference.
 *
 * Called on the prototype with an env rather than on a constructed instance: workerd refuses to
 * construct a `WorkflowEntrypoint` outside a Workflow invocation, and the body under test reads nothing
 * but `this.env`. This is the shipped method, not a copy of it — a wiring that regresses in `worker.ts`
 * fails here.
 */

const db = supportDatabase(env.DB);

const T0 = 1_700_000_000_000;
const INBOX = "support@help.example.com";

/** A step runner with the platform's rule in it: re-drive a body, unless it raised `NonRetryableError`. */
function retryingStep(maxAttempts: number): {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  attempts: number;
} {
  const runner = {
    attempts: 0,
    async do<T>(_name: string, fn: () => Promise<T>): Promise<T> {
      let last: unknown;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        runner.attempts += 1;
        try {
          return await fn();
        } catch (error) {
          if (error instanceof NonRetryableError) throw error;
          last = error;
        }
      }
      throw last;
    },
  };
  return runner;
}

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "support",
      order: SUPPORT_MIGRATION_ORDER,
      migrations: { "0001_threads": support_0001_threads },
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

/** One run of the real `SupportClassifyWorkflow.run`, through a step runner that would retry. */
async function runClassify(
  ai: SupportAi,
  messageId: string,
  step: { do<T>(name: string, fn: () => Promise<T>): Promise<T> },
): Promise<unknown> {
  const workerEnv: SupportWorkerEnv = { DB: env.DB, AI: ai };
  const event = { payload: { messageId } } as WorkflowEvent<{ messageId: string }>;
  const workflow = { env: workerEnv } as unknown as SupportClassifyWorkflow;
  return await SupportClassifyWorkflow.prototype.run.call(workflow, event, step as never);
}

async function seedThread(): Promise<void> {
  const at = new Date(T0);
  await db
    .insertInto(SUPPORT_THREADS_TABLE)
    .values(
      SupportThread.encode({
        id: "t1",
        channel: "email",
        inboxAddress: INBOX,
        subject: "Charged twice",
        fromAddress: "ada@example.com",
        fromName: null,
        senderAuthenticated: true,
        userId: null,
        category: "uncategorized",
        priority: "normal",
        sentiment: "neutral",
        confidence: null,
        model: null,
        classifiedAt: null,
        archived: false,
        archivedAt: null,
        archivedBy: null,
        messageCount: 1,
        firstMessageAt: at,
        lastMessageAt: at,
        createdAt: at,
        updatedAt: at,
      }),
    )
    .execute();
}

async function seedMessage(): Promise<void> {
  const at = new Date(T0);
  await db
    .insertInto(SUPPORT_MESSAGES_TABLE)
    .values(
      SupportMessage.encode({
        id: "m1",
        threadId: "t1",
        direction: "inbound",
        channel: "email",
        submittedByUserId: null,
        context: null,
        mimeMessageId: "m1@mail.example.com",
        mimeInReplyTo: null,
        mimeReferences: null,
        fromAddress: "ada@example.com",
        fromName: null,
        toAddress: INBOX,
        subject: "Charged twice",
        textBody: "I was charged twice and I want it back",
        htmlBody: null,
        emailJobId: null,
        rawKey: null,
        rawBytes: null,
        receivedAt: at,
        createdAt: at,
      }),
    )
    .execute();
}

beforeEach(async () => {
  for (const table of [
    "pithy_support_thread_flags",
    "pithy_support_classifications",
    "pithy_support_attachments",
    "pithy_support_messages",
    "pithy_support_threads",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  await runMigrations(env.DB, provider());
  await seedThread();
});

describe("SupportClassifyWorkflow — the classification the step runs under", () => {
  test("an absent AI binding fails on the first attempt, not after five", async () => {
    await seedMessage();

    // A deployment provisioned without its `AI` binding. This test is why `classifyMessage` resolves
    // the method before the call: wrapping the whole expression turned a missing binding into
    // `core/upstream_failed` — an outage — and the step re-drove an env that is not going to grow a
    // binding. It is `support/classification_failed`, and it is terminal.
    const step = retryingStep(5);
    const thrown = await runClassify(undefined as unknown as SupportAi, "m1", step).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(NonRetryableError);
    expect((thrown as Error).message).toContain("support/classification_failed: ");
    expect((thrown as Error).cause).toBeInstanceOf(PithyError);
    expect(step.attempts).toBe(1);
  });

  test("a model that could not be reached re-drives the step — the one fault this capability retries", async () => {
    await seedMessage();

    let calls = 0;
    const unreachable: SupportAi = {
      run: async () => {
        calls += 1;
        throw new Error("Workers AI: capacity temporarily exceeded");
      },
    };

    const step = retryingStep(3);
    const thrown = await runClassify(unreachable, "m1", step).catch((error: unknown) => error);

    // A `PithyError` on the way out, never a `NonRetryableError`: the classifier saw
    // `core/upstream_failed`, which `supportWorkflowRetry` states, and re-threw the original so the
    // platform re-drives it.
    expect(thrown).toBeInstanceOf(PithyError);
    expect((thrown as PithyError).payload.code).toBe("core/upstream_failed");
    expect(step.attempts).toBe(3);
    expect(calls).toBe(3);
  });

  test("a message that is gone is not a fault at all — one attempt, no throw", async () => {
    const step = retryingStep(5);
    await expect(
      runClassify(
        {
          run: async () => {
            throw new Error("the model was asked about a message that does not exist");
          },
        },
        "m-absent",
        step,
      ),
    ).resolves.toBeUndefined();
    expect(step.attempts).toBe(1);
  });

  test("a successful classification still lands through the classified runner", async () => {
    await seedMessage();

    const answering: SupportAi = {
      run: async () => ({
        response: JSON.stringify({ category: "billing", priority: "urgent", sentiment: "angry", confidence: 0.9 }),
      }),
    };
    const step = retryingStep(5);
    await runClassify(answering, "m1", step);

    expect(step.attempts).toBe(1);
    const row = await db.selectFrom(SUPPORT_THREADS_TABLE).selectAll().where("id", "=", "t1").executeTakeFirstOrThrow();
    expect(SupportThread.parse(row).category).toBe("billing");
  });
});
