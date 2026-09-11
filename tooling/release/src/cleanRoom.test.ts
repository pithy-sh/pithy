// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CleanRoomManifest,
  cleanRoomEnv,
  floorOf,
  isStalledStep,
  kitOverrides,
  STEP_TIMEOUT_MS,
  stalledStep,
  thirdPartyFloors,
} from "./cleanRoom";

describe("floorOf", () => {
  it("takes the version a caret range starts at", () => {
    expect(floorOf("^4.4.0")).toBe("4.4.0");
  });

  it("takes an exact version unchanged", () => {
    expect(floorOf("0.29.5")).toBe("0.29.5");
  });

  it("takes a tilde range's floor", () => {
    expect(floorOf("~1.2.3")).toBe("1.2.3");
  });

  it("takes a >= range's floor", () => {
    expect(floorOf(">=22.0.0")).toBe("22.0.0");
  });

  // `@pithy-sh/vite` declares `^6.1.0 || ^7.0.0 || ^8.0.0`. The floor of the whole promise is the
  // lowest version any arm admits — that is the one nothing currently tests.
  it("takes the lowest arm of an alternation", () => {
    expect(floorOf("^6.1.0 || ^7.0.0 || ^8.0.0")).toBe("6.1.0");
    expect(floorOf("^8.0.0 || ^6.1.0")).toBe("6.1.0");
  });

  it("has no floor for a wildcard, which promises nothing to pin", () => {
    expect(floorOf("*")).toBeNull();
    expect(floorOf("latest")).toBeNull();
  });

  // An npm alias — `"vite7": "npm:vite@7.0.0"` in the adopter fixture. The floor belongs to the
  // aliased package, and pinning it under the alias name would install the wrong thing.
  it("has no floor for an aliased dependency", () => {
    expect(floorOf("npm:vite@7.0.0")).toBeNull();
  });

  it("has no floor for a workspace, file or git range", () => {
    expect(floorOf("workspace:*")).toBeNull();
    expect(floorOf("file:../thing.tgz")).toBeNull();
    expect(floorOf("github:owner/repo")).toBeNull();
  });
});

describe("kitOverrides", () => {
  // A clean room must install the code we are about to publish, not the code we published last time.
  // `npm i ./cli.tgz` resolves `@pithy-sh/core@^0.1.2` from the registry, so without these the gate
  // would test a new CLI against old siblings and pass while the new ones were broken.
  it("points every kit package at its own tarball", () => {
    const packed = new Map([
      ["@pithy-sh/cli", "/packs/cli.tgz"],
      ["@pithy-sh/core", "/packs/core.tgz"],
    ]);

    expect(kitOverrides(packed)).toEqual({
      "@pithy-sh/cli": "file:/packs/cli.tgz",
      "@pithy-sh/core": "file:/packs/core.tgz",
    });
  });

  it("is empty when nothing was packed", () => {
    expect(kitOverrides(new Map())).toEqual({});
  });
});

describe("thirdPartyFloors", () => {
  const manifests: CleanRoomManifest[] = [
    { name: "@pithy-sh/core", dependencies: { zod: "^4.4.0", hono: "^4.13.2" } },
    { name: "@pithy-sh/cli", dependencies: { zod: "^4.4.0", citty: "^0.2.2" } },
  ];

  // The zod defect in #475 was invisible because the lockfile resolved above the floor. Installing at
  // the floor tests the promise the range actually makes, rather than the one version we happened to get.
  it("pins every third-party dependency to the floor its range declares", () => {
    expect(thirdPartyFloors(manifests)).toEqual({ zod: "4.4.0", hono: "4.13.2", citty: "0.2.2" });
  });

  // A kit package's range is rewritten to the tarball by `kitOverrides`; pinning it here would fight that.
  it("never pins a kit package", () => {
    const withKit: CleanRoomManifest[] = [
      { name: "@pithy-sh/cli", dependencies: { "@pithy-sh/core": "^0.1.2", zod: "^4.4.0" } },
    ];

    expect(thirdPartyFloors(withKit)).toEqual({ zod: "4.4.0" });
  });

  // Two packages declaring different floors for one dependency can only be installed at one of them,
  // and the lower is the one that tests the wider promise.
  it("takes the lowest floor when packages disagree", () => {
    const disagreeing: CleanRoomManifest[] = [
      { name: "a", dependencies: { kysely: "^0.29.5" } },
      { name: "b", dependencies: { kysely: "^0.29.0" } },
    ];

    expect(thirdPartyFloors(disagreeing)).toEqual({ kysely: "0.29.0" });
  });

  it("skips a range with no floor to pin", () => {
    expect(thirdPartyFloors([{ name: "a", dependencies: { anything: "*" } }])).toEqual({});
  });

  it("reads peerDependencies too, since an adopter installs those", () => {
    const peers: CleanRoomManifest[] = [{ name: "a", peerDependencies: { react: "^19.0.0" } }];

    expect(thirdPartyFloors(peers)).toEqual({ react: "19.0.0" });
  });

  it("ignores devDependencies, which a consumer never installs", () => {
    expect(thirdPartyFloors([{ name: "a", devDependencies: { vitest: "^4.1.0" } }])).toEqual({});
  });
});

