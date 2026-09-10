// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { GLOBAL_SCOPE } from "@pithy-sh/core/src/naming/environment";
import { describe, expect, test } from "vitest";
import { GLOBAL_BINDINGS } from "../doctor/bindingScope";

/**
 * **Every binding a shipped manifest calls project-global has a row in `doctor`'s table, and every row
 * names one that does (#513 review).**
 *
 * `doctor/bindingScope.ts` is the only thing in the toolchain that will ever tell an already-scaffolded
 * project that a resource the whole project shares is bound to two of it. It works from a hand-written
 * list of which bindings those are — and a hand-written list is a second source of truth about a fact the
 * manifests already state, which is the disease #513 exists to remove, not a cure for it. A third
 * capability declaring `scope: "global"` would have been invisible to the one check built to find a split.
 *
 * ## Gated, not derived — and the difference is the whole reason the check works
 *
 * The obvious fix is for `bindingScope.ts` to read the manifests. It must not, and `bindingScope.ts` says
 * why at length: the case that check exists for is a **newer CLI beside an older capability package**,
 * where the namer already composes `<project>-global-email-suppressions` and the manifest still says
 * nothing. A derived list is empty exactly there, so a split project would read as healthy on the
 * installs most likely to be split. (The manifest *is* read for the remedy, which is a different
 * question: whether `pithy provision` would write the right name. That half is honest about skew because
 * skew is what it is asking about.)
 *
 * So the CLI carries what it knows, and this holds it to what ships — `bindingResourceNames.test.ts`'s
 * shape, and `migrations/orders.test.ts`'s before it: a property true only *as a set* is checked over the
 * whole set, in one place a new declaration cannot quietly stay out of.
 */

/** `packages/` — this file lives at `packages/cli/src/ci/`. */
const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Whether a path exists — `statSync` throwing is the only way to ask without a race. */
function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** One binding some shipped manifest declares `scope: "global"`. */
interface ShippedGlobal {
  /** The manifest's `name` — `email`, `support`. */
  capability: string;
  /** The manifest's `package` — what an adopter upgrades, and what a row must name. */
  package: string;
  /** The binding name. */
  binding: string;
  /** The Cloudflare namespace it lives in. */
  kind: string;
}

/**
 * Every project-global binding in every manifest under `packages/`.
 *
 * The scan is over `pithy.manifest.json` rather than over `src/capability.ts`, and that is right here
 * where it is wrong in `bindingResourceNames.test.ts`: `scope` is a **manifest** field and cannot be
 * declared anywhere else — that file's last block is the gate that keeps it so. A package shipping no
 * manifest declares no scope, so there is nothing for this sweep to miss.
 */
function shippedGlobals(): ShippedGlobal[] {
  const found: ShippedGlobal[] = [];
  for (const dir of readdirSync(PACKAGES).sort()) {
    const path = join(PACKAGES, dir, "pithy.manifest.json");
    if (!exists(path)) continue;
    const manifest = CapabilityManifest.parse(JSON.parse(readFileSync(path, "utf8")));
    for (const binding of manifest.requiredBindings) {
      if (binding.scope !== GLOBAL_SCOPE) continue;
      found.push({
        capability: manifest.name,
        package: manifest.package,
        binding: binding.name,
        kind: binding.type,
      });
    }
  }
  return found;
}

/** `<capability>/<binding>` — the key a manifest entry and a `GLOBAL_BINDINGS` row are matched on. */
function key(entry: { capability: string; binding: string }): string {
  return `${entry.capability}/${entry.binding}`;
}

describe("doctor knows every project-global binding the kit ships", () => {
  const shipped = shippedGlobals();

  test("the sweep finds manifests at all, so nothing below passes vacuously", () => {
    // Every assertion here is a comparison against this list, and a comparison against an empty list is
    // green in one direction. A `PACKAGES` path that moved would leave the gate passing while checking
    // nothing — and the failure mode it guards is a capability nobody wrote a row for.
    expect(shipped.length).toBeGreaterThan(0);
    expect(GLOBAL_BINDINGS.length).toBeGreaterThan(0);
  });

  test("every manifest binding declared scope: global has a row", () => {
    const known = new Set(GLOBAL_BINDINGS.map(key));
    const missing = shipped
      .filter((entry) => !known.has(key(entry)))
      .map(key)
      .sort();
    expect(
      missing,
      "A capability declares a binding project-global and doctor's bindingScope check does not know about it, so no project will ever be told that resource is split. Add a row to GLOBAL_BINDINGS naming the function that composes the resource's single name.",
    ).toEqual([]);
  });

  test("every row names a binding some manifest still declares project-global", () => {
    // The inverse. A binding that stopped being global, or was renamed, leaves a row comparing every
    // correct stanza against a name nothing creates — a red on a project that is fine.
    const declared = new Set(shipped.map(key));
    const stale = GLOBAL_BINDINGS.filter((row) => !declared.has(key(row)))
      .map(key)
      .sort();
    expect(stale, "GLOBAL_BINDINGS names a binding no manifest declares project-global any more.").toEqual([]);
  });

  test("every row agrees with the manifest about the kind and the package", () => {
    // The kind picks which `wrangler.jsonc` array a stanza is read out of, so a row that says `d1` for an
    // `r2` binding reads nothing and reports nothing. The package is what the remedy tells an adopter to
    // upgrade under version skew, so a wrong one sends them to the wrong `bun add`.
    const byKey = new Map(shipped.map((entry) => [key(entry), entry]));
    const wrong = GLOBAL_BINDINGS.flatMap((row) => {
      const entry = byKey.get(key(row));
      if (entry === undefined) return [];
      const problems: string[] = [];
      if (entry.kind !== row.kind) problems.push(`row says ${row.kind}, manifest says ${entry.kind}`);
      if (entry.package !== row.package) problems.push(`row says ${row.package}, manifest says ${entry.package}`);
      return problems.map((problem) => `${key(row)}: ${problem}`);
    }).sort();
    expect(wrong).toEqual([]);
  });

  test("each row's namer answers, and puts `global` where the environment goes", () => {
    // The row is only useful if the function on it answers. A capability package that will not import
    // answers `null`, which `bindingScopeHealth` reads as *partial* rather than as a clean bill — correct
    // in an adopter's project, and never correct in this repository, where every package is present.
    //
    // The prefix is the declaration restated as an assertion: `scope: "global"` *means* the literal
    // `global` takes the environment segment, so a namer composing anything else is a row whose two halves
    // disagree — and `bindingScopeHealth` would then report every correctly-named stanza as stale.
    return expect(
      Promise.all(GLOBAL_BINDINGS.map(async (row) => `${key(row)}: ${await row.name("acme")}`)),
    ).resolves.toEqual(
      GLOBAL_BINDINGS.map((row) => expect.stringMatching(new RegExp(`^${key(row)}: acme-global-[a-z0-9-]+$`))),
    );
  });
});
