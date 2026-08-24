// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { email } from "@pithy-sh/email/src/capability";
import { catalogsFromEnv } from "@pithy-sh/email/src/templates/messages";
import { i18n } from "@pithy-sh/i18n/src/capability";
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

/**
 * **The local host has to speak the languages the deployed one does.**
 *
 * `pithy dev` materialises the same host `pithy email provision` deploys, from the same committed
 * template through the same resolver — so the same thing has to reach it. The catalogs come off the
 * composed email capability's `hostCatalogs()`, and that value answers `{}` until every capability's
 * `compose` hook has run. Discovery built its capability set and read that value without running them,
 * which meant the app Worker enqueued a Spanish subject and stored `locale='es'` while the local host
 * re-rendered in English — and, because `runSend` overwrites the stored subject with its own render,
 * threw the Spanish one away. That is the two-Workers-disagree failure the var exists to close,
 * reproduced on a developer's machine (pithy-sh/pithy#441).
 *
 * Driven through the **real** registry entry and the **real** committed `wrangler.jsonc`: the seam
 * being proved is the whole path from `apps/<name>/pithy.config.ts` to a var on disk, and a fixture
 * template in the middle of it is a fixture of the thing under test.
 */
describe("a dev session for a project that speaks two languages", () => {
  async function materialize(...capabilities: Capability[]) {
    const projectDir = await mkdtemp(join(tmpdir(), "pithy-hosts-i18n-"));
    const found = await discoverHostWorkers({
      projectDir,
      workers: [apps[0] as WorkerTarget],
      capabilitiesFor: async () => capabilities,
    });
    const result = await materializeHostConfigs({
      projectDir,
      project: "acme",
      baseUrl: "http://localhost:8787",
      hosts: found.hosts,
    });
    const written = parse(
      await readFile(join(hostWorkerDir(projectDir, "email"), "wrangler.jsonc"), "utf8"),
    ) as unknown as WorkflowHostTemplate;
    await rm(projectDir, { recursive: true, force: true });
    return { written, result };
  }

  test("the local email host is written carrying the words it will render in", async () => {
    const { written, result } = await materialize(
      i18n({ supportedLocales: ["en", "es"] }),
      email({ fromAddress: "noreply@acme.test", baseUrl: "https://api.acme.test" }),
    );
    expect(result.failed).toEqual([]);

    const stamped = written.vars?.EMAIL_MESSAGES_ES;
    // Named first, so an unassembled capability reads as the absent var it is rather than as a parse
    // error twenty characters later.
    expect(stamped, "the local host was written with no `es` catalog var").toBeDefined();

    // Collected through the seam the host itself reads them with — a value this test can read and the
    // host cannot is not a value that was delivered.
    const carried = catalogsFromEnv(written.vars ?? {});
    expect(carried.es?.["email/welcome.subject"]).toBe("Te damos la bienvenida a {app}");
  });

  test("and a project with no i18n capability gets no var at all, which is the English it always sent", async () => {
    const { written } = await materialize(
      email({ fromAddress: "noreply@acme.test", baseUrl: "https://api.acme.test" }),
    );
    expect(written.vars?.EMAIL_MESSAGES_ES).toBeUndefined();
  });
});
