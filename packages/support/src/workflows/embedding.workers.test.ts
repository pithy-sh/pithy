// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { WorkflowEvent } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import type { SupportAi } from "../ai/classify";
import { SupportConfig } from "../config/config";
import { SUPPORT_EMBEDDINGS_TABLE, SUPPORT_THREADS_TABLE, supportDatabase } from "../data/tables";
import { SUPPORT_MESSAGES_INDEX } from "../semantic/messageIndex";
import { freshSupportSchema, seedMessage, seedThread } from "../test-utils/seed";
import { fakeAi, fakeVectorStore } from "../test-utils/semantic";
import { SupportReprocessParams } from "./specs";
import { SupportClassifyWorkflow, SupportReprocessWorkflow, type SupportWorkerEnv } from "./worker";

/**
 * The classification Workflow embeds each inbound message when semantic search is on, and an embedding
 * failure costs the message its place in semantic results and nothing else. Driven through the shipped
 * `WorkflowEntrypoint` methods, on the prototype, as `worker.workers.test.ts` explains.
 */

const db = supportDatabase(env.DB);
const T0 = 1_700_000_000_000;

/** A model that classifies as billing for chat calls and embeds for embedding calls. */
function model(options: { failEmbedding?: boolean } = {}) {
  const embedder = fakeAi(1024);
  embedder.fail = options.failEmbedding ?? false;
  const classifications: string[] = [];
  const ai: SupportAi = {
    run: async (name: string, input: Record<string, unknown>) => {
      if ("text" in input) return embedder.run(name, input);
      classifications.push(name);
      return {
        response: JSON.stringify({ category: "billing", priority: "normal", sentiment: "neutral", confidence: 0.9 }),
      };
    },
  } as SupportAi;
  return { ai, classifications };
}

/** A step runner that runs each body once, as a fresh instance does, and records the step names. */
function steps() {
  const names: string[] = [];
  return {
    names,
    async do<T>(name: string, fn: () => Promise<T>): Promise<T> {
      names.push(name);
      return fn();
    },
  };
}

async function runClassify(workerEnv: SupportWorkerEnv, step: ReturnType<typeof steps>) {
  const event = { payload: { messageId: "m1" } } as WorkflowEvent<{ messageId: string }>;
  const workflow = { env: workerEnv } as unknown as SupportClassifyWorkflow;
  await SupportClassifyWorkflow.prototype.run.call(workflow, event, step as never);
}

const config = (input: Record<string, unknown>) => JSON.stringify(SupportConfig.parse(input));

beforeEach(async () => {
  await freshSupportSchema(env.DB);
  await seedThread(db, { id: "t1", lastMessageAt: T0 });
  await seedMessage(db, { id: "m1", threadId: "t1", subject: "Charged twice", body: "I was charged twice" });
});

describe("SupportClassifyWorkflow with semantic search on", () => {
  test("classifies, then embeds the message and stamps it", async () => {
    const { ai, classifications } = model();
    const store = fakeVectorStore();
    const step = steps();
    await runClassify(
      { DB: env.DB, AI: ai, SUPPORT_VECTORIZE: store, SUPPORT_CONFIG: config({ search: { semantic: true } }) },
      step,
    );
    expect(step.names).toEqual(["classify-m1", "embed-m1"]);
    expect(classifications).toHaveLength(1);
    expect(store.vectors.has("m1")).toBe(true);
    expect(await db.selectFrom(SUPPORT_EMBEDDINGS_TABLE).select("messageId").execute()).toEqual([{ messageId: "m1" }]);
  });

  test("an embedding failure is non-fatal: the message is stored and classified, and only unembedded", async () => {
    const { ai } = model({ failEmbedding: true });
    const store = fakeVectorStore();
    await expect(
      runClassify(
        { DB: env.DB, AI: ai, SUPPORT_VECTORIZE: store, SUPPORT_CONFIG: config({ search: { semantic: true } }) },
        steps(),
      ),
    ).resolves.toBeUndefined();
    const thread = await db.selectFrom(SUPPORT_THREADS_TABLE).select("category").executeTakeFirstOrThrow();
    expect(thread.category).toBe("billing");
    expect(store.vectors.size).toBe(0);
    expect(await db.selectFrom(SUPPORT_EMBEDDINGS_TABLE).selectAll().execute()).toEqual([]);
  });

  test("an index not yet bound to the worker is skipped, never thrown", async () => {
    const { ai } = model();
    await expect(
      runClassify({ DB: env.DB, AI: ai, SUPPORT_CONFIG: config({ search: { semantic: true } }) }, steps()),
    ).resolves.toBeUndefined();
  });

  test("with classification off, it embeds and does not classify", async () => {
    const { ai, classifications } = model();
    const store = fakeVectorStore();
    const step = steps();
    await runClassify(
      {
        DB: env.DB,
        AI: ai,
        SUPPORT_VECTORIZE: store,
        SUPPORT_CONFIG: config({ ai: { enabled: false }, search: { semantic: true } }),
      },
      step,
    );
    expect(step.names).toEqual(["embed-m1"]);
    expect(classifications).toEqual([]);
    expect(store.vectors.has("m1")).toBe(true);
  });

  test("with semantic search off, nothing is embedded", async () => {
    const { ai } = model();
    const store = fakeVectorStore();
    const step = steps();
    await runClassify({ DB: env.DB, AI: ai, SUPPORT_VECTORIZE: store, SUPPORT_CONFIG: config({}) }, step);
    expect(step.names).toEqual(["classify-m1"]);
    expect(store.vectors.size).toBe(0);
  });
});

describe("SupportReprocessWorkflow", () => {
  async function runReprocess(workerEnv: SupportWorkerEnv, payload: Record<string, unknown>) {
    const event = { payload } as WorkflowEvent<SupportReprocessParams>;
    const workflow = { env: workerEnv } as unknown as SupportReprocessWorkflow;
    return SupportReprocessWorkflow.prototype.run.call(workflow, event, steps() as never);
  }

  test("re-embeds the messages whose stamp is not the configured model", async () => {
    const store = fakeVectorStore();
    const report = await runReprocess(
      { DB: env.DB, AI: model().ai, SUPPORT_VECTORIZE: store, SUPPORT_CONFIG: config({ search: { semantic: true } }) },
      { index: SUPPORT_MESSAGES_INDEX },
    );
    expect(report).toMatchObject({ indexName: SUPPORT_MESSAGES_INDEX, reembedded: 1 });
    expect(store.vectors.has("m1")).toBe(true);
  });

  test("refuses a worker whose config has semantic search off, or whose index is unbound", async () => {
    await expect(
      runReprocess({ DB: env.DB, AI: model().ai, SUPPORT_CONFIG: config({}) }, { index: SUPPORT_MESSAGES_INDEX }),
    ).rejects.toThrow(/search.semantic is off/);
    await expect(
      runReprocess(
        { DB: env.DB, AI: model().ai, SUPPORT_CONFIG: config({ search: { semantic: true } }) },
        { index: SUPPORT_MESSAGES_INDEX },
      ),
    ).rejects.toThrow(/SUPPORT_VECTORIZE/);
  });

  test("its params name the one index support declares, and a filter is no part of them", () => {
    expect(SupportReprocessParams.parse({ index: "support-messages", all: true })).toEqual({
      index: SUPPORT_MESSAGES_INDEX,
      all: true,
    });
    expect(SupportReprocessParams.safeParse({ index: "docs" }).success).toBe(false);
  });
});
