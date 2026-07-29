import { join } from "node:path";
import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { InternalError, NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import type { WorkerConfig } from "./config";
import { projectCapabilities, type ResolvedWorker, resolveSingleWorker, resolveWorkers } from "./workerScope";
import type { WorkerTarget } from "./workers";

/** A discovered worker target, as `discoverWorkers` would return it. */
function target(name: string, dir = `/proj/apps/${name}`): WorkerTarget {
  return { name, dir, dev: { autostart: true, readySignal: "Ready on https?://" }, hasWrangler: true };
}

/** A worker config seam keyed by directory, so tests never touch the filesystem. */
function configs(byDir: Record<string, WorkerConfig>) {
  return async (dir: string): Promise<WorkerConfig> => {
    const config = byDir[dir];
    if (!config) throw new NotFoundError({ message: `no config in ${dir}` });
    return config;
  };
}

const API = { capabilities: [] } as WorkerConfig;
const COLLAB = { capabilities: [] } as WorkerConfig;

describe("resolveWorkers", () => {
  test("returns every worker with its own config, in discovery order", async () => {
    const workers = await resolveWorkers({
      projectDir: "/proj",
      discoverWorkers: async () => [target("api"), target("collab")],
      loadConfig: configs({ "/proj/apps/api": API, "/proj/apps/collab": COLLAB }),
    });

    expect(workers.map((w) => w.name)).toEqual(["api", "collab"]);
    expect(workers[0]?.dir).toBe(join("/proj", "apps", "api"));
    expect(workers[0]?.config).toBe(API);
  });

  test("narrows to one worker by name", async () => {
    const workers = await resolveWorkers({
      projectDir: "/proj",
      worker: "collab",
      discoverWorkers: async () => [target("api"), target("collab")],
      loadConfig: configs({ "/proj/apps/api": API, "/proj/apps/collab": COLLAB }),
    });
    expect(workers.map((w) => w.name)).toEqual(["collab"]);
  });

  test("skips a dev-only process that has no pithy.config.ts", async () => {
    // A Vite frontend joins the dev set via pithy.worker.jsonc alone — it has no capabilities to
    // migrate, seed, or reconcile, so composed work must skip it rather than fail.
    const workers = await resolveWorkers({
      projectDir: "/proj",
      discoverWorkers: async () => [target("api"), target("web")],
      loadConfig: configs({ "/proj/apps/api": API }),
    });
    expect(workers.map((w) => w.name)).toEqual(["api"]);
  });

  test("surfaces a config that exists but fails to load — never reports it as 'no workers'", async () => {
    // Regression: every worker's config failing (typically uninstalled dependencies) used to be swallowed by
    // the dev-only-process skip, so a project with two real workers reported "No workers here." and hid the
    // actual cause. Only a genuinely absent config is skippable.
    const failure = resolveWorkers({
      projectDir: "/proj",
      discoverWorkers: async () => [target("api"), target("collab")],
      loadConfig: async () => {
        throw new InternalError({
          message: "Could not load /proj/apps/api/pithy.config.ts.",
          action: "Install the project's dependencies (e.g. bun install).",
        });
      },
    });
    await expect(failure).rejects.toThrow(/Could not load/);
  });

  test("a project with no workers is an actionable error", async () => {
    await expect(resolveWorkers({ projectDir: "/proj", discoverWorkers: async () => [] })).rejects.toThrow(
      NotFoundError,
    );
  });

  test("an unknown --worker names the ones that exist", async () => {
    await expect(
      resolveWorkers({
        projectDir: "/proj",
        worker: "ghost",
        discoverWorkers: async () => [target("api")],
        loadConfig: configs({ "/proj/apps/api": API }),
      }),
    ).rejects.toThrow(/No worker named "ghost"/);
  });
});

describe("projectCapabilities", () => {
  /** A resolved worker carrying just the capabilities — the only field this helper reads. */
  function resolved(name: string, capabilities: ReturnType<typeof defineCapability>[]): ResolvedWorker {
    return {
      name,
      dir: `/proj/apps/${name}`,
      config: { capabilities },
      capabilities,
      target: target(name),
    };
  }

  test("unions every worker's capabilities, deduped by name, in discovery order", () => {
    const auth = defineCapability({ name: "auth", requiredBindings: [] });
    const authAgain = defineCapability({ name: "auth", requiredBindings: [] });
    const media = defineCapability({ name: "media", requiredBindings: [] });

    const capabilities = projectCapabilities([resolved("api", [auth]), resolved("collab", [authAgain, media])]);

    // One entry per name: a capability two Workers compose ships one migration namespace, not two.
    expect(capabilities).toEqual([auth, media]);
  });

  test("keeps every binding when two workers compose one capability with different config", () => {
    // Capability config decides what a capability binds: `media()` records to D1, `media({recordStore:"kv"})`
    // adds a KV namespace. Keeping only the first Worker's instance dropped MEDIA from the union
    // `pithy feature` provisions from, so the KV namespace was never created and collab deployed with its
    // record store unbound — provision exiting 0 all the while.
    const media = defineCapability({
      name: "media",
      requiredBindings: [
        { type: "d1", name: "DB" },
        { type: "r2", name: "MEDIA_BUCKET" },
      ] satisfies BindingSpecInput[],
    });
    const mediaKv = defineCapability({
      name: "media",
      requiredBindings: [
        { type: "d1", name: "DB" },
        { type: "r2", name: "MEDIA_BUCKET" },
        { type: "kv", name: "MEDIA" },
      ] satisfies BindingSpecInput[],
    });

    const capabilities = projectCapabilities([resolved("api", [media]), resolved("collab", [mediaKv])]);

    // Still one entry — one migration namespace, not two — but no declared binding is lost.
    expect(capabilities.map((capability) => capability.name)).toEqual(["media"]);
    expect(capabilities[0]?.requiredBindings.map((binding) => binding.name)).toEqual(["DB", "MEDIA_BUCKET", "MEDIA"]);
  });

  test("identical instances are not copied — the first one is returned as-is", () => {
    const audit = defineCapability({
      name: "audit",
      requiredBindings: [{ type: "d1", name: "DB" }] satisfies BindingSpecInput[],
    });
    const auditAgain = defineCapability({
      name: "audit",
      requiredBindings: [{ type: "d1", name: "DB" }] satisfies BindingSpecInput[],
    });

    expect(projectCapabilities([resolved("api", [audit]), resolved("collab", [auditAgain])])[0]).toBe(audit);
  });

  test("a project with no capabilities anywhere yields an empty list", () => {
    expect(projectCapabilities([resolved("api", [])])).toEqual([]);
  });
});

describe("resolveSingleWorker", () => {
  test("uses the only worker without ceremony", async () => {
    const worker = await resolveSingleWorker({
      projectDir: "/proj",
      discoverWorkers: async () => [target("api")],
      loadConfig: configs({ "/proj/apps/api": API }),
    });
    expect(worker.name).toBe("api");
  });

  test("--worker picks one when several exist", async () => {
    const worker = await resolveSingleWorker({
      projectDir: "/proj",
      worker: "collab",
      discoverWorkers: async () => [target("api"), target("collab")],
      loadConfig: configs({ "/proj/apps/api": API, "/proj/apps/collab": COLLAB }),
    });
    expect(worker.name).toBe("collab");
  });

  test("several workers and no --worker never guesses — it errors, naming them", async () => {
    // Guessing would put bindings and DO class migrations on the wrong script.
    const error = await resolveSingleWorker({
      projectDir: "/proj",
      discoverWorkers: async () => [target("api"), target("collab")],
      loadConfig: configs({ "/proj/apps/api": API, "/proj/apps/collab": COLLAB }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ValidationError);
    // The action line tells an agent exactly what to pass, and which names are valid.
    expect((error as ValidationError).payload.action).toMatch(/--worker <name>.*api, collab/s);
  });

  test("prompts when one is offered (an interactive run)", async () => {
    const worker = await resolveSingleWorker({
      projectDir: "/proj",
      discoverWorkers: async () => [target("api"), target("collab")],
      loadConfig: configs({ "/proj/apps/api": API, "/proj/apps/collab": COLLAB }),
      prompt: async (choices) => choices[1]?.name ?? "",
    });
    expect(worker.name).toBe("collab");
  });
});
