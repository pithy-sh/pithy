// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { describe, expect, test } from "vitest";
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

  test("several Workers and none named is the resolver's own refusal, never a guess", async () => {
    await expect(resolveCapabilityWorker({ ...seams, name: "vector", is: isVector })).rejects.toMatchObject({
      payload: { action: expect.stringContaining("--worker") },
    });
  });
});
