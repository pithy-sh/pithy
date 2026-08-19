// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { PithyHonoEnv } from "../capability/capability";
import { pithyErrorHandler } from "../error/http";
import { uncoveredParamRoutes } from "../http/routeContract";
import { registerWorkflowDispatchRoute, WORKFLOW_DISPATCH_VERIFICATION } from "./dispatchRoute";
import { WORKFLOW_DISPATCH_ROUTE, workflowDispatchPath } from "./schemas";
import type { WorkflowRegistry } from "./spec";

/**
 * The host's dispatch route: the loopback door `pithy dev` posts through, and the door that is shut
 * everywhere a cross-script binding exists.
 */

const JobIds = z
  .object({ jobIds: z.array(z.string().min(1)).min(1).describe("The rows this instance sends.") })
  .describe("Send-batch parameters.");

const registry: WorkflowRegistry = {
  "email/send": {
    key: "email/send",
    capability: "email",
    job: "send",
    spec: { binding: "EMAIL_SENDER", params: JobIds, className: "EmailSendWorkflow" },
  },
};

/** A same-script Workflow binding that records what it was asked to start. */
function fakeWorkflow() {
  const started: { id?: string; params?: unknown }[] = [];
  return { started, create: async (options: { id?: string; params?: unknown }) => void started.push(options) };
}

/** A host worker: the error handler every Pithy app mounts, plus the dispatch route. */
function hostApp(environment: string | undefined): Hono<PithyHonoEnv> {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  registerWorkflowDispatchRoute(app, {
    capability: "email",
    registry,
    env: environment === undefined ? {} : { ENVIRONMENT: environment },
  });
  return app;
}

/** POST a dispatch, as the loopback dispatcher does. */
function dispatch(app: Hono<PithyHonoEnv>, binding: string, body: unknown, env: Record<string, unknown>) {
  return app.request(
    workflowDispatchPath(binding),
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    env,
  );
}

describe("the dispatch route in dev", () => {
  test("it starts an instance against the host's own same-script binding, by the id it was given", async () => {
    const binding = fakeWorkflow();
    const res = await dispatch(
      hostApp("dev"),
      "EMAIL_SENDER",
      { id: "b1", params: { jobIds: ["j1"] } },
      {
        EMAIL_SENDER: binding,
      },
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ binding: "EMAIL_SENDER", id: "b1", started: true });
    expect(binding.started).toEqual([{ id: "b1", params: { jobIds: ["j1"] } }]);
  });

  test("an id is relayed exactly as the platform takes it — absent stays absent", async () => {
    const binding = fakeWorkflow();
    const res = await dispatch(
      hostApp("dev"),
      "EMAIL_SENDER",
      { params: { jobIds: ["j1"] } },
      {
        EMAIL_SENDER: binding,
      },
    );

    expect(res.status).toBe(202);
    expect(binding.started).toEqual([{ id: undefined, params: { jobIds: ["j1"] } }]);
  });

  test("params are validated against the registered spec, before the binding is touched", async () => {
    const binding = fakeWorkflow();
    const res = await dispatch(
      hostApp("dev"),
      "EMAIL_SENDER",
      { id: "b1", params: { jobIds: [] } },
      {
        EMAIL_SENDER: binding,
      },
    );

    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; detail?: string } }>();
    expect(body.error.code).toBe("core/invalid_workflow_params");
    // `clientError` is the one boundary: throw-site context never reaches the caller.
    expect(body.error.detail).toBeUndefined();
    expect(binding.started).toEqual([]);
  });

  test("a binding this host registers no workflow for is core/unknown_workflow, not a 500 on undefined", async () => {
    const res = await dispatch(hostApp("dev"), "MEDIA_ENRICH", { id: "b1", params: {} }, {});
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("core/unknown_workflow");
  });

  test("a registered binding that is absent from the env is core/missing_workflow_binding", async () => {
    const res = await dispatch(hostApp("dev"), "EMAIL_SENDER", { id: "b1", params: { jobIds: ["j1"] } }, {});
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("core/missing_workflow_binding");
  });

  test("a body that is not the dispatch shape is a 400 through the standard handler", async () => {
    const res = await dispatch(hostApp("dev"), "EMAIL_SENDER", { id: 7 }, { EMAIL_SENDER: fakeWorkflow() });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("validation/invalid_input");
  });
});

describe("the dispatch route outside dev", () => {
  test.each(["staging", "prod"])("it is refused in %s, with a PithyError and never a bare 404", async (environment) => {
    const binding = fakeWorkflow();
    const res = await dispatch(
      hostApp(environment),
      "EMAIL_SENDER",
      { id: "b1", params: { jobIds: ["j1"] } },
      {
        EMAIL_SENDER: binding,
      },
    );

    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string; message: string; action?: string } }>();
    expect(body.error.code).toBe("auth/forbidden");
    expect(body.error.message).toMatch(/dev/);
    // The operator's remedy stays off the wire, like every other action.
    expect(body.error.action).toBeUndefined();
    expect(binding.started).toEqual([]);
  });

  test("an unstamped ENVIRONMENT is not dev — a Worker whose var went missing is refused too", async () => {
    const binding = fakeWorkflow();
    const res = await dispatch(
      hostApp(undefined),
      "EMAIL_SENDER",
      { id: "b1", params: { jobIds: ["j1"] } },
      {
        EMAIL_SENDER: binding,
      },
    );

    expect(res.status).toBe(403);
    expect(binding.started).toEqual([]);
  });

  test("the refusal is the guard, so it beats the validators — a malformed body is still 403", async () => {
    const res = await dispatch(hostApp("prod"), "EMAIL_SENDER", { id: 7 }, {});
    expect(res.status).toBe(403);
  });
});

describe("the route's own contract", () => {
  test("it declares a verification strategy", () => {
    expect(WORKFLOW_DISPATCH_VERIFICATION).toBe("public");
  });

  test("the path is under the reserved __pithy namespace and names the binding", () => {
    expect(WORKFLOW_DISPATCH_ROUTE).toBe("/__pithy/workflows/:binding");
    expect(workflowDispatchPath("EMAIL_SENDER")).toBe("/__pithy/workflows/EMAIL_SENDER");
  });

  test("its :binding segment is covered by a declared param schema", async () => {
    const uncovered = await uncoveredParamRoutes(hostApp("dev") as unknown as Hono<never>);
    expect(uncovered).toEqual([]);
  });
});
