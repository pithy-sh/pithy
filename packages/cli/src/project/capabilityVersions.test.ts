// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

/** The specifier a capability module imports `PACKAGE_NAME` from, or `undefined` if it imports none. */
function importedPackageNameSpecifier(source: string): string | undefined {
  return /import\s*\{[^}]*\bPACKAGE_NAME\b[^}]*\}\s*from\s*"([^"]+)"/.exec(source)?.[1];
}

/**
 * Whether `specifier`, written in `capabilityFile`, is `packageDir`'s own stamped module.
 *
 * States what must be true — the import resolves to this package's `src/version.generated` — rather
 * than matching the spellings of imports that must not be. The first attempt matched shape, and
 * shape cannot see the difference: `.` is an ordinary character in a directory name, so every `..`
 * in `../../core/src/version.generated` matched the same "descend one level" group a real
 * subdirectory does, and a sibling's stamp passed a rule written to exclude exactly it. Resolution
 * is the question the field is actually asking, so the rule asks it.
 *
 * A non-relative specifier is rejected outright rather than resolved: a bare one is another
 * package's public entry by definition, and an absolute one names a path no other checkout has.
 */
function resolvesToOwnStamp(capabilityFile: string, packageDir: string, specifier: string): boolean {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return false;
  return resolve(dirname(capabilityFile), specifier) === resolve(packageDir, "src/version.generated");
}

describe("the own-package rule asks where the import lands, not how it is spelled", () => {
  const audit = { file: join(PACKAGES, "audit/src/capability.ts"), dir: join(PACKAGES, "audit") };
  const core = { file: join(PACKAGES, "core/src/controlPlane/capability.ts"), dir: join(PACKAGES, "core") };

  it("accepts the stamp each capability actually imports", () => {
    expect(resolvesToOwnStamp(audit.file, audit.dir, "./version.generated")).toBe(true);
    expect(resolvesToOwnStamp(core.file, core.dir, "../version.generated")).toBe(true);
  });

  it("rejects a sibling package's stamp, however many segments it walks", () => {
    // The defect this rule was written for, and the one the first spelling-based rule let through:
    // `.` is an ordinary character in a directory name, so a `..` segment is indistinguishable from
    // a descent by any pattern that matches path *shape*. Resolving is what tells them apart.
    for (const specifier of [
      "../../core/src/version.generated",
      "./../../core/src/version.generated",
      "../../../packages/core/src/version.generated",
    ]) {
      expect(resolvesToOwnStamp(audit.file, audit.dir, specifier), specifier).toBe(false);
    }
    expect(resolvesToOwnStamp(core.file, core.dir, "../../../audit/src/version.generated")).toBe(false);
  });

  it("rejects a path inside the package that is not the stamp, and anything not relative", () => {
    // `../version.generated` is `packages/version.generated` from audit — outside the package
    // entirely, and still the shape of a well-behaved relative import.
    expect(resolvesToOwnStamp(audit.file, audit.dir, "../version.generated")).toBe(false);
    expect(resolvesToOwnStamp(audit.file, audit.dir, "@pithy-sh/core/src/version.generated")).toBe(false);
    expect(resolvesToOwnStamp(audit.file, audit.dir, join(PACKAGES, "core/src/version.generated"))).toBe(false);
  });
});

/**
 * And the package that version belongs to (#626).
 *
 * A version joins against a release feed **by package name**, which the manifest reported for two years
 * without ever sending. A client had to guess `@pithy-sh/${name}` — right for most capabilities, wrong
 * for the one that matters: `controlplane` ships inside `@pithy-sh/core`, so the guess reaches a package
 * that has never been published and the join comes back empty, which reads exactly like "up to date".
 *
 * **A capability name and a package name are different kinds of thing.** One is what a composition calls
 * a concept; the other is how that concept is distributed, and one package may ship more than one
 * capability. So no convention derives the second from the first, and the relationship is a fact only
 * the producing package can state — which is why the framework must never fill this in from `name`.
 *
 * The invariant this holds is: **every capability declares its own package, and what it declares is that
 * package's `package.json` name.** Three checks, because that is three separable things — the constant
 * is attached, it is *its own* package's constant, and the constant is the name npm knows. Any one alone
 * passes while the statement is false.
 *
 * Shares {@link capabilityPackages} with the versions above deliberately. Two enumerators would drift,
 * and a gate that enumerates a hand-written list goes stale the day a capability ships. The middle
 * check reads through {@link resolvesToOwnStamp}, which the block above holds to the spellings that
 * must and must not pass — a repo-wide gate is only ever green here, so nothing else would show that
 * its rule can still fail.
 */
describe("every capability reports the package that supplies it", () => {
  const packages = capabilityPackages();

  it("attaches `package: PACKAGE_NAME` on the capability", () => {
    // Same failure the version gate catches, one field over: a constant that is stamped, correct, and
    // never read is indistinguishable from one that was never stamped, because the manifest says null
    // either way — and null is reserved for the adopter's own app capability, which genuinely has none.
    const unattached = packages
      .filter((pkg) => !readFileSync(pkg.file, "utf8").includes("package: PACKAGE_NAME"))
      .map((pkg) => pkg.name);
    expect(unattached, "add `package: PACKAGE_NAME` to defineCapability").toEqual([]);
  });

  it("reads that constant from its own generated module, and not from a sibling", () => {
    // `package: PACKAGE_NAME` is only the *own* package if the constant came from this package's own
    // stamp. An import of a sibling's would satisfy the check above while reporting somebody else's
    // package — the exact class of error the field exists to end, arrived at from the other side.
    const foreign: string[] = [];
    for (const pkg of packages) {
      const source = readFileSync(pkg.file, "utf8");
      const imported = importedPackageNameSpecifier(source);
      if (imported === undefined || !resolvesToOwnStamp(pkg.file, join(PACKAGES, pkg.name), imported)) {
        foreign.push(`${pkg.name} (${imported ?? "no import"})`);
      }
    }
    expect(foreign, 'import PACKAGE_NAME from this package\'s own "./version.generated"').toEqual([]);
  });

  it("stamps a PACKAGE_NAME equal to the name in each package.json", () => {
    // The other half: the constant is this package's, and the constant is what npm calls it. Without
    // this the two could drift on a rename and every joined lookup would miss, silently.
    const drifted: string[] = [];
    for (const pkg of packages) {
      const declared = (JSON.parse(readFileSync(join(PACKAGES, pkg.name, "package.json"), "utf8")) as { name: string })
        .name;
      const generated = readFileSync(join(PACKAGES, pkg.name, "src/version.generated.ts"), "utf8");
      if (!generated.includes(`PACKAGE_NAME = ${JSON.stringify(declared)}`)) drifted.push(pkg.name);
    }
    expect(drifted, "run `bun run stamp-versions`").toEqual([]);
  });

  it("puts `controlplane` in `@pithy-sh/core`, which is the case a convention gets wrong", () => {
    // Spelled out rather than derived, because it is the counterexample the whole field exists for. The
    // seam's own manifest response asserts the shipped value end to end — see
    // `core/src/controlPlane/http/routes.workers.test.ts`; this is the source-side statement that the
    // two names still disagree, so a rename that made the convention true again fails here first.
    const core = packages.find((pkg) => pkg.name === "core");
    expect(core, "core contributes the controlplane capability").toBeDefined();
    expect(readFileSync(core?.file ?? "", "utf8")).toContain('name: "controlplane"');
    expect((JSON.parse(readFileSync(join(PACKAGES, "core/package.json"), "utf8")) as { name: string }).name).toBe(
      "@pithy-sh/core",
    );
  });
});
