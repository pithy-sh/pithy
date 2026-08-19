// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { uncoveredParamRoutes } from "@pithy-sh/core/src/http/routeContract";
import { workflowDispatchPath } from "@pithy-sh/core/src/workflow/schemas";
import type { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createEmailHostApp } from "./hostApp";

/**
 * The email host's HTTP door — the one #410 opened, and the only one it opened.
 *
 * Until now `workflows/worker.ts` exported two Workflow classes and a `scheduled()` handler and no
 * `fetch` at all, so there was no way to reach the send Workflow except the cross-script binding a
 * deployed app worker holds. `pithy dev` does not run that second script under that name, so locally
 * the call threw, the throw was swallowed, and a magic link sat `pending` while the sign-in screen
 * said "check your inbox".
 *
 * What is asserted here is the wiring, not the route's mechanics — those belong to
 * `@pithy-sh/core/src/workflow/dispatchRoute`. This file is about email having mounted it, on its own
 * registry, with its own error handler, and about the refusal outside `dev` surviving that mounting.
 */

/** The host's own same-script send Workflow, recording what it was asked to start. */
function fakeSender() {
  const started: { id?: string; params?: unknown }[] = [];
  return { started, create: async (options: { id?: string; params?: unknown }) => void started.push(options) };
}

/** POST a dispatch the way `loopbackWorkflowBinding` does. */
function dispatch(environment: string | undefined, binding: string, body: unknown, workerEnv: Record<string, unknown>) {
  const app = createEmailHostApp({ env: environment === undefined ? {} : { ENVIRONMENT: environment } });
  return app.request(
    workflowDispatchPath(binding),
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    workerEnv,
  );
}

describe("the email host answers a loopback dispatch in dev", () => {
  test("a send batch starts on EMAIL_SENDER, under the id the caller stamped on the row", async () => {
    const sender = fakeSender();

    const response = await dispatch(
      "dev",
      "EMAIL_SENDER",
      { id: "batch-1", params: { jobIds: ["job-1"] } },
      {
        EMAIL_SENDER: sender,
      },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ binding: "EMAIL_SENDER", id: "batch-1", started: true });
    // The id is relayed, never minted here: the row already names this instance (pithy-sh/pithy#342),
    // and an id the host chose for itself would be one the scheduler's veto could not ask about.
    expect(sender.started).toEqual([{ id: "batch-1", params: { jobIds: ["job-1"] } }]);
  });

  test("the scheduler Workflow is reachable on the same door", async () => {
    const scheduler = fakeSender();

    const response = await dispatch(
      "dev",
      "EMAIL_SCHEDULER",
      { id: "tick-1", params: {} },
      {
        EMAIL_SCHEDULER: scheduler,
      },
    );

    expect(response.status).toBe(202);
    expect(scheduler.started).toEqual([{ id: "tick-1", params: {} }]);
  });

  test("a batch of no jobs is refused by the send spec's own schema, not by the Workflow", async () => {
    const sender = fakeSender();

    // The registry the host mounts carries email's real params schema, so a malformed dispatch names
    // the field here rather than failing inside a durable instance three steps in.
    const response = await dispatch(
      "dev",
      "EMAIL_SENDER",
      { id: "batch-1", params: { jobIds: [] } },
      {
        EMAIL_SENDER: sender,
      },
    );

    expect(response.status).toBe(400);
    expect(sender.started).toEqual([]);
  });
});

describe("the door is shut everywhere a cross-script binding exists", () => {
  test.each(["staging", "prod"])("%s is refused, and nothing is started", async (environment) => {
    const sender = fakeSender();

    const response = await dispatch(
      environment,
      "EMAIL_SENDER",
      { id: "b", params: { jobIds: ["j"] } },
      {
        EMAIL_SENDER: sender,
      },
    );

    expect(response.status).toBe(403);
    expect(sender.started).toEqual([]);
  });

  test("an unstamped composition is refused too — a missing var must never read as dev", async () => {
    const sender = fakeSender();

    const response = await dispatch(
      undefined,
      "EMAIL_SENDER",
      { id: "b", params: { jobIds: ["j"] } },
      {
        EMAIL_SENDER: sender,
      },
    );

    expect(response.status).toBe(403);
    expect(sender.started).toEqual([]);
  });
});

describe("the host app is a Pithy app like any other", () => {
  test("its `:binding` segment is validated, so it trips no route-contract gate", async () => {
    expect(await uncoveredParamRoutes(createEmailHostApp() as unknown as Hono<never>)).toEqual([]);
  });

  test("a failure renders through pithyErrorHandler, not as an unhandled throw", async () => {
    const response = await dispatch("dev", "EMAIL_NOTHING", { id: "b", params: {} }, {});

    // A binding this host hosts no Workflow for: our own wiring fault, so 500 — and it arrives as a
    // rendered Pithy error rather than a stack trace, because the app mounts the handler.
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "core/unknown_workflow" } });
  });
});
