// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineCapability } from "../capability/capability";
import { PithyError } from "../error/pithyError";
import type { Logger } from "../logger/logger";
import { buildWorkflowDispatcher, instanceIdFor, resolveWorkflowBinding, triggerWorkflow } from "./dispatch";
import { composeWorkflows } from "./register";
import type { RegisteredWorkflow, WorkflowRegistry } from "./spec";

/** A Workflow binding that records what it was started with. The structural shape is all dispatch needs. */
function fakeBinding() {
  const started: unknown[] = [];
  const ids: Array<string | undefined> = [];
  return {
    started,
    ids,
    create: async (options?: { id?: string; params?: unknown }) => {
      started.push(options?.params);
      ids.push(options?.id);
      return { id: options?.id ?? "instance-1" };
    },
  };
}

/**
 * A Workflow binding holding one instance per id, as Cloudflare does: a second `create` under a taken id is
 * refused, and `get` resolves for an id it holds. `lookUp: false` leaves `get` off, the way the loopback has none.
 */
function idBinding(options: { lookUp?: boolean } = {}) {
  const ids: string[] = [];
  const binding: {
    ids: string[];
    create: (o?: { id?: string }) => Promise<unknown>;
    get?: (id: string) => Promise<unknown>;
  } = {
    ids,
    create: async (o?: { id?: string }) => {
      if (o?.id !== undefined && ids.includes(o.id)) throw new Error(`instance.already_exists: ${o.id}`);
      if (o?.id !== undefined) ids.push(o.id);
      return { id: o?.id };
    },
  };
  if (options.lookUp !== false) {
    binding.get = async (id: string) => {
      if (!ids.includes(id)) throw new Error("instance.not_found");
      return { id };
    };
  }
  return binding;
}

/** A logger that records warnings, so the degraded path can be asserted rather than assumed silent. */
function fakeLogger(): Logger & {
  warnings: Array<{ message: string; fields?: Record<string, unknown> }>;
  infos: Array<{ message: string; fields?: Record<string, unknown> }>;
} {
  const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const infos: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const logger = {
    warnings,
    infos,
    debug: () => {},
    info: (message: string, fields?: Record<string, unknown>) => {
      infos.push({ message, fields });
    },
    warn: (message: string, fields?: Record<string, unknown>) => {
      warnings.push({ message, fields });
    },
    error: () => {},
    child: () => logger,
  } as unknown as Logger & { warnings: typeof warnings; infos: typeof infos };
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

  /**
   * A binding that is *there* and will not start anything is the same fact to the caller as one that is
   * absent, and `optional` is a promise about the caller's request path: it works without the job.
   *
   * Under `pithy dev` this is the ordinary case rather than the exotic one. The loopback stand-in is
   * composed the moment `<STEM>_ORIGIN` is published, so the binding is never absent — and a host that
   * has not matched its ready signal yet turns a media finalize into a 502 out of the request path,
   * which is precisely the degradation `optional` exists to provide.
   */
  it("degrades to a warning when an optional job's binding refuses the dispatch", async () => {
    const log = fakeLogger();
    const binding = {
      create: async () => {
        throw new PithyError({ code: "core/upstream_failed", status: 502, message: "host unreachable." });
      },
    };
    await expect(
      triggerWorkflow({ MEDIA_IMAGE_TO_TEXT: binding }, registry(), "media/image-to-text", { id: "m1" }, log),
    ).resolves.toBeUndefined();
    expect(log.warnings[0]?.fields).toMatchObject({ workflow: "media/image-to-text", reason: "host unreachable." });
  });

  it("a required job's dispatch failure is still the caller's, because nothing else can report it", async () => {
    const binding = {
      create: async () => {
        throw new PithyError({ code: "core/upstream_failed", status: 502, message: "host unreachable." });
      },
    };
    const error = await triggerWorkflow({ EMAIL_SENDER: binding }, registry(), "email/send", { jobIds: ["a"] }).catch(
      (e: unknown) => e,
    );
    expect((error as PithyError).payload.code).toBe("core/upstream_failed");
  });
});

const DailyParams = z
  .object({ region: z.string().default("all").describe("The region the daily pass covers.") })
  .describe("Parameters for the daily stats pass.");

/** A registry holding one job that names its instances by the UTC day it fired for, and one that names none. */
function namedRegistry(): WorkflowRegistry {
  return composeWorkflows([
    defineCapability({
      name: "stats",
      requiredBindings: [],
      workflows: {
        daily: {
          binding: "STATS_DAILY",
          params: DailyParams,
          className: "StatsDailyWorkflow",
          schedule: "0 1 * * *",
          instanceId: ({ firedAt, cron, params }) =>
            `daily-${firedAt.toISOString().slice(0, 10)}-${(params as { region: string }).region}${cron ? "-cron" : ""}`,
        },
        adhoc: { binding: "STATS_ADHOC", params: DailyParams, className: "StatsAdhocWorkflow" },
      },
    }),
  ]);
}

