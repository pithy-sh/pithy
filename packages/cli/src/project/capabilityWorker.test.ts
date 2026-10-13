// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { fixOf } from "../terminal/exitClass";
import { resolveCapabilityWorker } from "./capabilityWorker";
import type { WorkerConfig } from "./config";

/**
 * **The capability is read off the Worker the command writes into** (#590 review).
 *
 * The seams stand in for `apps/`: `api` composes one `vector`, `web` composes another with different
 * options, and `docs` composes nothing. A resolver that borrowed the first composer's config answers `api`'s
 * for `--worker web`, and one that did not check composition answers something for `--worker docs`.
 */

/** A capability instance carrying which Worker's config it came from. */
function vector(owner: string): Capability & { owner: string } {
  return { name: "vector", requiredBindings: [], owner };
}

function isVector(capability: Capability): capability is Capability & { owner: string } {
  return capability.name === "vector";
}

const configs: Record<string, WorkerConfig> = {
  "/proj/apps/api": { capabilities: [vector("api")] } as unknown as WorkerConfig,
  "/proj/apps/web": { capabilities: [vector("web")] } as unknown as WorkerConfig,
  "/proj/apps/docs": { capabilities: [] } as unknown as WorkerConfig,
};

const seams = {
  projectDir: "/proj",
  discoverWorkers: async () => [
    { name: "api", dir: "/proj/apps/api" },
    { name: "web", dir: "/proj/apps/web" },
    { name: "docs", dir: "/proj/apps/docs" },
  ],
  loadConfig: async (dir: string) => configs[dir] as WorkerConfig,
};

describe("resolveCapabilityWorker", () => {
  test("--worker names the Worker, and the capability is that Worker's, not the first composer's", async () => {
    const { worker, capability } = await resolveCapabilityWorker({
      ...seams,
      worker: "web",
      name: "vector",
      is: isVector,
    });

    expect(worker.dir).toBe("/proj/apps/web");
    expect(capability.owner).toBe("web");
  });

  test("a named Worker that does not compose the capability is refused by name", async () => {
    await expect(
      resolveCapabilityWorker({ ...seams, worker: "docs", name: "vector", is: isVector }),
    ).rejects.toMatchObject({
      payload: {
        code: "validation/invalid_input",
        message: "docs does not compose the vector capability.",
        action: expect.stringContaining("--worker"),
      },
    });
  });

  // Named, a different --worker is the fix, so it stays exit 2 (above). Unnamed, the one Worker there is lacks
  // it: the project is missing what the call depends on, exit 3, and pithy add is the step (#697).
  test("the only Worker, unnamed, not composing the capability is a precondition with pithy add as its fix", async () => {
    const only = { ...seams, discoverWorkers: async () => [{ name: "docs", dir: "/proj/apps/docs" }] };
    const failure = (await resolveCapabilityWorker({ ...only, name: "vector", is: isVector }).catch(
      (error: unknown) => error,
    )) as PithyError;
    expect(failure.payload).toMatchObject({
      code: "core/precondition_failed",
      message: "docs does not compose the vector capability.",
    });
    // No manifest is installed under /proj, so the kit's own says what vector needs: nothing first (#711).
    expect(fixOf(failure)).toBe("pithy add vector --worker docs");
  });

  test("the fix and the action name the apps/ directory, never the deployed script name", async () => {
    const only = { ...seams, discoverWorkers: async () => [{ name: "demo-docs", dir: "/proj/apps/docs" }] };
    const failure = (await resolveCapabilityWorker({ ...only, name: "vector", is: isVector }).catch(
      (error: unknown) => error,
    )) as PithyError;
    expect(fixOf(failure)).toBe("pithy add vector --worker docs");
    expect(failure.payload.action).toContain("pithy add vector --worker docs");
    expect(failure.payload.action).not.toContain("demo-docs");
  });

  test("several Workers and none named is the resolver's own refusal, never a guess", async () => {
    await expect(resolveCapabilityWorker({ ...seams, name: "vector", is: isVector })).rejects.toMatchObject({
      payload: { action: expect.stringContaining("--worker") },
    });
  });
});
