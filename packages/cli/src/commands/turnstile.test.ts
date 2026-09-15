// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { turnstile as turnstileCapability } from "@pithy-sh/turnstile/src/capability";
import type { ArgsDef, CommandDef } from "citty";
import { describe, expect, test } from "vitest";
import type { WorkerConfig } from "../project/config";
import turnstile, { resolveTurnstileTarget } from "./turnstile";

/** A widget's sitekeys, blank — what the target is resolved by is which modes a Worker declares. */
const SITEKEYS = { sitekeys: { dev: "", staging: "", prod: "" } };

/** The `provision` subcommand's arg definitions — citty holds them as a plain object here. */
function provisionArgs(): ArgsDef {
  const sub = turnstile.subCommands as Record<string, CommandDef>;
  return (sub.provision?.args ?? {}) as ArgsDef;
}

describe("pithy turnstile provision args", () => {
  test("the domain guard has a non-interactive opt-out, off by default", () => {
    const args = provisionArgs();
    expect(args["allow-shared-domain"]).toMatchObject({ type: "boolean", default: false });
  });

  test("every provision arg is agent-drivable — flags only, nothing required by prompt", () => {
    const args = provisionArgs();
    expect(Object.keys(args).sort()).toEqual(["allow-shared-domain", "json", "worker"]);
    for (const arg of Object.values(args)) expect(arg).not.toMatchObject({ required: true });
  });
});

/**
 * **The config is read from the Worker the sitekeys are written to** (#590).
 *
 * `loadTurnstileConfig` used to take the first Worker in the project composing turnstile, while every write
 * went to `resolveSingleWorker({ worker })`. With two Workers, the modes came from one and the sitekeys
 * landed in the other — a registration written for widgets it does not declare, and a Worker whose own
 * widgets were never provisioned.
 */
describe("resolveTurnstileTarget", () => {
  const targets = [
    { name: "api", dir: "/proj/apps/api" },
    { name: "web", dir: "/proj/apps/web" },
  ];
  const configs: Record<string, WorkerConfig> = {
    "/proj/apps/api": { capabilities: [turnstileCapability({ widgets: { visible: SITEKEYS } })] } as WorkerConfig,
    "/proj/apps/web": { capabilities: [turnstileCapability({ widgets: { invisible: SITEKEYS } })] } as WorkerConfig,
    "/proj/apps/docs": { capabilities: [] } as unknown as WorkerConfig,
  };
  const seams = {
    projectDir: "/proj",
    discoverWorkers: async () => [...targets, { name: "docs", dir: "/proj/apps/docs" }],
    loadConfig: async (dir: string) => configs[dir] as WorkerConfig,
  };

  test("--worker names the Worker whose modes are provisioned, not the first one composing turnstile", async () => {
    const { worker, config } = await resolveTurnstileTarget({ ...seams, worker: "web" });

    expect(worker.dir).toBe("/proj/apps/web");
    expect(Object.keys(config.widgets)).toEqual(["invisible"]);
  });

  test("a named Worker that does not compose turnstile is refused by name, not answered from a sibling", async () => {
    await expect(resolveTurnstileTarget({ ...seams, worker: "docs" })).rejects.toMatchObject({
      payload: { message: expect.stringContaining("docs") },
    });
  });
});
