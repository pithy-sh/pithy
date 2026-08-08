// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CreateCliAuditOptions } from "../audit/cliAudit";
import type { WorkerConfig } from "../project/config";
import type { WorkerTarget } from "../project/workers";
import add, { buildAudit, targetWorker } from "./add";

/** Discovery seam: the `apps/*` set, without a filesystem. */
function discovery(...names: string[]) {
  return async (): Promise<WorkerTarget[]> => names.map((name) => ({ name, dir: `/project/apps/${name}` }));
}

/** Config seam: every worker composes nothing — this suite is about *which* worker, not what's in it. */
const loadConfig = async (): Promise<WorkerConfig> => ({ capabilities: [] });

describe("add command", () => {
  test("meta and args shape — --worker names the worker to wire", () => {
    const args = add.args as Record<string, { type: string; default?: unknown; required?: boolean }>;
    expect(add.meta).toMatchObject({ name: "add" });
    expect(Object.keys(args)).toEqual(["capability", "list", "worker", "set", "eject", "force", "json"]);
    expect(args.capability).toMatchObject({ type: "positional", required: false });
    expect(args.worker).toMatchObject({ type: "string" });
    expect(args.json).toMatchObject({ type: "boolean", default: false });
  });
});

describe("buildAudit", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("looks the audit database up from the project root, narrowed to the target worker", async () => {
    // The audit database is discovered by enumerating `<projectDir>/apps`, so `projectDir` must be the
    // project root. Passing the Worker's own directory finds no `apps/` beneath it, and every add/remove
    // event is silently dropped — the Worker is named through `worker`, which is what narrows the lookup.
    const projectDir = await mkdtemp(join(tmpdir(), "pithy-add-audit-"));
    // Through the environment: the credentials are account-scoped since #182, so a `.dev.vars` in the
    // project supplies nothing. The overlay is what CI uses and needs no config directory here.
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
    const seen: CreateCliAuditOptions[] = [];
    try {
      const emit = await buildAudit({
        projectDir,
        worker: "api",
        env: "staging", // the shape `pithy remove --drop --env staging` builds
        capabilities: [],
        create: async (options) => {
          seen.push(options);
          return async () => {};
        },
      });

      expect(seen).toHaveLength(1);
      expect(seen[0]?.projectDir).toBe(projectDir);
      expect(seen[0]?.projectDir).not.toBe(join(projectDir, "apps", "api"));
      expect(seen[0]?.worker).toBe("api");
      expect(seen[0]?.env).toBe("staging");
      // Always callable, whatever the factory returned.
      await expect(emit({ action: "capability/removed", outcome: "success" })).resolves.toBeUndefined();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("is an inert emitter — and builds nothing — without Cloudflare credentials", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    const projectDir = await mkdtemp(join(tmpdir(), "pithy-add-audit-"));
    try {
      const emit = await buildAudit({
        projectDir,
        worker: "api",
        env: "dev",
        capabilities: [],
        create: async () => {
          throw new Error("must not build an emitter without credentials");
        },
      });
      await expect(emit({ action: "capability/added", outcome: "success" })).resolves.toBeUndefined();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

describe("targetWorker", () => {
  test("a single-worker project needs no --worker", async () => {
    const target = await targetWorker({
      projectDir: "/project",
      interactive: false,
      discoverWorkers: discovery("api"),
      loadConfig,
    });
    expect(target.name).toBe("api");
    expect(target.dir).toBe("/project/apps/api");
  });

  test("--worker picks one out of several", async () => {
    const target = await targetWorker({
      projectDir: "/project",
      worker: "edge",
      interactive: false,
      discoverWorkers: discovery("api", "edge"),
      loadConfig,
    });
    expect(target.dir).toBe("/project/apps/edge");
  });

  test("several workers and no --worker fails non-interactively, naming them", async () => {
    // The `--json` / no-TTY path: an agent gets told exactly what to pass, never a prompt it can't answer.
    const failure = await targetWorker({
      projectDir: "/project",
      interactive: false,
      discoverWorkers: discovery("api", "edge"),
      loadConfig,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ValidationError);
    expect((failure as ValidationError).payload.action).toContain("--worker");
    expect((failure as ValidationError).payload.action).toContain("api, edge");
  });

  test("an unknown --worker fails, naming the known ones", async () => {
    const failure = await targetWorker({
      projectDir: "/project",
      worker: "ghost",
      interactive: false,
      discoverWorkers: discovery("api", "edge"),
      loadConfig,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NotFoundError);
    expect((failure as NotFoundError).payload.message).toContain("ghost");
  });

  test("a project with no workers fails with the worker-add action", async () => {
    // A real project root (it has a pithy.config.ts) that simply holds no workers yet.
    const projectDir = await mkdtemp(join(tmpdir(), "pithy-add-noworkers-"));
    await writeFile(join(projectDir, "pithy.config.ts"), 'export default { name: "acme" };\n');
    try {
      const failure = await targetWorker({
        projectDir,
        interactive: false,
        discoverWorkers: discovery(),
        loadConfig,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(NotFoundError);
      expect((failure as NotFoundError).payload.action).toContain("pithy worker add");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("outside a project entirely, it points at pithy init instead", async () => {
    // Being in the wrong directory is a different problem from having no workers — don't conflate them.
    const failure = await targetWorker({
      projectDir: join(tmpdir(), "pithy-not-a-project-at-all"),
      interactive: false,
      discoverWorkers: discovery(),
      loadConfig,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NotFoundError);
    expect((failure as NotFoundError).payload.action).toContain("pithy init");
  });
});
