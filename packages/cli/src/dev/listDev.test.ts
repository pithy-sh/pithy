// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test, vi } from "vitest";
import { buildDevConfig, type DevConfig } from "../feature/devConfig";
import type { WorkerTarget } from "../project/workers";
import type { HostWorker } from "./hostWorkers";
import { devListingRows, type ListDevOptions, listDevSet } from "./listDev";

const api: WorkerTarget = {
  name: "api",
  dir: "/proj/apps/api",
  hasWrangler: true,
  dev: { readySignal: "Ready on https?://" },
};
const web: WorkerTarget = {
  name: "web",
  dir: "/proj/apps/web",
  hasWrangler: false,
  dev: { readySignal: "ready in \\d+", command: ["vite"] },
};

const emailHost = {
  capability: "email",
  spec: { capability: "email" },
  sourceDir: "/proj/apps/api",
  worker: {
    name: "email",
    dir: "/proj/.wrangler/pithy/hosts/email",
    hasWrangler: true,
    dev: { readySignal: "Ready on https?://" },
  },
} as unknown as HostWorker;

const block = { block: 0, base: 8787, size: 10 };

/** A config pinning all three members, as a settled project has. */
const pinned: DevConfig = {
  version: 1,
  branch: "feature/536-dev-list-app",
  ports: { index: 0, base: 8787, size: 10 },
  workers: {
    api: { port: 8787, origin: "http://localhost:8787" },
    web: { port: 8788, origin: "http://localhost:8788" },
    email: { port: 8789, origin: "http://localhost:8789" },
  },
};

function options(overrides: Partial<ListDevOptions> = {}): ListDevOptions {
  return {
    projectDir: "/proj",
    discoverWorkers: async () => [api, web],
    projectName: async () => "acme",
    discoverHostWorkers: async () => ({ hosts: [emailHost], notes: [] }),
    loadDevConfig: async () => pinned,
    ...overrides,
  };
}

describe("listDevSet", () => {
  test("reports every member, marked by kind, carrying its pinned port", async () => {
    const listing = await listDevSet(options());

    expect(listing.members).toEqual([
      {
        name: "api",
        kind: "app",
        autostart: true,
        autostartLocal: false,
        starts: true,
        port: 8787,
        origin: "http://localhost:8787",
      },
      {
        name: "web",
        kind: "app",
        autostart: true,
        autostartLocal: false,
        starts: true,
        port: 8788,
        origin: "http://localhost:8788",
      },
      {
        name: "email",
        kind: "host",
        autostart: true,
        autostartLocal: false,
        starts: true,
        port: 8789,
        origin: "http://localhost:8789",
      },
    ]);
  });

  // The listing is where a developer checks what a run would do, so it has to show the branch's answer
  // *and* say it is the branch's — `off here` is the difference between a file everyone shares and one
  // that is yours. Asserted through the rendered row, because that string is the whole of the signal.
  test("marks a member this branch turned off, and says the answer is local", async () => {
    const listing = await listDevSet({ ...options(), autostartOverrides: { web: false } });

    const web = listing.members.find((m) => m.name === "web");
    expect(web).toMatchObject({ autostart: false, autostartLocal: true, starts: false });
    expect(devListingRows(listing).find((r) => r.name === "web")?.description).toContain("off here");
  });

  // The other side of that string, and the reason it is conditional: `--app` narrowing a run is not the
  // branch saying anything, so a row skipped by `--app` must not claim it was turned off here.
  test("a member skipped only by --app is not reported as turned off here", async () => {
    const listing = await listDevSet({ ...options(), apps: ["api"] });

    const web = listing.members.find((m) => m.name === "web");
    expect(web).toMatchObject({ autostart: true, autostartLocal: false, starts: false });
    expect(devListingRows(listing).find((r) => r.name === "web")?.description).not.toContain("off here");
  });

  /**
   * A member added since the last run has no pin yet, and the port it reports is not a guess: the same
   * pure `buildDevConfig` call the next run makes decides it. Asserted against that function rather than
   * a literal, because a literal would still pass if the projection stopped agreeing with the run.
   */
  test("a member the config has never pinned reports the port the next run would give it", async () => {
    const job: WorkerTarget = { name: "job", dir: "/proj/apps/job", hasWrangler: true };
    const listing = await listDevSet(options({ discoverWorkers: async () => [api, web, job] }));

    const next = buildDevConfig({
      branch: pinned.branch,
      block,
      workers: [api, web, job, emailHost.worker],
      previous: pinned,
    });

    expect(listing.members.find((m) => m.name === "job")?.port).toBe(next.workers.job?.port);
    // And nobody already pinned moved to make room.
    expect(listing.members.find((m) => m.name === "api")?.port).toBe(8787);
    expect(listing.members.find((m) => m.name === "web")?.port).toBe(8788);
  });

  test("a project that has never run pithy dev reports no ports, and says why", async () => {
    const listing = await listDevSet(options({ loadDevConfig: async () => null }));

    expect(listing.members.map((m) => [m.port, m.origin])).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);
    expect(listing.notes).toContain("No .dev.config.json yet, so no port is pinned. The first pithy dev assigns them.");
  });

  // A plain run starts everything now, so what this asserts is the other half: the branch's answer is
  // the only thing that subtracts from it, and the listing reflects that rather than a manifest key.
  test("marks what a plain run would start, and lists what it would not", async () => {
    expect((await listDevSet(options())).members.map((m) => [m.name, m.starts])).toEqual([
      ["api", true],
      ["web", true],
      ["email", true],
    ]);

    const narrowed = await listDevSet(options({ autostartOverrides: { web: false } }));
    expect(narrowed.members.map((m) => [m.name, m.starts])).toEqual([
      ["api", true],
      ["web", false],
      ["email", true],
    ]);
  });

  // The whole set, always. A listing that echoed the flag back would not answer the question `--list`
  // exists for: what does that selection actually give me, out of everything there is.
  test("with --app it still lists every member, marking only the named ones as starting", async () => {
    const listing = await listDevSet(options({ apps: ["web"] }));

    expect(listing.members.map((m) => [m.name, m.starts])).toEqual([
      ["api", false],
      ["web", true],
      ["email", false],
    ]);
  });

  test("an unknown --app name refuses the listing too", async () => {
    await expect(listDevSet(options({ apps: ["nope"] }))).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a project with no name lists no hosts, and carries the note saying why", async () => {
    const listing = await listDevSet(options({ projectName: async () => null }));

    expect(listing.members.map((m) => m.name)).toEqual(["api", "web"]);
    expect(listing.notes[0]).toContain("No project name in pithy.config.ts");
  });

  test("reads the dev config once and writes nothing", async () => {
    const load = vi.fn(async () => pinned);
    await listDevSet(options({ loadDevConfig: load }));

    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("/proj");
  });
});