const FIRED = new Date("2026-11-09T01:00:00.000Z");

describe("instanceIdFor", () => {
  const daily = (): RegisteredWorkflow => {
    const entry = namedRegistry()["stats/daily"];
    if (!entry) throw new Error("expected stats/daily");
    return entry;
  };

  it("hands the spec the fire time, the cron and the params", () => {
    const seen: unknown[] = [];
    const entry = daily();
    entry.spec.instanceId = (context) => {
      seen.push(context);
      return "named";
    };
    expect(instanceIdFor(entry, { schedule: { cron: "0 1 * * *", firedAt: FIRED } }, { region: "eu" })).toBe("named");
    expect(seen).toEqual([{ firedAt: FIRED, cron: "0 1 * * *", params: { region: "eu" } }]);
  });

  it("fires a manual start now, with no cron key at all", () => {
    const seen: Array<Record<string, unknown>> = [];
    const entry = daily();
    entry.spec.instanceId = (context) => {
      seen.push({ ...context });
      return "named";
    };
    const before = Date.now();
    instanceIdFor(entry, {}, {});
    const firedAt = seen[0]?.firedAt as Date;
    expect(firedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(firedAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect("cron" in (seen[0] ?? {})).toBe(false);
  });

  it("takes the caller's id without asking the spec", () => {
    const entry = daily();
    entry.spec.instanceId = () => {
      throw new Error("not asked");
    };
    expect(instanceIdFor(entry, { id: "given" }, {})).toBe("given");
  });

  it("is undefined for a spec that names no instances", () => {
    const entry = namedRegistry()["stats/adhoc"];
    if (!entry) throw new Error("expected stats/adhoc");
    expect(instanceIdFor(entry, { schedule: { firedAt: FIRED } }, {})).toBeUndefined();
  });
});

describe("triggerWorkflow instance ids", () => {
  it("names a scheduled start by the spec's instanceId, with the fire time, the cron and the parsed params", async () => {
    const binding = fakeBinding();
    await triggerWorkflow({ STATS_DAILY: binding }, namedRegistry(), "stats/daily", {}, undefined, {
      schedule: { cron: "0 1 * * *", firedAt: FIRED },
    });
    expect(binding.ids).toEqual(["daily-2026-11-09-all-cron"]);
  });

  it("names a manual start by the spec's instanceId when the caller passes no id", async () => {
    const binding = fakeBinding();
    await triggerWorkflow({ STATS_DAILY: binding }, namedRegistry(), "stats/daily", { region: "eu" });
    expect(binding.ids).toHaveLength(1);
    expect(binding.ids[0]).toMatch(/^daily-\d{4}-\d{2}-\d{2}-eu$/);
  });

  it("uses the caller's id over the spec's instanceId", async () => {
    const binding = fakeBinding();
    await triggerWorkflow({ STATS_DAILY: binding }, namedRegistry(), "stats/daily", {}, undefined, {
      id: "backfill-2026-11-01",
    });
    expect(binding.ids).toEqual(["backfill-2026-11-01"]);
  });

  it("passes no id for a spec without instanceId, scheduled or not", async () => {
    const binding = fakeBinding();
    const env = { STATS_ADHOC: binding };
    await triggerWorkflow(env, namedRegistry(), "stats/adhoc", {});
    await triggerWorkflow(env, namedRegistry(), "stats/adhoc", {}, undefined, { schedule: { firedAt: FIRED } });
    expect(binding.ids).toEqual([undefined, undefined]);
  });

  it("starts a caller-named instance of a job without instanceId", async () => {
    const binding = fakeBinding();
    await triggerWorkflow({ STATS_ADHOC: binding }, namedRegistry(), "stats/adhoc", {}, undefined, { id: "once" });
    expect(binding.ids).toEqual(["once"]);
  });

  it("logs a scheduled start whose id is taken as already started, and does not throw", async () => {
    const binding = idBinding();
    const log = fakeLogger();
    const start = { schedule: { cron: "0 1 * * *", firedAt: FIRED } };
    await triggerWorkflow({ STATS_DAILY: binding }, namedRegistry(), "stats/daily", {}, log, start);
    await expect(
      triggerWorkflow({ STATS_DAILY: binding }, namedRegistry(), "stats/daily", {}, log, start),
    ).resolves.toBeUndefined();
    expect(binding.ids).toEqual(["daily-2026-11-09-all-cron"]);
    expect(log.infos).toEqual([
      {
        message: "workflow already started",
        fields: { workflow: "stats/daily", id: "daily-2026-11-09-all-cron" },
      },
    ]);
    expect(log.warnings).toEqual([]);
  });

  it("throws a manual start whose id is taken, because the caller asked for that instance", async () => {
    const binding = idBinding();
    const env = { STATS_DAILY: binding };
    await triggerWorkflow(env, namedRegistry(), "stats/daily", {}, undefined, { id: "x" });
    await expect(triggerWorkflow(env, namedRegistry(), "stats/daily", {}, undefined, { id: "x" })).rejects.toThrow(
      "instance.already_exists",
    );
  });

  it("throws a scheduled refusal when the id is not found afterwards, since it was not a taken id", async () => {
    const log = fakeLogger();
    const binding = {
      create: async () => {
        throw new Error("workflow not found");
      },
      get: async () => {
        throw new Error("instance.not_found");
      },
    };
    await expect(
      triggerWorkflow({ STATS_DAILY: binding }, namedRegistry(), "stats/daily", {}, log, {
        schedule: { firedAt: FIRED },
      }),
    ).rejects.toThrow("workflow not found");
    expect(log.infos).toEqual([]);
  });

  it("throws a scheduled refusal on a binding that cannot look an instance up", async () => {
    const binding = idBinding({ lookUp: false });
    const start = { schedule: { firedAt: FIRED } };
    await triggerWorkflow({ STATS_DAILY: binding }, namedRegistry(), "stats/daily", {}, undefined, start);
    await expect(
      triggerWorkflow({ STATS_DAILY: binding }, namedRegistry(), "stats/daily", {}, undefined, start),
    ).rejects.toThrow("instance.already_exists");
  });

  it("carries the id over loopback in dev", async () => {
    const wire = fakeFetch();
    const binding = resolveWorkflowBinding(
      { ENVIRONMENT: "dev", EMAIL_ORIGIN: "http://localhost:8797" },
      { binding: "STATS_DAILY", capability: "email", fetch: wire.fetch },
    );
    await triggerWorkflow({ STATS_DAILY: binding }, namedRegistry(), "stats/daily", {}, undefined, {
      schedule: { firedAt: FIRED },
    });
    expect(wire.calls[0]?.body).toEqual({ id: "daily-2026-11-09-all", params: { region: "all" } });
  });
});

/** A `fetch` that records what it was asked for and always accepts. The loopback wire, stubbed. */
function fakeFetch() {
  const calls: { url: string; body: unknown }[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ binding: "EMAIL_SENDER", started: true }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetch };
}

describe("resolveWorkflowBinding", () => {
  it("hands back the real binding whenever the env carries one", () => {
    const binding = fakeBinding();
    const resolved = resolveWorkflowBinding(
      { EMAIL_SENDER: binding },
      { binding: "EMAIL_SENDER", capability: "email" },
    );
    expect(resolved).toBe(binding);
  });

  it("prefers a published origin over the binding in dev, because the local binding cannot reach anything", async () => {
    // Whatever wrangler hands a local Worker for a cross-script binding to a script it is not running,
    // present-but-dead is indistinguishable at runtime from working. A published origin is not something
    // a composition has by accident: `pithy dev` writes one per host it is actually running.
    const binding = fakeBinding();
    const wire = fakeFetch();
    const resolved = resolveWorkflowBinding(
      { EMAIL_SENDER: binding, ENVIRONMENT: "dev", EMAIL_ORIGIN: "http://localhost:8797" },
      { binding: "EMAIL_SENDER", capability: "email", fetch: wire.fetch },
    );
    await resolved?.create({ params: { jobIds: ["a"] } });
    expect(binding.started).toEqual([]);
    expect(wire.calls).toHaveLength(1);
  });

  it("keeps the bound Workflow in dev when no origin was published for that capability", () => {
    // An adopter's own app-owned Workflow is the same-script shape, which `wrangler dev` implements
    // unchanged — and it is never published an origin, so it is never diverted.
    const binding = fakeBinding();
    const resolved = resolveWorkflowBinding(
      { APP_REPORT: binding, ENVIRONMENT: "dev" },
      { binding: "APP_REPORT", capability: "app" },
    );
    expect(resolved).toBe(binding);
  });

  it("substitutes a loopback dispatcher in dev, addressed by the capability's own origin var", async () => {
    const wire = fakeFetch();
    const resolved = resolveWorkflowBinding(
      { ENVIRONMENT: "dev", EMAIL_ORIGIN: "http://localhost:8797" },
      { binding: "EMAIL_SENDER", capability: "email", fetch: wire.fetch },
    );
    expect(resolved).toBeDefined();
    await resolved?.create({ id: "batch-1", params: { jobIds: ["a"] } });
    expect(wire.calls).toEqual([
      {
        url: "http://localhost:8797/__pithy/workflows/EMAIL_SENDER",
        body: { id: "batch-1", params: { jobIds: ["a"] } },
      },
    ]);
  });

  it("derives the origin var the way pithy dev writes it, hyphens and all", async () => {
    const wire = fakeFetch();
    const resolved = resolveWorkflowBinding(
      { ENVIRONMENT: "dev", MEDIA_CLI_ORIGIN: "http://localhost:8798" },
      { binding: "MEDIA_IMAGE_TO_TEXT", capability: "media-cli", fetch: wire.fetch },
    );
    await resolved?.create({ params: { id: "m1" } });
    expect(wire.calls[0]?.url).toBe("http://localhost:8798/__pithy/workflows/MEDIA_IMAGE_TO_TEXT");
  });

  it("substitutes nothing outside dev, however the origin got there", () => {
    for (const environment of ["staging", "prod"]) {
      const resolved = resolveWorkflowBinding(
        { ENVIRONMENT: environment, EMAIL_ORIGIN: "http://localhost:8797" },
        { binding: "EMAIL_SENDER", capability: "email" },
      );
      expect(resolved).toBeUndefined();
    }
  });

  it("substitutes nothing when the composition stamped no environment at all", () => {
    // A gate that reads an unstamped composition as `dev` opens itself in exactly the deployment
    // whose wrangler.jsonc lost the var.
    const resolved = resolveWorkflowBinding(
      { EMAIL_ORIGIN: "http://localhost:8797" },
      { binding: "EMAIL_SENDER", capability: "email" },
    );
    expect(resolved).toBeUndefined();
  });

  it("substitutes nothing in dev when no sibling published an address", () => {
    const resolved = resolveWorkflowBinding({ ENVIRONMENT: "dev" }, { binding: "EMAIL_SENDER", capability: "email" });
    expect(resolved).toBeUndefined();
  });

  it("treats a blank origin as no origin", () => {
    const resolved = resolveWorkflowBinding(
      { ENVIRONMENT: "dev", EMAIL_ORIGIN: "   " },
      { binding: "EMAIL_SENDER", capability: "email" },
    );
    expect(resolved).toBeUndefined();
  });

  it("reads the environment off the request env, not off the host's shell", () => {
    // `--var ENVIRONMENT` is what puts it on a Worker's env; the shell that ran `wrangler dev` does not
    // cross into workerd, and a host exporting ENVIRONMENT=dev must not open a deployed composition.
    vi.stubEnv("ENVIRONMENT", "dev");
    try {
      const resolved = resolveWorkflowBinding(
        { EMAIL_ORIGIN: "http://localhost:8797" },
        { binding: "EMAIL_SENDER", capability: "email" },
      );
      expect(resolved).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("triggerWorkflow over loopback", () => {
  it("dispatches to the sibling host instead of failing on the absent binding", async () => {
    const wire = fakeFetch();
    vi.stubGlobal("fetch", wire.fetch);
    try {
      await triggerWorkflow({ ENVIRONMENT: "dev", EMAIL_ORIGIN: "http://localhost:8797/" }, registry(), "email/send", {
        jobIds: ["a"],
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(wire.calls).toEqual([
      { url: "http://localhost:8797/__pithy/workflows/EMAIL_SENDER", body: { params: { jobIds: ["a"] } } },
    ]);
  });

  it("still validates params before it reaches for a sibling", async () => {
    const wire = fakeFetch();
    vi.stubGlobal("fetch", wire.fetch);
    try {
      const error = await triggerWorkflow(
        { ENVIRONMENT: "dev", EMAIL_ORIGIN: "http://localhost:8797" },
        registry(),
        "email/send",
        { jobIds: [42] },
      ).catch((e: unknown) => e);
      expect((error as PithyError).payload.code).toBe("core/invalid_workflow_params");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(wire.calls).toEqual([]);
  });

  it("keeps core/missing_workflow_binding for a dev composition with no host running", async () => {
    const error = await triggerWorkflow({ ENVIRONMENT: "dev" }, registry(), "email/send", { jobIds: ["a"] }).catch(
      (e: unknown) => e,
    );
    expect((error as PithyError).payload.code).toBe("core/missing_workflow_binding");
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

  it("passes the caller's id through trigger", async () => {
    const binding = fakeBinding();
    const dispatcher = buildWorkflowDispatcher({ STATS_DAILY: binding }, namedRegistry());
    await dispatcher.trigger("stats/daily", {}, { id: "2026-11-01" });
    expect(binding.ids).toEqual(["2026-11-01"]);
  });

  it("falls back to the spec's instanceId when trigger is given no id", async () => {
    const binding = fakeBinding();
    const dispatcher = buildWorkflowDispatcher({ STATS_DAILY: binding }, namedRegistry());
    await dispatcher.trigger("stats/daily", { region: "us" });
    expect(binding.ids[0]).toMatch(/^daily-\d{4}-\d{2}-\d{2}-us$/);
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
