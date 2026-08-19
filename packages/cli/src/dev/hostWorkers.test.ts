// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { parse } from "comment-json";
import { describe, expect, test } from "vitest";
import type { WorkerTarget } from "../project/workers";
import { discoverHostWorkers, hostWorkerDir, materializeHostConfigs } from "./hostWorkers";

/** Two app Workers, the shape `discoverWorkers` hands back. */
const apps: WorkerTarget[] = [
  { name: "api", dir: "/proj/apps/api", hasWrangler: true, dev: { autostart: true, readySignal: "Ready on" } },
  { name: "web", dir: "/proj/apps/web", hasWrangler: false, dev: { autostart: true, readySignal: "ready in" } },
];

/** A composed capability, minimally what discovery matches on. */
const capability = (name: string): Capability => ({ name }) as Capability;

/** Discovery driven off a stubbed composition rather than a real `pithy.config.ts`. */
function discover(composed: Record<string, string[]>, workers = apps) {
  return discoverHostWorkers({
    projectDir: "/proj",
    workers,
    capabilitiesFor: async (dir) => (composed[dir] ?? []).map(capability),
  });
}

describe("discoverHostWorkers", () => {
  test("a capability that hosts Workflows becomes a dev-set worker named for the capability", async () => {
    const found = await discover({ "/proj/apps/api": ["auth", "email"] });
    expect(found.hosts.map((h) => h.worker.name)).toEqual(["email"]);
    // The name is the wire: `buildWorkerEnv` derives `EMAIL_ORIGIN` from it, and that is the address
    // the loopback dispatcher reads. Anything else and the app Worker looks up a key nobody publishes.
    expect(found.hosts[0]?.worker.dir).toBe(hostWorkerDir("/proj", "email"));
    expect(found.hosts[0]?.worker.dev?.autostart).toBe(true);
    expect(found.hosts[0]?.worker.hasWrangler).toBe(true);
  });

  test("a capability that hosts none contributes nothing", async () => {
    expect((await discover({ "/proj/apps/api": ["auth", "turnstile", "audit"] })).hosts).toEqual([]);
  });

  test("two Workers composing one capability share its single host", async () => {
    const found = await discover({ "/proj/apps/api": ["email"], "/proj/apps/web": ["email", "media"] });
    expect(found.hosts.map((h) => h.worker.name)).toEqual(["email", "media"]);
  });

  test("a Worker whose config will not load is survived, and said out loud", async () => {
    const found = await discoverHostWorkers({
      projectDir: "/proj",
      workers: apps,
      capabilitiesFor: async (dir) => {
        if (dir === "/proj/apps/web") throw new Error("no pithy.config.ts");
        return [capability("email")];
      },
    });
    expect(found.hosts.map((h) => h.worker.name)).toEqual(["email"]);
    expect(found.notes.join(" ")).toContain("web");
  });

  test("an apps/ Worker already holding a host's name is refused, never silently shadowed", async () => {
    await expect(
      discover({ "/proj/apps/api": ["email"] }, [
        { name: "email", dir: "/proj/apps/email", hasWrangler: true, dev: { autostart: true, readySignal: "x" } },
        ...apps,
      ]),
    ).rejects.toThrow(ValidationError);
  });
});

describe("materializeHostConfigs", () => {
  /** A minimal template standing in for a capability's committed one. */
  const template: WorkflowHostTemplate = {
    name: "pithy-email",
    main: "./worker.ts",
    d1_databases: [{ binding: "DB", database_name: "pithy-app", database_id: "<filled-at-provision>" }],
    secrets_store_secrets: [
      { binding: "SECRETS_ENCRYPTION_KEYS", store_id: "<filled-at-provision>", secret_name: "<filled-at-provision>" },
    ],
    vars: { BASE_URL: "<filled-at-provision>" },
  };

  async function run() {
    const projectDir = await mkdtemp(join(tmpdir(), "pithy-hosts-"));
    const hosts = (await discover({ "/proj/apps/api": ["email"] })).hosts.map((host) => ({
      ...host,
      worker: { ...host.worker, dir: hostWorkerDir(projectDir, host.capability) },
    }));
    const result = await materializeHostConfigs({
      projectDir,
      project: "acme",
      baseUrl: "http://localhost:8787",
      hosts,
      // The registry's real resolver, driven against a fixture template rather than the file on disk.
      readTemplate: async () => structuredClone(template),
    });
    const path = join(hostWorkerDir(projectDir, "email"), "wrangler.jsonc");
    const written = parse(await readFile(path, "utf8")) as unknown as WorkflowHostTemplate;
    await rm(projectDir, { recursive: true, force: true });
    return { written, result };
  }

  test("writes a config with nothing left for provisioning to fill", async () => {
    const { written } = await run();
    expect(JSON.stringify(written)).not.toMatch(/<filled[^>]*>/);
  });

  test("resolves main to an absolute path, because the config sits nowhere near the entry", async () => {
    const { written } = await run();
    expect(isAbsolute(written.main)).toBe(true);
    expect(written.main.endsWith("worker.ts")).toBe(true);
  });

  test("drops the Secrets Store block — dev has no store, and the master key is a .dev.vars value", async () => {
    const { written } = await run();
    expect(written.secrets_store_secrets).toBeUndefined();
  });

  test("gives every database the binding as its id, so it opens what pithy migrate --env dev filled", async () => {
    const { written } = await run();
    expect(written.d1_databases).toEqual([{ binding: "DB", database_name: "pithy-app", database_id: "DB" }]);
  });

  test("stamps the app's local origin as the base URL callback links are built against", async () => {
    const { written, result } = await run();
    expect(written.vars?.BASE_URL).toBe("http://localhost:8787");
    expect(written.vars?.ENVIRONMENT).toBe("dev");
    expect(result).toEqual({ notes: [], failed: [] });
  });

  test("a host that could not be resolved is named and reported as failed, not merely noted", async () => {
    // The caller has to be able to drop it from the dev set. A host whose resolution threw has no
    // directory at all, so starting `wrangler dev` in it fails on the spawn and takes the session with
    // it — which is the opposite of the "it will not run" the note already promised.
    const projectDir = await mkdtemp(join(tmpdir(), "pithy-hosts-"));
    const hosts = (await discover({ "/proj/apps/api": ["email"] })).hosts.map((host) => ({
      ...host,
      worker: { ...host.worker, dir: hostWorkerDir(projectDir, host.capability) },
    }));
    const result = await materializeHostConfigs({
      projectDir,
      project: "acme",
      baseUrl: "http://localhost:8787",
      hosts,
      readTemplate: async () => {
        throw new ValidationError({ message: "no template here." });
      },
    });
    await rm(projectDir, { recursive: true, force: true });
    expect(result.failed).toEqual(["email"]);
    expect(result.notes[0]).toBe("email: its host worker could not be resolved, so it will not run.");
  });
});
