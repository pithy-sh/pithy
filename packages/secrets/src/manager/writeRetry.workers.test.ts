// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { WorkflowEvent } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { beforeEach, describe, expect, test } from "vitest";
import { secretsTables } from "../data/tables";
import { SecretAlreadyExistsError, SecretNotFoundError } from "../error/errors";
import { secrets_0001_init } from "../migrations/0001_init";
import { type SecretsManagerEnv, SecretsWriteWorkflow } from "./worker";
import type { WriteWorkflowPayload } from "./writeWorkflow";

/**
 * **A terminal fault fails on the first attempt** (pithy-sh/pithy#338).
 *
 * `create` refusing a name that already exists is the write path *working* — it is the refusal that
 * closes the concurrent-write race — and the step used to re-drive it with backoff as though the name
 * might stop existing. An operator watching that sees a hang where the system was working perfectly.
 *
 * Driven through the real `WorkflowEntrypoint` in workerd, against real D1, with a step runner that
 * re-drives anything the platform would: the count is the assertion, because "it threw" was already
 * true before the fix.
 */

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

/** The manager env, with the two bindings the write path reads and stubs for the rotation-only rest. */
function managerEnv(): SecretsManagerEnv {
  return {
    SECRETS: env.SECRETS,
    SECRETS_ENCRYPTION_KEYS: env.SECRETS_ENCRYPTION_KEYS,
    AT_REST_ROTATION: { create: async () => undefined },
    CLOUDFLARE_API_TOKEN: "unused",
    CLOUDFLARE_ACCOUNT_ID: "unused",
    SECRETS_STORE_ID: "unused",
    ENVIRONMENT: "staging",
    PROJECT: "replay",
  };
}

/**
 * One run of the real `SecretsWriteWorkflow.run`, over a payload, through a step runner that would retry.
 *
 * Called on the prototype with an env rather than on a constructed instance: workerd refuses to
 * construct a `WorkflowEntrypoint` outside a Workflow invocation (`constructor parameter 1 is not of
 * type 'ExecutionContext'`), and the body under test reads nothing but `this.env`. This is the shipped
 * method, not a copy of it — a wiring that regressed in `worker.ts` fails here.
 */
async function runWrite(
  payload: WriteWorkflowPayload,
  step: { do<T>(name: string, fn: () => Promise<T>): Promise<T> },
): Promise<unknown> {
  const event = { payload } as WorkflowEvent<WriteWorkflowPayload>;
  const workflow = { env: managerEnv() } as unknown as SecretsWriteWorkflow;
  return await SecretsWriteWorkflow.prototype.run.call(workflow, event, step as never);
}

beforeEach(async () => {
  await env.SECRETS.prepare("drop table if exists pithy_secrets_system_secrets").run();
  await env.SECRETS.prepare("drop table if exists pithy_secrets_rotations").run();
  await secrets_0001_init.up(createDatabase(env.SECRETS, secretsTables));
});

describe("SecretsWriteWorkflow — the classification the step runs under", () => {
  test("a create over an existing name fails on the first attempt", async () => {
    await runWrite(
      { mode: "create", name: "api-token", value: "v", valueType: "text", rotatable: false },
      {
        do: (_name, fn) => fn(),
      },
    );

    const step = retryingStep(5);
    const thrown = await runWrite(
      { mode: "create", name: "api-token", value: "second", valueType: "text", rotatable: false },
      step,
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(NonRetryableError);
    expect((thrown as Error).message).toBe("secrets/already_exists: Secret 'api-token' already exists.");
    expect((thrown as Error).cause).toBeInstanceOf(SecretAlreadyExistsError);
    expect(step.attempts).toBe(1);
  });

  test("the refusal is still a refusal — the stored value is untouched", async () => {
    await runWrite(
      { mode: "create", name: "api-token", value: "first", valueType: "text", rotatable: false },
      {
        do: (_name, fn) => fn(),
      },
    );
    await runWrite(
      { mode: "create", name: "api-token", value: "second", valueType: "text", rotatable: false },
      retryingStep(5),
    ).catch(() => undefined);

    const row = await env.SECRETS.prepare("select count(*) as n from pithy_secrets_system_secrets").first<{
      n: number;
    }>();
    expect(row?.n).toBe(1);
  });

  test("an update of a name that is not there fails on the first attempt", async () => {
    const step = retryingStep(5);
    const thrown = await runWrite(
      { mode: "update", name: "absent", value: "v", valueType: "text", rotatable: false },
      step,
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(NonRetryableError);
    expect((thrown as Error).cause).toBeInstanceOf(SecretNotFoundError);
    expect(step.attempts).toBe(1);
  });

  test("a write that succeeds still returns its outcome through the classified runner", async () => {
    const step = retryingStep(5);
    const result = await runWrite(
      { mode: "create", name: "api-token", value: "v", valueType: "text", rotatable: false },
      step,
    );
    expect(result).toEqual({ outcome: "written" });
    expect(step.attempts).toBe(1);
  });

  test("the harness would retry — a fault nothing states terminal is re-driven to exhaustion", async () => {
    // Without this, every count above could be 1 because the runner never retries anything.
    const step = retryingStep(3);
    await expect(
      step.do("write-secret", async () => {
        throw new Error("D1_ERROR: database is locked");
      }),
    ).rejects.toThrow("database is locked");
    expect(step.attempts).toBe(3);
  });
});
