// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { describe, expect, test } from "vitest";

/**
 * **A config option whose values are a closed set says so in the manifest.**
 *
 * `choices` is not decoration. `pithy add` renders a select instead of free text from it, `--set`
 * refuses a value outside it instead of writing one, and a refusal can name what is legal — the option's
 * own `describe()` in `@pithy-sh/core`'s manifest schema says all three. Without it, `coerceSetFlags`
 * finds no choices, skips the boolean and number branches for a string default, and returns the raw
 * argument: `pithy add organization --set slugs=derivd` writes `derivd` into the adopter's
 * `pithy.config.ts` as the value of a `z.enum(["chosen", "derived"])`, and the capability refuses to load
 * at the next command that touches the config.
 *
 * The rule is checked against the capability's **own Zod config schema**, not against a list kept here.
 * A schema is the one place that knows whether a value is closed, so an enum added to a config next year
 * is held to this without anybody remembering to come back.
 *
 * ## What this reaches, and what it does not
 *
 * Every manifest option that names a field in its capability's Zod config object. That is the whole of
 * the rule where the rule can be decided, and it is why the census below is exhaustive rather than a
 * filter: a package shipping a manifest and missing from it fails, so a new capability cannot be skipped
 * by being unknown.
 *
 * Two shapes are deliberately out of reach, and both are stated rather than left to be discovered:
 *
 * - **An option that is a factory argument rather than a config field.** `basePath` is declared on the
 *   options interface and destructured before the schema ever parses, so there is no Zod field to read.
 *   Four capabilities do this and none of them is a closed set.
 * - **A capability whose config is a TypeScript interface.** Six ship no Zod config object at all; each
 *   has a row here saying so, and adding one is what brings its options into this gate.
 *
 * Neither hides a closed set today: the sweep below reports every enum it finds, and the count is
 * asserted, so an option that stops being checked fails rather than passes.
 */

/** `packages/` — this file is `packages/cli/src/ci/`. */
const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Every package that ships a manifest, and where its Zod config schema lives — or why it has none.
 *
 * A census rather than a lookup with a fallback. "Not found, so skip it" is how a gate goes quiet on the
 * exact capability somebody has just added, and the sentence beside each `null` is the thing a reviewer
 * can disagree with.
 */
const CONFIG_SCHEMAS: Record<string, { module: string; export: string } | { none: string }> = {
  audit: { module: "@pithy-sh/audit/src/capability", export: "AuditConfig" },
  auth: { module: "@pithy-sh/auth/src/capability", export: "AuthConfig" },
  cloudflare: { none: "Not a capability: no manifest of config options, only provisioning clients." },
  core: { none: "The control-plane options are a TypeScript interface on createBackend, not a Zod object." },
  email: { module: "@pithy-sh/email/src/capability", export: "EmailConfig" },
  i18n: { none: "Its options are the catalog and the default locale, typed as an interface, not a Zod object." },
  leaderboard: { module: "@pithy-sh/leaderboard/src/config/config", export: "LeaderboardConfig" },
  ledger: { module: "@pithy-sh/ledger/src/config/config", export: "LedgerConfig" },
  matchmaking: { module: "@pithy-sh/matchmaking/src/config/config", export: "MatchmakingConfig" },
  media: { module: "@pithy-sh/media/src/config/config", export: "MediaConfig" },
  multiplayer: { module: "@pithy-sh/multiplayer/src/config/config", export: "MultiplayerConfig" },
  organization: { module: "@pithy-sh/organization/src/config/config", export: "OrganizationConfig" },
  payments: { module: "@pithy-sh/payments/src/config/config", export: "PaymentsConfig" },
  rating: { module: "@pithy-sh/rating/src/config/config", export: "RatingConfig" },
  secrets: { none: "Its options are a registry object and a number, typed as an interface, not a Zod object." },
  storage: { module: "@pithy-sh/storage/src/config/config", export: "StorageConfig" },
  support: { none: "Its one option is a mount path, a factory argument rather than a config field." },
  testers: { none: "Its options are typed as an interface on the factory, not as a Zod object." },
  turnstile: { none: "Its one option is the widget set, typed as an interface, not a Zod object." },
  vector: { module: "@pithy-sh/vector/src/config/config", export: "VectorConfig" },
};

