// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { type CleanRoomManifest, floorOf, kitOverrides, thirdPartyFloors } from "./cleanRoom";

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
