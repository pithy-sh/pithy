// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { type PackedPackage, packFaults } from "./packing";

function packed(over: Partial<PackedPackage> = {}): PackedPackage {
  return {
    name: "@pithy-sh/auth",
    entries: ["package.json", "README.md", "src/capability.ts", "pithy.manifest.json"],
    expectsManifest: true,
    ...over,
  };
}

describe("packFaults", () => {
  it("finds nothing wrong with a clean tarball", () => {
    expect(packFaults(packed())).toEqual([]);
  });

  // Half of `@pithy-sh/core`'s first tarball was tests, and `@pithy-sh/payments` shipped 93 of them
  // while declaring a `files` field that simply forgot the negation.
  it("reports test files that reached the tarball", () => {
    const faults = packFaults(
      packed({
        entries: ["src/capability.ts", "src/capability.test.ts", "src/http/routes.test.ts"],
        expectsManifest: false,
      }),
    );

    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatch(/2 test files/);
    expect(faults[0]).toContain("src/capability.test.ts");
  });

  // The CLI vendors a starter an adopter scaffolds, and a starter that ships without its own test
  // teaches the wrong thing. `verifyPack.ts` holds those files to the git index exactly.
  // `@pithy-sh/ui-react` writes its tests as `.tsx`, and a rule spelled `.test.ts` let eleven of them
  // through a gate reporting "22 packages pack clean". The one package using TSX was the one the rule
  // did not cover.
  it("reports a TSX test file, not only a TS one", () => {
    const faults = packFaults(
      packed({ entries: ["src/otp.tsx", "src/otp.test.tsx", "src/router.test.ts"], expectsManifest: false }),
    );

    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatch(/2 test files/);
    expect(faults[0]).toContain("src/otp.test.tsx");
  });

  it("allows a test inside a vendored template, which an adopter is meant to receive", () => {
    expect(
      packFaults(
        packed({
          entries: ["src/main.ts", "templates/starter/apps/api/src/bindings.workers.test.ts"],
          expectsManifest: false,
        }),
      ),
    ).toEqual([]);
  });

  // `files` does not fail on a missing path — the lesson `verifyPack.ts` was built on. A manifest
  // listed and absent passes every static check and breaks `pithy add` for the adopter.
  it("reports a capability manifest that did not make it in", () => {
    const faults = packFaults(packed({ entries: ["src/capability.ts"] }));

    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatch(/pithy\.manifest\.json/);
  });

  it("does not ask for a manifest from a package that has none", () => {
    expect(packFaults(packed({ entries: ["src/index.ts"], expectsManifest: false }))).toEqual([]);
  });

  it("reports a tarball with no source at all", () => {
    const faults = packFaults(packed({ entries: ["package.json", "README.md"], expectsManifest: false }));

    expect(faults).toEqual([expect.stringMatching(/no src/i)]);
  });

  // Build leftovers a `files` field would have excluded. Harmless to an adopter and a signal that the
  // field is missing or wrong.
  it("reports build and tooling leftovers", () => {
    const faults = packFaults(
      packed({
        entries: ["src/index.ts", "tsconfig.json", "vitest.config.ts", "tsconfig.tsbuildinfo"],
        expectsManifest: false,
      }),
    );

    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain("tsconfig.json");
    expect(faults[0]).toContain("vitest.config.ts");
  });

  // `files` does not fail on a missing path — the whole reason this check is on the artifact. A
  // declared entry that matched nothing is the exact miss the field cannot report itself.
  it("reports a declared entry that reached nothing", () => {
    const faults = packFaults(
      packed({
        entries: ["src/index.ts"],
        expectsManifest: false,
        declared: ["src", "dist/paddle-prices.iife.js", "!src/**/*.test.*"],
      }),
    );

    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain("dist/paddle-prices.iife.js");
  });

  it("counts a declared directory as reached when anything under it landed", () => {
    expect(packFaults(packed({ entries: ["src/a/b.ts"], expectsManifest: false, declared: ["src"] }))).toEqual([]);
  });

  it("ignores negations when checking what a declaration reached", () => {
    expect(
      packFaults(packed({ entries: ["src/a.ts"], expectsManifest: false, declared: ["src", "!src/**/*.test.*"] })),
    ).toEqual([]);
  });

  it("names the package in every fault it reports", () => {
    const faults = packFaults(packed({ name: "@pithy-sh/core", entries: ["src/a.test.ts"], expectsManifest: false }));

    for (const fault of faults) expect(fault).toContain("@pithy-sh/core");
  });
});
