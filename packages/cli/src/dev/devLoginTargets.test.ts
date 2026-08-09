// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { devLoginTargets, type StartedWorkerDir } from "./devLoginTargets";

const API: StartedWorkerDir = { name: "api", dir: "/p/apps/api", origin: "http://localhost:8787" };
const ADMIN: StartedWorkerDir = { name: "admin", dir: "/p/apps/admin", origin: "http://localhost:8788" };
const WEB: StartedWorkerDir = { name: "web", dir: "/p/apps/web", origin: "http://localhost:8789" };

/** `composesAuth`/`hasUi` from a set of directories, so a case reads as the project it describes. */
function inDirs(dirs: readonly StartedWorkerDir[]): (dir: string) => Promise<boolean> {
  const set = new Set(dirs.map((worker) => worker.dir));
  return async (dir) => set.has(dir);
}

describe("which worker `l` opens", () => {
  test("is the one that composes auth — the only one whose origin the cookie is set on", async () => {
    const targets = await devLoginTargets({
      started: [WEB, API],
      composesAuth: inDirs([API]),
      hasUi: inDirs([WEB]),
    });
    expect(targets).toEqual([{ name: "api", origin: "http://localhost:8787" }]);
  });

  test("is none when no started worker composes auth", async () => {
    const targets = await devLoginTargets({
      started: [WEB],
      composesAuth: inDirs([]),
      hasUi: inDirs([WEB]),
    });
    expect(targets).toEqual([]);
  });

  test("narrows to the UI-carrying one when several compose auth", async () => {
    const targets = await devLoginTargets({
      started: [API, ADMIN],
      composesAuth: inDirs([API, ADMIN]),
      hasUi: inDirs([ADMIN]),
    });
    expect(targets).toEqual([{ name: "admin", origin: "http://localhost:8788" }]);
  });

  test("returns them all rather than guessing when the UI signal does not decide", async () => {
    const none = await devLoginTargets({
      started: [API, ADMIN],
      composesAuth: inDirs([API, ADMIN]),
      hasUi: inDirs([]),
    });
    expect(none.map((target) => target.name)).toEqual(["api", "admin"]);

    const both = await devLoginTargets({
      started: [API, ADMIN],
      composesAuth: inDirs([API, ADMIN]),
      hasUi: inDirs([API, ADMIN]),
    });
    expect(both.map((target) => target.name)).toEqual(["api", "admin"]);
  });

  test("keeps the started order, so the printed choices match the started banner", async () => {
    const targets = await devLoginTargets({
      started: [ADMIN, API],
      composesAuth: inDirs([API, ADMIN]),
      hasUi: inDirs([]),
    });
    expect(targets.map((target) => target.name)).toEqual(["admin", "api"]);
  });

  test("a worker whose config will not load carries nothing — wrangler reports that, not this", async () => {
    const targets = await devLoginTargets({
      started: [API],
      composesAuth: () => Promise.reject(new Error("pithy.config.ts is broken")),
      hasUi: inDirs([]),
    });
    expect(targets).toEqual([]);
  });
});
