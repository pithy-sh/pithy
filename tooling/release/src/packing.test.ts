// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { type PackedPackage, packFaults } from "./packing";

/** A published source module: under `src`, TypeScript, not a declaration, not a test. */
const PUBLISHED = /^src\/(?!.*\.d\.ts$)(?!.*\.test\.).*\.tsx?$/;

/**
 * The two built halves `exports` promises for each source module a set of entries carries.
 *
 * Added with the build (#476), so that every fixture below describes a package that is *otherwise*
 * fit to publish and each test still isolates the one fault it names. Derived rather than written out,
 * because a fixture that lists its own `dist` is a fixture that can disagree with the rule it feeds —
 * and the two tests that need a tarball with a missing half say so by building one on purpose.
 */
function built(entries: readonly string[]): string[] {
  return entries
    .filter((path) => PUBLISHED.test(path))
    .flatMap((path) => {
      const stem = path.replace(/^src\//, "").replace(/\.tsx?$/, "");
      return [`dist/${stem}.js`, `dist/${stem}.d.ts`];
    });
}

function packed(over: Partial<PackedPackage> = {}): PackedPackage {
  const entries = over.entries ?? ["package.json", "README.md", "src/capability.ts", "pithy.manifest.json"];
  return {
    name: "@pithy-sh/auth",
    expectsManifest: true,
    ...over,
    entries: [...entries, ...built(entries)],
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

  it("reports a tarball with no source at all, and no build either", () => {
    const faults = packFaults(packed({ entries: ["package.json", "README.md"], expectsManifest: false }));

    // Both, because both are true and they are different failures: `dist` is what `exports` resolves
    // onto, and `src` is where the maps beside it point back to.
    expect(faults).toEqual([expect.stringMatching(/no src/i), expect.stringMatching(/no dist/i)]);
  });

  // **What `exports` became with #476.** Every package's map resolves `./src/*` onto `./dist/*.js`, and
  // `dist` is gitignored — so `npm pack`, which falls back to `.gitignore`, drops the whole build from
  // any package whose `files` field forgets to name it, and says nothing. The tarball installs and
  // every import of it fails.
  it("reports a tarball whose build never made it in", () => {
    const faults = packFaults({
      name: "@pithy-sh/auth",
      entries: ["package.json", "src/capability.ts"],
      expectsManifest: false,
    });

    expect(faults).toEqual([expect.stringMatching(/no dist/i), expect.stringMatching(/missing a half/)]);
  });

  it("reports a published module with only one of its two halves", () => {
    const faults = packFaults({
      name: "@pithy-sh/auth",
      entries: [
        "package.json",
        "src/capability.ts",
        "src/http/routes.ts",
        "dist/capability.js",
        "dist/capability.d.ts",
        "dist/http/routes.js",
      ],
      expectsManifest: false,
    });

    // The declaration is the missing half here, which is the quieter direction: the module imports and
    // runs, and the adopter's editor types it `any`.
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain("dist/http/routes.d.ts");
    expect(faults[0]).toContain("a published module");
  });

  it("asks for no build from a test, a declaration, or a vendored template", () => {
    expect(
      packFaults({
        name: "@pithy-sh/cli",
        entries: [
          "package.json",
          "src/main.ts",
          "dist/main.js",
          "dist/main.d.ts",
          "src/cloudflare-test.d.ts",
          "templates/starter/apps/api/src/worker.ts",
        ],
        expectsManifest: false,
      }),
    ).toEqual([]);
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

  // **The bug that shipped in 0.1.0 and 0.1.1.** `workspace:*` is a Bun/pnpm/yarn convention; npm does
  // not implement it and passes it through verbatim, so 20 of 22 packages published a dependency range
  // no registry can resolve. Every test in this repository runs inside the workspace, where
  // `workspace:*` resolves perfectly — which is precisely why nothing caught it.
  it("reports a workspace protocol range that reached the tarball", () => {
    const faults = packFaults(
      packed({
        entries: ["src/index.ts"],
        expectsManifest: false,
        manifest: { dependencies: { "@pithy-sh/core": "workspace:*", zod: "^4.0.0" } },
      }),
    );

    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain("@pithy-sh/core");
    expect(faults[0]).toMatch(/workspace:/);
  });

  it("reports one in peerDependencies too", () => {
    const faults = packFaults(
      packed({
        entries: ["src/index.ts"],
        expectsManifest: false,
        manifest: { peerDependencies: { "@pithy-sh/vite": "workspace:^" } },
      }),
    );

    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain("@pithy-sh/vite");
  });

  // A devDependency is never installed by a consumer, and several point at private packages that have
  // no published range to name. `workspace:*` is correct there and must not be reported.
  it("ignores a workspace range in devDependencies", () => {
    expect(
      packFaults(
        packed({
          entries: ["src/index.ts"],
          expectsManifest: false,
          manifest: { devDependencies: { "@pithy-sh/tsconfig": "workspace:*" } },
        }),
      ),
    ).toEqual([]);
  });

  it("accepts concrete ranges", () => {
    expect(
      packFaults(
        packed({
          entries: ["src/index.ts"],
          expectsManifest: false,
          manifest: { dependencies: { "@pithy-sh/core": "^0.1.2" } },
        }),
      ),
    ).toEqual([]);
  });

  it("names the package in every fault it reports", () => {
    const faults = packFaults(packed({ name: "@pithy-sh/core", entries: ["src/a.test.ts"], expectsManifest: false }));

    for (const fault of faults) expect(fault).toContain("@pithy-sh/core");
  });
});
