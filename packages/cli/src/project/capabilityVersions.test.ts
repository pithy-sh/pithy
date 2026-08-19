// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every capability reports its own package version, and no capability forgets to.
 *
 * `GET /control-plane/manifest` reports a version per composed capability, and a management client
 * joins it against a release feed to answer the two questions the Cloudflare build id cannot: should
 * this customer upgrade, and which customers are exposed to what we just fixed. Both are only
 * answerable per module, because a project composes some capabilities and not others.
 *
 * **A capability that forgets reports `null`, and `null` already means something else** — the adopter's
 * own `app` capability, which genuinely has no npm version. So a published package reporting null is
 * indistinguishable from the adopter's own code, and a client either skips it silently or reports it as
 * un-versioned. Neither is true.
 *
 * That is not hypothetical: `@pithy-sh/matchmaking` and `@pithy-sh/rating` landed with no `pithy.manifest.json`
 * at all, so the first version of `scripts/stampVersions.ts` — which keyed on the manifest — skipped
 * both. This test is what makes the next such package fail CI instead of shipping a lie, and
 * `capabilities/addable.test.ts` is what now fails on the missing manifest itself (#415).
 *
 * Repo-wide and unconditional, like `migrations/orders.test.ts`: the property is only true as a set, so
 * checking an affected subset would miss exactly the drift it exists to catch.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "../../../../packages");

/** Whether a path exists — `statSync` throwing is the only way to ask without a race. */
function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every package that contributes a `Capability`, and the file that declares it.
 *
 * Mirrors `definesCapability` in `scripts/stampVersions.ts` deliberately: if the two ever disagree, a
 * package is either stamped and unused or used and unstamped, and this is the test that says so.
 */
function capabilityPackages(): { name: string; file: string }[] {
  const found: { name: string; file: string }[] = [];
  for (const dir of readdirSync(PACKAGES).sort()) {
    const packageDir = join(PACKAGES, dir);
    if (!exists(join(packageDir, "package.json"))) continue;

    // `core`'s capability is at `src/controlPlane/capability.ts`; every other is at `src/capability.ts`.
    const file =
      dir === "core" ? join(packageDir, "src/controlPlane/capability.ts") : join(packageDir, "src/capability.ts");
    if (exists(file)) found.push({ name: dir, file });
  }
  return found;
}

describe("every capability reports its package version", () => {
  const packages = capabilityPackages();

  it("finds the capability packages at all, so this cannot pass vacuously", () => {
    expect(packages.length).toBeGreaterThan(15);
  });

  it("stamps a version.generated.ts for each", () => {
    // The generated constant is committed, so `typecheck` and every consumer get it with no build step —
    // which is also what makes it possible for one to be missing.
    const missing = packages
      .filter((pkg) => !exists(join(PACKAGES, pkg.name, "src/version.generated.ts")))
      .map((pkg) => pkg.name);
    expect(missing, "run `bun run stamp-versions`").toEqual([]);
  });

  it("attaches it on the capability, so the manifest actually carries it", () => {
    // Stamping the constant and never reading it is the same failure as the CF_VERSION_METADATA binding
    // that shipped with a reader and no declaration: correct code, never wired, nothing complaining.
    const unattached = packages
      .filter((pkg) => !readFileSync(pkg.file, "utf8").includes("version: PACKAGE_VERSION"))
      .map((pkg) => pkg.name);
    expect(unattached, "add `version: PACKAGE_VERSION` to defineCapability").toEqual([]);
  });

  it("matches the version in each package.json", () => {
    // `scripts/stampVersions.ts --check` is the primary gate for this in CI; asserting it here too means
    // a developer running the suite sees the drift without waiting for the verify job.
    const drifted: string[] = [];
    for (const pkg of packages) {
      const declared = (
        JSON.parse(readFileSync(join(PACKAGES, pkg.name, "package.json"), "utf8")) as { version: string }
      ).version;
      const generated = readFileSync(join(PACKAGES, pkg.name, "src/version.generated.ts"), "utf8");
      if (!generated.includes(`PACKAGE_VERSION = ${JSON.stringify(declared)}`)) drifted.push(pkg.name);
    }
    expect(drifted, "run `bun run stamp-versions`").toEqual([]);
  });
});