describe("devListingRows", () => {
  const rowFor = async (overrides: Partial<ListDevOptions> = {}) =>
    devListingRows(await listDevSet(options(overrides)));

  test("names each member, its kind, whether it starts, and its port", async () => {
    expect(await rowFor()).toEqual([
      { name: "api", description: "app   starts   port 8787" },
      { name: "web", description: "app   starts   port 8788" },
      { name: "email", description: "host  starts   port 8789" },
    ]);
  });

  // `off here` is the only thing distinguishing "this branch turned it off" from "--app did not name
  // it", and both render as `skipped`. Without the suffix a reader goes looking for a committed file.
  test("a member this branch turned off says so on its row", async () => {
    expect(await rowFor({ autostartOverrides: { web: false } })).toEqual([
      { name: "api", description: "app   starts   port 8787" },
      { name: "web", description: "app   skipped  port 8788  off here" },
      { name: "email", description: "host  starts   port 8789" },
    ]);
  });

  test("an unpinned member's port reads as a dash rather than a number it does not have", async () => {
    const rows = await rowFor({ loadDevConfig: async () => null });

    expect(rows[0]?.description).toBe("app   starts   port —");
  });
});

/**
 * The listing and the run must not drift. Both resolve membership through `resolveDevSet` and both
 * compute ports through `buildDevConfig`, and this is what proves the two agree — including for a member
 * added since the last run, which is the only case where the two could differ and nobody would notice.
 */
describe("the listing is what a run would start", () => {
  test("every member's reported port is the one the next run pins", async () => {
    const job: WorkerTarget = { name: "job", dir: "/proj/apps/job", hasWrangler: true };
    const listing = await listDevSet(options({ discoverWorkers: async () => [api, web, job] }));

    const next = buildDevConfig({
      branch: pinned.branch,
      block,
      workers: [api, web, job, emailHost.worker],
      previous: pinned,
    });

    expect(Object.fromEntries(listing.members.map((m) => [m.name, m.port]))).toEqual(
      Object.fromEntries(Object.entries(next.workers).map(([name, w]) => [name, w.port])),
    );
  });
});
