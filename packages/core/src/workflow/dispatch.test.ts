import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineCapability } from "../capability/capability";
import { PithyError } from "../error/pithyError";
import type { Logger } from "../logger/logger";
import { buildWorkflowDispatcher, triggerWorkflow } from "./dispatch";
import { composeWorkflows } from "./register";
import type { WorkflowRegistry } from "./spec";

/** A Workflow binding that records what it was started with. The structural shape is all dispatch needs. */
function fakeBinding() {
  const started: unknown[] = [];
  return {
    started,
    create: async (options?: { params?: unknown }) => {
      started.push(options?.params);
      return { id: "instance-1" };
    },
  };
}

/** A logger that records warnings, so the degraded path can be asserted rather than assumed silent. */
function fakeLogger(): Logger & { warnings: Array<{ message: string; fields?: Record<string, unknown> }> } {
  const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const logger = {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (message: string, fields?: Record<string, unknown>) => {
      warnings.push({ message, fields });
    },
    error: () => {},
    child: () => logger,
  } as unknown as Logger & { warnings: typeof warnings };
  return logger;
}

const SendParams = z
  .object({ jobIds: z.array(z.string().min(1)).describe("The email job ids to send.") })
  .describe("Parameters for the email send workflow.");

function registry(): WorkflowRegistry {
  return composeWorkflows([
    defineCapability({
      name: "email",
      requiredBindings: [],
      workflows: {
        send: { binding: "EMAIL_SENDER", params: SendParams, className: "EmailSendWorkflow" },
      },
    }),
    defineCapability({
      name: "media",
      requiredBindings: [],
      workflows: {
        "image-to-text": {
          binding: "MEDIA_IMAGE_TO_TEXT",
          params: z.object({ id: z.string().min(1).describe("The media record id.") }).describe("Enrichment params."),
          className: "MediaImageToTextWorkflow",
          optional: true,
        },
      },
    }),
  ]);
}

describe("triggerWorkflow", () => {
  it("starts the instance with the parsed params", async () => {
    const binding = fakeBinding();
    await triggerWorkflow({ EMAIL_SENDER: binding }, registry(), "email/send", { jobIds: ["a", "b"] });
    expect(binding.started).toEqual([{ jobIds: ["a", "b"] }]);
  });

  it("rejects an unregistered key with core/unknown_workflow, listing what is registered", async () => {
    const error = await triggerWorkflow({}, registry(), "email/snd", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PithyError);
    const payload = (error as PithyError).payload;
    expect(payload.code).toBe("core/unknown_workflow");
    expect(payload.status).toBe(500);
    expect(payload.detail).toContain("email/send");
    expect(payload.detail).toContain("media/image-to-text");
  });

  it("validates params before the binding is touched", async () => {
    // No binding at all in env: a bad payload must still report as a params failure, so the same
    // mistake reports the same way whether or not the host happens to be deployed.
    const error = await triggerWorkflow({}, registry(), "email/send", { jobIds: [42] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.code).toBe("core/invalid_workflow_params");
    expect((error as PithyError).payload.status).toBe(400);
  });

  it("names the offending field in detail, and keeps it out of the public message", async () => {
    const error = (await triggerWorkflow({}, registry(), "email/send", { jobIds: [""] }).catch(
      (e: unknown) => e,
    )) as PithyError;
    expect(error.payload.detail).toContain("jobIds.0");
    expect(error.payload.message).not.toContain("jobIds");
  });

  it("never starts an instance when params fail", async () => {
    const binding = fakeBinding();
    await triggerWorkflow({ EMAIL_SENDER: binding }, registry(), "email/send", { jobIds: "not-an-array" }).catch(
      () => {},
    );
    expect(binding.started).toEqual([]);
  });

  it("throws core/missing_workflow_binding for a required job whose binding is absent", async () => {
    const error = await triggerWorkflow({}, registry(), "email/send", { jobIds: ["a"] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.code).toBe("core/missing_workflow_binding");
    expect((error as PithyError).payload.status).toBe(500);
  });

  it("treats a binding present but not a Workflow as absent", async () => {
    // `validateBindings` only checks for null, so a string under the right name passes it. Dispatch
    // is the only place that can tell a Workflow from a var.
    const error = await triggerWorkflow({ EMAIL_SENDER: "oops" }, registry(), "email/send", { jobIds: ["a"] }).catch(
      (e: unknown) => e,
    );
    expect((error as PithyError).payload.code).toBe("core/missing_workflow_binding");
  });

  it("degrades to a warning for an optional job whose binding is absent", async () => {
    const log = fakeLogger();
    await expect(triggerWorkflow({}, registry(), "media/image-to-text", { id: "m1" }, log)).resolves.toBeUndefined();
    expect(log.warnings).toHaveLength(1);
    expect(log.warnings[0]?.fields).toMatchObject({
      workflow: "media/image-to-text",
      binding: "MEDIA_IMAGE_TO_TEXT",
    });
  });

  it("still validates an optional job's params — a degraded path is not an unchecked one", async () => {
    const error = await triggerWorkflow({}, registry(), "media/image-to-text", { id: "" }).catch((e: unknown) => e);
    expect((error as PithyError).payload.code).toBe("core/invalid_workflow_params");
  });

  it("starts an optional job normally once its binding is present", async () => {
    const binding = fakeBinding();
    await triggerWorkflow({ MEDIA_IMAGE_TO_TEXT: binding }, registry(), "media/image-to-text", { id: "m1" });
    expect(binding.started).toEqual([{ id: "m1" }]);
  });
});

describe("buildWorkflowDispatcher", () => {
  it("closes over the env so trigger takes only a key and params", async () => {
    const binding = fakeBinding();
    const dispatcher = buildWorkflowDispatcher({ EMAIL_SENDER: binding }, registry());
    await dispatcher.trigger("email/send", { jobIds: ["x"] });
    expect(binding.started).toEqual([{ jobIds: ["x"] }]);
  });

  it("threads the request logger through to the degraded path", async () => {
    const log = fakeLogger();
    const dispatcher = buildWorkflowDispatcher({}, registry(), log);
    await dispatcher.trigger("media/image-to-text", { id: "m1" });
    expect(log.warnings).toHaveLength(1);
  });
});

/**
 * Compile-time proof that the dispatcher's key and parameter types are derived from the composed
 * capabilities. Never executed — `tsc` failing here is the assertion.
 */
function typeProofs(): void {
  const capabilities = [
    defineCapability({
      name: "email",
      requiredBindings: [],
      workflows: { send: { binding: "EMAIL_SENDER", params: SendParams, className: "EmailSendWorkflow" } },
    }),
  ] as const;

  type Params = import("../capability/capability").MergedWorkflowParams<typeof capabilities>;
  const dispatcher = buildWorkflowDispatcher<Params>({}, {});

  void dispatcher.trigger("email/send", { jobIds: ["a"] });

  // @ts-expect-error — "email/schedule" is not a registered key.
  void dispatcher.trigger("email/schedule", { jobIds: ["a"] });

  // @ts-expect-error — jobIds must be strings, per the declaring capability's schema.
  void dispatcher.trigger("email/send", { jobIds: [1] });

  // @ts-expect-error — the payload must match the schema, not merely be an object.
  void dispatcher.trigger("email/send", { wrong: true });
}
void typeProofs;
void vi;