/**
 * **The clean room's own bound, and the reason it needs one.**
 *
 * `bun add` deadlocked mid-install under `--floors` — no CPU, no child, no socket, both threads parked
 * in `epoll_wait` on nothing — and the gate had no bound but the CI runner's, so it held a job for
 * 1h42m and reported nothing at all. A gate that cannot fail cannot report. These two hold the halves
 * that stop it recurring: the run gets its own installer cache, and a step that stops answering is
 * killed and named.
 */
describe("the clean room's isolation and bound", () => {
  it("gives the run its own installer cache, inside the workspace", () => {
    // Inside the workspace, because the workspace is what the run deletes. A cache anywhere else is the
    // machine's, and a machine's cache is what carries every other install it has ever done.
    const env = cleanRoomEnv("/tmp/pithy-cleanroom-abc123");

    expect(env.BUN_INSTALL_CACHE_DIR).toBe(join("/tmp/pithy-cleanroom-abc123", "installer-cache"));
  });

  it("bounds a step, and kills one that stops answering rather than waiting on it", () => {
    // The real runner shape, with the real bound swapped for one a test can wait out. A child that never
    // exits is the failure being guarded against, so the test uses one rather than a mock of one.
    const stalled = () =>
      execFileSync("sleep", ["30"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 300,
        killSignal: "SIGKILL",
      });

    expect(stalled).toThrow();
    try {
      stalled();
      expect.unreachable("a child that never exits must not be waited on");
    } catch (cause) {
      expect(isStalledStep(cause)).toBe(true);
    }
  });

  it("does not read an ordinary failure as a stall — one answered, the other never did", () => {
    try {
      execFileSync("false", [], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
      expect.unreachable("`false` exits non-zero");
    } catch (cause) {
      expect(isStalledStep(cause)).toBe(false);
    }
  });

  it("says what a stall means, names the step, and names the bound it broke", () => {
    const said = stalledStep("pithy add secrets", STEP_TIMEOUT_MS);

    expect(said).toContain("pithy add secrets");
    expect(said).toContain("10 minutes");
    // The sentence exists because `spawnSync bun ETIMEDOUT` is all the runner itself says.
    expect(said).toContain("never answered");
  });

  it("is bounded well above the slowest honest step, so the bound is not a performance budget", () => {
    // `pithy add secrets` takes 83 seconds. The bound is for a deadlock, not for a slow cold install.
    expect(STEP_TIMEOUT_MS).toBeGreaterThan(5 * 60 * 1000);
  });
});

/**
 * **The entry point has to actually use them**, and a unit test of an exported constant cannot say that.
 * Both halves are one line each in `scripts/cleanRoom.ts`, and a line is what gets dropped in a rebase —
 * so this reads the file the CI job names and fails if the gate has quietly gone back to unbounded,
 * cache-sharing spawns.
 */
describe("scripts/cleanRoom.ts", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "..", "..", "scripts", "cleanRoom.ts"), "utf8");

  it("runs every command on the workspace's own installer cache", () => {
    expect(source).toContain("cleanRoomEnv(workspace)");
  });

  it("bounds every command, and kills a child that will not answer a signal it cannot handle", () => {
    expect(source).toContain("timeout: STEP_TIMEOUT_MS");
    expect(source).toContain('killSignal: "SIGKILL"');
  });

  it("tells a stall apart from a failure when it reports one", () => {
    expect(source).toContain("isStalledStep(cause)");
  });
});
