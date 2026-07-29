import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Capability, defineCapability } from "../capability/capability";
import { PithyError } from "../error/pithyError";
import { composeWorkflows, scheduledWorkflows } from "./register";

const NoParams = z.object({}).describe("A job that takes no parameters.");
const IdParams = z.object({ id: z.string().min(1).describe("The record id.") }).describe("A job keyed by record id.");

describe("composeWorkflows", () => {
  it("returns an empty registry when no capability declares a job", () => {
    expect(composeWorkflows([defineCapability({ name: "wallet", requiredBindings: [] })])).toEqual({});
  });

  it("keys every job <capability>/<job> and carries the declaring capability", () => {
    const registry = composeWorkflows([
      defineCapability({
        name: "email",
        requiredBindings: [],
        workflows: {
          send: { binding: "EMAIL_SENDER", params: IdParams, className: "EmailSendWorkflow" },
          schedule: {
            binding: "EMAIL_SCHEDULER",
            params: NoParams,
            className: "EmailSchedulerWorkflow",
            schedule: "* * * * *",
          },
        },
      }),
    ]);

    expect(Object.keys(registry).sort()).toEqual(["email/schedule", "email/send"]);
    expect(registry["email/send"]).toMatchObject({
      key: "email/send",
      capability: "email",
      job: "send",
      spec: { binding: "EMAIL_SENDER", className: "EmailSendWorkflow" },
    });
  });

  it("merges jobs across capabilities without them colliding", () => {
    const registry = composeWorkflows([
      defineCapability({
        name: "storage",
        requiredBindings: [],
        workflows: { sweep: { binding: "STORAGE_SWEEP", params: NoParams, className: "StorageSweepWorkflow" } },
      }),
      defineCapability({
        name: "vector",
        requiredBindings: [],
        workflows: { sweep: { binding: "VECTOR_SWEEP", params: NoParams, className: "VectorSweepWorkflow" } },
      }),
    ]);

    // Two capabilities may each own a job called `sweep` — the key is capability-namespaced.
    expect(Object.keys(registry).sort()).toEqual(["storage/sweep", "vector/sweep"]);
    expect(registry["storage/sweep"]?.spec.binding).toBe("STORAGE_SWEEP");
    expect(registry["vector/sweep"]?.spec.binding).toBe("VECTOR_SWEEP");
  });

  it("rejects the same capability composed twice, rather than letting one job shadow the other", () => {
    const media = defineCapability({
      name: "media",
      requiredBindings: [],
      workflows: { "image-to-text": { binding: "MEDIA_IMAGE_TO_TEXT", params: IdParams, className: "A" } },
    });
    const other = defineCapability({
      name: "media",
      requiredBindings: [],
      workflows: { "image-to-text": { binding: "SOMETHING_ELSE", params: IdParams, className: "B" } },
    });

    const error = (() => {
      try {
        composeWorkflows([media, other]);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain("media/image-to-text");
  });

  it("rejects a capability name that cannot be a Cloudflare resource segment", () => {
    const bad = defineCapability({
      name: "Media",
      requiredBindings: [],
      workflows: { job: { binding: "B", params: NoParams, className: "C" } },
    });
    expect(() => composeWorkflows([bad])).toThrow(PithyError);
  });

  it("accepts a widened Capability[] annotation", () => {
    // A bare `Capability` widens the generics away; composition must still work at runtime.
    const capabilities: Capability[] = [
      defineCapability({
        name: "email",
        requiredBindings: [],
        workflows: { send: { binding: "EMAIL_SENDER", params: IdParams, className: "EmailSendWorkflow" } },
      }),
    ];
    expect(Object.keys(composeWorkflows(capabilities))).toEqual(["email/send"]);
  });
});

describe("scheduledWorkflows", () => {
  it("returns only the jobs carrying a cron", () => {
    const registry = composeWorkflows([
      defineCapability({
        name: "email",
        requiredBindings: [],
        workflows: {
          send: { binding: "EMAIL_SENDER", params: IdParams, className: "EmailSendWorkflow" },
          schedule: {
            binding: "EMAIL_SCHEDULER",
            params: NoParams,
            className: "EmailSchedulerWorkflow",
            schedule: "* * * * *",
          },
        },
      }),
    ]);

    expect(scheduledWorkflows(registry).map((entry) => entry.key)).toEqual(["email/schedule"]);
  });

  it("returns nothing when no job is scheduled", () => {
    const registry = composeWorkflows([
      defineCapability({
        name: "email",
        requiredBindings: [],
        workflows: { send: { binding: "EMAIL_SENDER", params: IdParams, className: "EmailSendWorkflow" } },
      }),
    ]);
    expect(scheduledWorkflows(registry)).toEqual([]);
  });
});
