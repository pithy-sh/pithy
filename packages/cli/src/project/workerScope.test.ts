// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { InternalError, NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import type { WorkerConfig } from "./config";
import {
  isUnknown,
  projectCapabilities,
  projectCapabilitySet,
  type ResolvedWorker,
  resolveSingleWorker,
  resolveWorkerSet,
  resolveWorkers,
  resolveWorkersReporting,
} from "./workerScope";
import type { WorkerTarget } from "./workers";

/** A discovered worker target, as `discoverWorkers` would return it. */
function target(name: string, dir = `/proj/apps/${name}`): WorkerTarget {
  return { name, dir, dev: { autostart: true, readySignal: "Ready on https?://" }, hasWrangler: true };
}

/** A discovered non-Worker process — a Vite frontend joining the dev set through its manifest alone. */
function devOnly(name: string, dir = `/proj/apps/${name}`): WorkerTarget {
  return { name, dir, dev: { autostart: true, readySignal: "Ready on https?://" }, hasWrangler: false };
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
      discoverWorkers: async () => [target("api"), devOnly("web")],
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

  test("every worker missing its config says so — never 'No workers here.'", async () => {
    // The set is empty for a reason the old sentence denied: the project plainly has workers, and it sent
    // the reader to `pithy worker add` for Workers that already exist.
    const failure = resolveWorkers({
      projectDir: "/proj",
      discoverWorkers: async () => [target("api"), target("collab")],
      loadConfig: configs({}),
    });
    await expect(failure).rejects.toThrow(/missing its pithy\.config\.ts/);
    await expect(failure).rejects.toMatchObject({ payload: { action: expect.stringMatching(/api, collab/) } });
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

  test("--worker loads that worker's config and no other", async () => {
    // One unloadable config used to disable `pithy add` and `pithy remove` for every Worker in the
    // project — including when editing a healthy Worker was the way around the broken one. Naming a
    // Worker narrows *before* the load, so a sibling's config is never opened.
    const loaded: string[] = [];
    const worker = await resolveSingleWorker({
      projectDir: "/proj",
      worker: "collab",
      discoverWorkers: async () => [target("api"), target("collab")],
      loadConfig: async (dir) => {
        loaded.push(dir);
        if (dir.endsWith("/api")) throw new InternalError({ message: "Could not load api's config." });
        return COLLAB;
      },
    });

    expect(worker.name).toBe("collab");
    expect(loaded).toEqual(["/proj/apps/collab"]);
  });

  test("an unknown --worker names the ones that exist, without loading any config", async () => {
    // The "Known:" list comes from discovery, which needs no load — so the error is still actionable in
    // exactly the state a load would fail in.
    const error = await resolveSingleWorker({
      projectDir: "/proj",
      worker: "ghost",
      discoverWorkers: async () => [target("api"), target("collab")],
      loadConfig: async () => {
        throw new InternalError({ message: "must not load a config to name the workers" });
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).payload.action).toMatch(/Known: api, collab/);
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

describe("resolveWorkersReporting", () => {
  test("reports a discovered Worker whose pithy.config.ts is absent, rather than swallowing it", async () => {
    // `#454`'s guard closes "a config throws", not "a config is absent". A Worker whose `pithy.config.ts`
    // was deleted on the branch is a `wrangler.jsonc` with nothing to compose — so the resolved set is
    // *incomplete*, not merely smaller. `feature destroy`'s reconcile backstop scans the union's bindings,
    // so a silently missing Worker leaks every resource it declared while the run exits 0.
    const resolution = await resolveWorkersReporting({
      projectDir: "/proj",
      discoverWorkers: async () => [target("api"), target("collab")],
      loadConfig: configs({ "/proj/apps/api": API }),
    });

    expect(resolution.workers.map((w) => w.name)).toEqual(["api"]);
    expect(resolution.skipped.map((s) => s.name)).toEqual(["collab"]);
    expect(resolution.skipped[0]?.reason).toMatch(/no config in/);
  });

  test("a dev-only process is skipped silently — it is the ordinary state, not a gap", async () => {
    // A Vite frontend has no `wrangler.jsonc` and never had a `pithy.config.ts`. Reporting it would put a
    // permanent warning in front of every project with a frontend.
    const resolution = await resolveWorkersReporting({
      projectDir: "/proj",
      discoverWorkers: async () => [target("api"), devOnly("web")],
      loadConfig: configs({ "/proj/apps/api": API }),
    });

    expect(resolution.workers.map((w) => w.name)).toEqual(["api"]);
    expect(resolution.skipped).toEqual([]);
  });

  test("every Worker missing its config is reported, not refused — reporting is the whole job", async () => {
    // The refusal belongs to `resolveWorkers`, whose callers have only an array to read the fact from.
    const resolution = await resolveWorkersReporting({
      projectDir: "/proj",
      discoverWorkers: async () => [target("api"), target("collab")],
      loadConfig: configs({}),
    });
    expect(resolution.workers).toEqual([]);
    expect(resolution.skipped.map((s) => s.name)).toEqual(["api", "collab"]);
  });

  test("an ordinary project reports nothing skipped", async () => {
    const resolution = await resolveWorkersReporting({
      projectDir: "/proj",
      discoverWorkers: async () => [target("api"), target("collab")],
      loadConfig: configs({ "/proj/apps/api": API, "/proj/apps/collab": COLLAB }),
    });
    expect(resolution.skipped).toEqual([]);
    expect(resolution.workers.map((w) => w.name)).toEqual(["api", "collab"]);
  });
});

describe("resolveWorkerSet", () => {
  test("**a config that throws is unknowable, and carries the loader's own diagnosis**", async () => {
    // The reason travels with the refusal. A bare `null` made every caller invent a sentence, and each
    // invented the same wrong one — see the absent-config case below, which is not "will not load".
    const answered = await resolveWorkerSet({
      projectDir: "/proj",
      discoverWorkers: async () => [target("api")],
      loadConfig: async () => {
        throw new InternalError({ message: "Could not load /proj/apps/api/pithy.config.ts." });
      },
    });
    expect(isUnknown(answered)).toBe(true);
    expect(isUnknown(answered) && answered.unknown).toMatch(/Could not load \/proj\/apps\/api/);
  });

  test("**an absent config is unknowable too, and says *absent* — naming the worker**", async () => {
    // `#454`'s guard closes "a config throws", not "a config is absent", and reporting the second as the
    // first points the reader at a file that does not exist. The names come from `skipped`, which
    // `resolveWorkersReporting` already computed.
    const answered = await resolveWorkerSet({
      projectDir: "/proj",
      discoverWorkers: async () => [target("api"), target("collab")],
      loadConfig: configs({ "/proj/apps/api": API }),
    });
    expect(isUnknown(answered) && answered.unknown).toBe(
      "No pithy.config.ts in collab — every worker under apps/ needs one.",
    );
  });

  test("a project with no workers answers [] — nothing was ever named", async () => {
    const answered = await resolveWorkerSet({ projectDir: "/proj", discoverWorkers: async () => [] });
    expect(answered).toEqual([]);
    // An empty array and an unknowable set are different answers, and every caller branches on exactly that.
    expect(isUnknown(answered)).toBe(false);
  });

  test("a healthy project answers with its workers", async () => {
    const answered = await resolveWorkerSet({
      projectDir: "/proj",
      discoverWorkers: async () => [target("api"), target("collab")],
      loadConfig: configs({ "/proj/apps/api": API, "/proj/apps/collab": COLLAB }),
    });
    expect(isUnknown(answered)).toBe(false);
    expect(isUnknown(answered) ? [] : answered.map((worker) => worker.name)).toEqual(["api", "collab"]);
  });
});

describe("projectCapabilitySet", () => {
  test("a config that throws is unknowable rather than claiming the project composes nothing", async () => {
    // Null is *unknowable from here*, and the caller has to tell it from "none". An empty array would let
    // `feature destroy` report a clean remote teardown having deleted nothing, and `pithy deploy` ship
    // unaudited from a project that has audit composed.
    const answered = await projectCapabilitySet("/proj", {
      discoverWorkers: async () => [target("api")],
      loadConfig: async () => {
        throw new Error("this config will not load");
      },
    });
    expect(isUnknown(answered)).toBe(true);
  });

  test("a project with no Workers answers [], not unknowable — review of #454", async () => {
    expect(await projectCapabilitySet("/proj", { discoverWorkers: async () => [] })).toEqual([]);
  });

  test("a project whose Workers do load answers with their union", async () => {
    const auth = defineCapability({ name: "auth", requiredBindings: [] });
    const answered = await projectCapabilitySet("/proj", {
      discoverWorkers: async () => [target("api")],
      loadConfig: configs({ "/proj/apps/api": { capabilities: [auth] } as WorkerConfig }),
    });
    expect(answered).toEqual([auth]);
    // An empty array and an unknowable set are different answers, and the caller branches on exactly that.
    expect(isUnknown(answered)).toBe(false);
  });
});