/** Every directory under `packages/` shipping a `pithy.manifest.json`. */
function packagesWithManifests(): string[] {
  return readdirSync(PACKAGES)
    .sort()
    .filter((dir) => existsSync(join(PACKAGES, dir, "pithy.manifest.json")));
}

/** One package's parsed manifest, read from the package rather than from an install. */
function manifestOf(dir: string): CapabilityManifest {
  return CapabilityManifest.parse(JSON.parse(readFileSync(join(PACKAGES, dir, "pithy.manifest.json"), "utf8")));
}

/**
 * The schema under every wrapper a config field may carry.
 *
 * `.default()`, `.optional()`, `.prefault()` and `.nullable()` each wrap the type they modify, and a
 * closed set stays closed under all of them — `z.enum([...]).default("d1")` is still an enum. Bounded
 * rather than `while (true)`: a cycle here would hang the suite instead of failing it.
 */
function unwrap(schema: unknown): { type?: string; entries?: Record<string, string> } {
  let at = schema as { def?: { type?: string; entries?: Record<string, string>; innerType?: unknown } };
  for (let depth = 0; depth < 16; depth += 1) {
    const inner = at?.def?.innerType;
    if (inner === undefined) break;
    at = inner as typeof at;
  }
  return at?.def ?? {};
}

/** One manifest option read against its config field. */
interface Checked {
  /** `<package>.<key>`, the name every failure below is reported by. */
  name: string;
  /** The values the schema accepts, when the field is a closed set. */
  values: string[];
  /** What the manifest declares, if anything. */
  choices: string[] | undefined;
}

/** Every manifest option whose config field is a closed set, with what each side says about it. */
async function closedSets(): Promise<Checked[]> {
  const found: Checked[] = [];
  for (const dir of packagesWithManifests()) {
    const entry = CONFIG_SCHEMAS[dir];
    if (entry === undefined || "none" in entry) continue;
    const module = (await import(entry.module)) as Record<string, unknown>;
    const schema = module[entry.export] as { def: { shape: Record<string, unknown> } } | undefined;
    if (!schema) throw new Error(`${entry.module} exports no ${entry.export}`);
    for (const option of manifestOf(dir).configOptions) {
      const field = schema.def.shape[option.key];
      if (field === undefined) continue;
      const def = unwrap(field);
      if (def.type !== "enum") continue;
      found.push({ name: `${dir}.${option.key}`, values: Object.values(def.entries ?? {}), choices: option.choices });
    }
  }
  return found;
}

describe("a config option that is a closed set says so in its manifest", () => {
  test("every package shipping a manifest is in the census, so none is skipped by being unknown", () => {
    const missing = packagesWithManifests().filter((dir) => CONFIG_SCHEMAS[dir] === undefined);
    // A new capability lands here first. Either name its Zod config schema, or say in a sentence why it
    // has none — both are cheap, and neither is what a silent skip costs.
    expect(missing).toEqual([]);
  });

  test("the sweep finds closed sets at all, so the assertions below are not vacuous", async () => {
    // Every check here compares against this list, and a comparison against an empty list passes. The
    // sweep reaches six today; it is asserted as a floor, so a resolution that stopped working fails.
    const checked = await closedSets();
    expect(checked.length).toBeGreaterThanOrEqual(6);
  });

  test("each one declares its choices, and declares them exactly", async () => {
    const wrong = (await closedSets())
      .filter((each) => JSON.stringify(each.choices) !== JSON.stringify(each.values))
      .map((each) => `${each.name}: schema ${JSON.stringify(each.values)}, manifest ${JSON.stringify(each.choices)}`);
    // Undeclared is one half. The other is a list that has drifted from the enum it mirrors — a choice
    // the schema dropped is a value `pithy add` still offers, and a refusal that names it is worse than
    // none. Both read as one failure because the remedy is the same: copy the enum.
    expect(wrong).toEqual([]);
  });
});
