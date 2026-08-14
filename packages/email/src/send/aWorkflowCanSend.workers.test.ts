// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { forgetComposition } from "@pithy-sh/core/src/capability/composition";
import { createBackend } from "@pithy-sh/core/src/createBackend";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type EmailEnqueueEnv, email } from "../capability";
import { emailDatabase, emailSuppressionDatabase } from "../data/tables";
import { email_0001_init } from "../migrations/0001_init";
import { email_0001_suppressions } from "../migrations/0001_suppressions";
import type { SendWorkflowBinding } from "./enqueue";
import { enqueueFromEnv } from "./fromComposition";
import { suppress } from "./suppression";

/**
 * **The gate for pithy-sh/pithy#356: a durable job can send mail.**
 *
 * A `compose` hook hands every composed capability to every other one, so a route can hold the email
 * capability's bound `enqueue` and call it. **A Workflow class cannot.** The runtime constructs it with
 * the worker `env` and nothing else, and `enqueue` is a closure rather than a binding — so the two ways
 * past it were to rebuild the send identity from `env` (this product's from-address in a second place,
 * free to drift from `pithy.config.ts`) or to pass the closure through Workflow params (which are
 * serialised, and a closure is not).
 *
 * That is why `pithy-sh/dashboard`'s key-rotation notice was written, tested, and reachable by nothing:
 * a monthly unattended pass against credentials into other people's production systems, and the one
 * notification most worth having was the one that could not be delivered.
 *
 * The seam is the composed set, recorded at assembly and resolvable from module scope — the same shape
 * `@pithy-sh/secrets` already uses for its shared accessor. {@link enqueueFromEnv} reads it, so a
 * Workflow says `enqueueFromEnv(this.env, …)` and gets the identity `pithy.config.ts` resolved,
 * restating nothing.
 */

/** The from identity this composition resolves. A Workflow that restated it would restate *something else*. */
const FROM_ADDRESS = "noreply@acme.test";
const FROM_NAME = "Acme Operations";

/**
 * A Workflow, as the runtime builds one: **constructed with `env` and nothing else.**
 *
 * Deliberately not a `WorkflowEntrypoint` subclass — importing `cloudflare:workers` would drag the
 * durable-execution machinery into a test about a seam, and the shape that matters is exactly this
 * constructor. If the enqueue can be reached from here it can be reached from a real `run(event, step)`,
 * because a real one has strictly more (a step, a payload) and no less.
 */
class RotationWorkflow {
  constructor(private readonly env: EmailEnqueueEnv) {}

  /** One durable step's body: tell the operator a signing key could not be rotated. */
  async run(to: string) {
    return await enqueueFromEnv(this.env, {
      to,
      template: "operationalNotice",
      payload: {
        severity: "warning",
        summary: "A connection signing key could not be rotated",
        thing: "acme-prod connection",
        when: "18 June, 14:02 UTC",
      },
    });
  }
}

/** A send-Workflow binding that records rather than dispatches. */
function recordingSender(): { binding: SendWorkflowBinding; dispatched: string[][] } {
  const dispatched: string[][] = [];
  return {
    dispatched,
    binding: {
      async create(options) {
        dispatched.push(options.params.jobIds);
        return undefined;
      },
    },
  };
}

/** The worker env, forwarded whole — the only thing a Workflow is ever handed. */
function workerEnv(sender: SendWorkflowBinding): EmailEnqueueEnv {
  return { ...(env as unknown as Record<string, unknown>), EMAIL_SENDER: sender } as unknown as EmailEnqueueEnv;
}

/** Assemble the app exactly as `pithy.config.ts` does. Nothing else is done with the returned Hono app. */
function composeApp(): void {
  createBackend({
    capabilities: [
      secrets({ registry: defineSecretRegistry({}) }),
      email({ fromAddress: FROM_ADDRESS, fromName: FROM_NAME, baseUrl: "https://acme.test" }),
    ],
  });
}

beforeEach(async () => {
  forgetComposition();
  for (const table of ["pithy_email_jobs", "pithy_email_events"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  await env.EMAIL_SUPPRESSIONS.prepare("drop table if exists pithy_email_suppressions").run();
  await email_0001_init.up(emailDatabase(env.DB));
  await email_0001_suppressions.up(emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS));
});

afterEach(forgetComposition);

describe("a Workflow can reach the composed sender", () => {
  test("a durable job holding only env enqueues real mail", async () => {
    composeApp();
    const sender = recordingSender();
    const result = await new RotationWorkflow(workerEnv(sender.binding)).run("ops@example.test");

    expect(result.status).toBe("pending");
    const row = await env.DB.prepare("select to_address, status, template from pithy_email_jobs where id = ?")
      .bind(result.jobId)
      .first<{ to_address: string; status: string; template: string }>();
    expect(row).toEqual({ to_address: "ops@example.test", status: "pending", template: "operationalNotice" });
    // The send actually started — a job row nobody dispatched is the failure this closes, one layer on.
    expect(sender.dispatched).toEqual([[result.jobId]]);
  });

  test("it sends as the identity `pithy.config.ts` resolved, restating nothing", async () => {
    composeApp();
    const result = await new RotationWorkflow(workerEnv(recordingSender().binding)).run("ops@example.test");
    const row = await env.DB.prepare("select from_address, from_name from pithy_email_jobs where id = ?")
      .bind(result.jobId)
      .first<{ from_address: string; from_name: string }>();
    expect(row).toEqual({ from_address: FROM_ADDRESS, from_name: FROM_NAME });
  });

  test("and it is the same seam, so #355's automatic suppression comes with it", async () => {
    composeApp();
    await suppress(
      emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
      { email: "gone@example.test", reason: "hard_bounce" },
      new Date(),
    );
    const sender = recordingSender();
    const result = await new RotationWorkflow(workerEnv(sender.binding)).run("gone@example.test");

    expect(result.status).toBe("suppressed");
    expect(result.suppressionReason).toBe("hard_bounce");
    expect(sender.dispatched).toEqual([]);
  });

  test("anti-vacuity: with email not composed it raises, naming what to compose", async () => {
    createBackend({ capabilities: [secrets({ registry: defineSecretRegistry({}) })] });
    await expect(new RotationWorkflow(workerEnv(recordingSender().binding)).run("ops@example.test")).rejects.toThrow(
      /email/i,
    );
  });

  test("anti-vacuity: with nothing composed at all it raises rather than answering emptily", async () => {
    await expect(new RotationWorkflow(workerEnv(recordingSender().binding)).run("ops@example.test")).rejects.toThrow();
  });
});
