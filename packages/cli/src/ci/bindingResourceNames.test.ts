// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { FEATURE_RESOURCE_KINDS, type FeatureResourceKind } from "@pithy-sh/core/src/naming/feature";
import { type BindingNaming, environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { MAX_PROJECT_NAME } from "@pithy-sh/core/src/naming/resource";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { suppressionDatabaseName } from "@pithy-sh/email/src/provision/provisionEmail";
import { mediaBucketName } from "@pithy-sh/media/src/provision/provisionMedia";
import { managerWorkerName } from "@pithy-sh/secrets/src/provision/resolveManagerConfig";
import { storageBucketName } from "@pithy-sh/storage/src/provision/provisionStorage";
import { describe, expect, test } from "vitest";
import { supportBucketName } from "../capabilities/supportProvisioner";

/**
 * **One name per provisionable binding, across every capability the repo ships (#513).**
 *
 * `pithy provision` composes a resource name from the binding alone — `<project>-<env>-<binding>`,
 * through `environmentScope`. Four capabilities also compose a name for the *same* resource in their own
 * provisioner, because they know something the binding does not say: that email's suppression database is
 * one per **project** rather than one per environment, that support's bucket is too, that media's and
 * storage's buckets drop the `-bucket` the binding carries for the reader in the Worker.
 *
 * Two writers, one resource. Nothing compared them, so nothing noticed that `pithy add email` writes
 * `<p>-dev-`, `<p>-staging-` and `<p>-prod-email-suppressions` where `workflows/hostEnv.ts` requires
 * exactly one database "bound identically in every environment", named `<p>-global-email-suppressions` —
 * which is the name `pithy email provision` separately creates. The app Worker and the email Worker then
 * read different suppression lists, and **an unsubscribe recorded on one is invisible to the other**.
 *
 * This is the comparison. It is `migrations/orders.test.ts`'s shape and exists for its reason: a property
 * that is only true *as a set* has to be checked over the whole set, in one hand-maintained table that a
 * new binding cannot quietly stay out of. An author adding a provisionable binding adds a row here, and
 * says in it either which namer the binding agrees with or that no second namer exists.
 *
 * **It does not check that a name is right. It checks that there is only one of it.** Whether
 * `EMAIL_SUPPRESSIONS` should be global is `hostEnv.ts`'s statement and not this file's; what this file
 * refuses is two answers to it.
 *
 * ## Why the manifest, and only the manifest
 *
 * The last block below is the fourth assertion, and this is its argument. `pithy add` reads
 * `wiredBindings(manifest)` and never reaches a composed capability instance — it runs before any config
 * exists. `pithy upgrade` reads `effectiveBindings`, which resolves `optional` against the composed
 * instance but returns **manifest** specs. Only `provision` sees an instance at all. So a scope or a
 * resource declared on a capability's own `requiredBindings` literal would be invisible to two of the
 * three writers, and declaring it in both places is a second source of truth — which is the disease #513
 * is about, not a cure for it. There is no agreement gate for that half either: a capability factory
 * needs config, and there is no config to give it that would not be inventing one.
 */

/** `packages/` — this file lives at `packages/cli/src/ci/`. */
const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** A short, ordinary project name — what almost every adopter has. */
const SHORT_PROJECT = "acme";

/**
 * A project name at exactly {@link MAX_PROJECT_NAME}, the longest a root `pithy.config.ts` may declare.
 *
 * **Pinned deliberately, because agreement at four characters is not agreement.** Two namers may compose
 * the same string through different *namespaces*, and a namespace carries its own cap and its own
 * refuse-or-truncate policy (`core/src/naming/limits.ts`). `SECRETS` is the live case: `managerWorkerName`
 * composes it through the **worker** namespace, which refuses at 63, while the generic path composes it
 * through **d1**, which truncates at 128. They agree today by luck of length. A rule they agreed by would
 * still agree at the longest project a config can name, so that is what is asserted.
 */
const LONG_PROJECT = `${"a".repeat(MAX_PROJECT_NAME - 1)}z`;

/** The environment every comparison is made in. Any declared one would do; a name that differs, differs. */
const ENVIRONMENT = "staging";

/** How a capability names a resource itself, given the project and the environment being provisioned. */
type Namer = (project: string, env: string) => string;

/** A binding this table has a row for. */
interface Declared {
  /** The capability's manifest `name` — `controlplane` for the seam core ships. */
  capability: string;
  /** The binding as the manifest declares it. */
  binding: string;
  /** The Cloudflare namespace `provision` creates it in. */
  kind: FeatureResourceKind;
  /**
   * The capability's own namer for this resource, or `null` where there is no second one and the generic
   * `<project>-<env>-<binding>` rule is the only writer.
   */
  namer: Namer | null;
  /** Why the row reads the way it does — the namer's home, or what makes a second one unnecessary. */
  why: string;
  /**
   * A disagreement that is known, tracked, and deliberately not fixed here.
   *
   * An exemption is a row whose two namers **must** currently disagree. It is not a mute: the follow-up
   * issue is named, {@link EXEMPT} pins the exact set so a third cannot be added quietly, and the row
   * fails the moment the disagreement is fixed — because a fix means the row is a lie and belongs deleted.
   */
  exemption?: { issue: string; reason: string };
}

/**
 * **Every provisionable binding in every shipped manifest, and what else names its resource.**
 *
 * *Adding a provisionable binding to a manifest?* Add a row. If the capability composes the resource's
 * name anywhere itself — a `provision*.ts`, a `*Provisioner.ts`, a resolver — point `namer` at that
 * function. If it does not, say `null` and say in `why` why the generic rule is enough. A binding with no
 * row fails, and so does a row for a binding no manifest declares.
 *
 * Fifteen capabilities declare `d1 DB` and none of them names it: `DB` is the adopter's app database, and
 * every provisioner reads its **id** out of the Worker's `wrangler.jsonc` (`context.databaseId("DB")`)
 * rather than recomposing its name. One writer, so nothing to compare.
 */
const DECLARED: readonly Declared[] = [
  { capability: "audit", binding: "DB", kind: "d1", namer: null, why: "the app database — id read, never renamed" },
  { capability: "auth", binding: "DB", kind: "d1", namer: null, why: "the app database" },
  { capability: "controlplane", binding: "DB", kind: "d1", namer: null, why: "the app database" },
  {
    capability: "controlplane",
    binding: "CONTROL_PLANE",
    kind: "kv",
    namer: null,
    why: "the replay-guard namespace — provisioned by the generic rule and named nowhere else",
  },
  { capability: "email", binding: "DB", kind: "d1", namer: null, why: "the app database" },
  {
    capability: "email",
    binding: "EMAIL_SUPPRESSIONS",
    kind: "d1",
    namer: suppressionDatabaseName,
    why: "`email/src/provision/provisionEmail.ts` — `<project>-global-email-suppressions`, one per project, because an unsubscribe is not an environment-local fact",
  },
  { capability: "leaderboard", binding: "DB", kind: "d1", namer: null, why: "the app database" },
  { capability: "ledger", binding: "DB", kind: "d1", namer: null, why: "the app database" },
  { capability: "matchmaking", binding: "DB", kind: "d1", namer: null, why: "the app database" },
  {
    capability: "matchmaking",
    binding: "MATCHMAKING",
    kind: "kv",
    namer: null,
    why: "the queue's KV namespace — the generic rule is its only writer",
  },
  { capability: "media", binding: "DB", kind: "d1", namer: null, why: "the app database" },
  {
    capability: "media",
    binding: "MEDIA_BUCKET",
    kind: "r2",
    namer: mediaBucketName,
    why: '`media/src/provision/provisionMedia.ts` — per-environment, named `<project>-<env>-media` through the manifest\'s `resource: "media"` (#519)',
  },
  { capability: "multiplayer", binding: "DB", kind: "d1", namer: null, why: "the app database" },
  { capability: "payments", binding: "DB", kind: "d1", namer: null, why: "the app database" },
  { capability: "rating", binding: "DB", kind: "d1", namer: null, why: "the app database" },
  {
    capability: "secrets",
    binding: "SECRETS",
    kind: "d1",
    namer: managerWorkerName,
    why: "`secrets/src/provision/resolveManagerConfig.ts` — the manager and its database are one unit and share one string, so the Worker namespace's tighter cap governs both",
  },
  { capability: "storage", binding: "DB", kind: "d1", namer: null, why: "the app database" },
  {
    capability: "storage",
    binding: "STORAGE_BUCKET",
    kind: "r2",
    namer: storageBucketName,
    why: '`storage/src/provision/provisionStorage.ts` — per-environment, named `<project>-<env>-storage` through the manifest\'s `resource: "storage"` (#519)',
  },
  { capability: "support", binding: "DB", kind: "d1", namer: null, why: "the app database" },
  {
    capability: "support",
    binding: "SUPPORT_BUCKET",
    kind: "r2",
    namer: supportBucketName,
    why: "`cli/src/capabilities/supportProvisioner.ts` — `<project>-global-support`, one bucket for the project, because `ensureBucket()` takes no environment at all",
  },
  { capability: "testers", binding: "DB", kind: "d1", namer: null, why: "the app database" },
  { capability: "vector", binding: "DB", kind: "d1", namer: null, why: "the app database" },
];

/**
 * The disagreements that may stand, and the only ones — `<capability>/<binding>`.
 *
 * **Empty, and that is the state to keep it in.** It held `media/MEDIA_BUCKET` and
 * `storage/STORAGE_BUCKET` — both the `-bucket` suffix, both #519, which #513 left out because they are a
 * manifest edit rather than new machinery. Both manifests declare `resource` now, both namers agree, and
 * the rows are gone. The machinery stays because an exemption must go on being a decision with an issue
 * behind it: a new one is a change *here* as well as a field on a row nobody re-reads, and the last test
 * in this block deletes it again the moment the disagreement is fixed.
 */
const EXEMPT: readonly string[] = [];

/** A follow-up issue reference, as an exemption must name one: `#519`. */
const EXEMPTION_ISSUE = /^#\d+$/;

/** `<capability>/<binding>` — the key a row, a manifest entry, and an exemption are all matched on. */
function key(entry: { capability: string; binding: string }): string {
  return `${entry.capability}/${entry.binding}`;
}

/** Whether a path exists — `statSync` throwing is the only way to ask without a race. */
function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** One capability package: its directory under `packages/`, and the `capability.ts` that declares it. */
interface CapabilityPackage {
  dir: string;
  file: string;
}

/**
 * Every package that contributes a `Capability`, and the file that declares it.
 *
 * Keyed on `src/capability.ts`, never on `pithy.manifest.json` — the rule `scripts/stampVersions.ts` and
 * `capabilities/addable.test.ts` both learned the hard way. The manifest is the artifact that goes
 * missing, so a manifest-keyed sweep skips exactly the package a gate is for, in silence.
 */
function capabilityPackages(): CapabilityPackage[] {
  const found: CapabilityPackage[] = [];
  for (const dir of readdirSync(PACKAGES).sort()) {
    const packageDir = join(PACKAGES, dir);
    if (!exists(join(packageDir, "package.json"))) continue;
    // `core`'s capability is at `src/controlPlane/capability.ts`; every other is at `src/capability.ts`.
    const file =
      dir === "core" ? join(packageDir, "src/controlPlane/capability.ts") : join(packageDir, "src/capability.ts");
    if (exists(file)) found.push({ dir, file });
  }
  return found;
}

/** The manifest a package ships, or `undefined` where it ships none (`addable.test.ts` is that gate). */
function manifestOf(dir: string): CapabilityManifest | undefined {
  const path = join(PACKAGES, dir, "pithy.manifest.json");
  if (!exists(path)) return undefined;
  return CapabilityManifest.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** One provisionable binding, as some shipped manifest declares it. */
interface ManifestBinding {
  capability: string;
  binding: string;
  kind: FeatureResourceKind;
  /**
   * What the manifest says about naming the resource — `BindingSpec.scope` and `BindingSpec.resource`.
   *
   * **The generic side reads this, and that is the whole mechanism under test.** Before #513 the generic
   * rule was `<project>-<env>-<binding>` and had no way to hear anything else, which is why it wrote three
   * suppression databases where the capability creates one. The comparison below is only worth making if
   * the generic side is composed the way `pithy add` and `pithy provision` compose it — through the
   * manifest — so a row converges when the capability *declares*, and not when someone edits this file.
   */
  naming: BindingNaming;
}

/**
 * Every provisionable binding in every shipped manifest.
 *
 * "Provisionable" is {@link FEATURE_RESOURCE_KINDS} — d1, kv, r2 — because those are the three kinds
 * `pithy provision` creates a *resource* for and therefore the three that need a name. A Workflow, a
 * Durable Object, a Vectorize index and a Secrets Store entry are all named elsewhere and by their own
 * rules; `optional` is irrelevant here, since an optional binding a Worker does take is provisioned
 * exactly like a required one.
 */
function provisionableBindings(): ManifestBinding[] {
  const kinds = new Set<string>(FEATURE_RESOURCE_KINDS);
  const found: ManifestBinding[] = [];
  for (const pkg of capabilityPackages()) {
    const manifest = manifestOf(pkg.dir);
    if (manifest === undefined) continue;
    for (const binding of manifest.requiredBindings) {
      if (!kinds.has(binding.type)) continue;
      found.push({
        capability: manifest.name,
        binding: binding.name,
        kind: binding.type as FeatureResourceKind,
        naming: {
          ...(binding.scope ? { scope: binding.scope } : {}),
          ...(binding.resource ? { resource: binding.resource } : {}),
        },
      });
    }
  }
  return found;
}

/**
 * What `pithy provision` will call a binding's resource: the one generic rule, for one scope, composed
 * from what the **manifest** declares — because that is what the writers read.
 *
 * A row is looked up rather than carrying its own naming, so this table states which namer a binding
 * agrees with and never what the binding *is*. A second copy of a declaration here would be a third
 * writer, in the gate that exists to count them.
 */
function genericName(project: string, binding: ManifestBinding | Declared): string {
  const naming = MANIFEST_NAMING.get(key(binding)) ?? {};
  return environmentScope(project, ENVIRONMENT).resource(binding.binding, binding.kind, naming);
}

/** Every shipped manifest's declared naming, by `<capability>/<binding>` — read once, for the whole file. */
const MANIFEST_NAMING = new Map(provisionableBindings().map((binding) => [key(binding), binding.naming]));

describe("every provisionable binding has exactly one name", () => {
  const manifestBindings = provisionableBindings();

  test("the sweep finds the manifests at all, so nothing below passes vacuously", () => {
    // Every assertion in this file is a filter over one of these two lists, and a filter over an empty
    // list is green. A `PACKAGES` path that moved would leave the whole gate passing while checking none.
    expect(capabilityPackages().length).toBeGreaterThan(15);
    expect(manifestBindings.length).toBeGreaterThan(15);
  });

  test("every provisionable binding in a shipped manifest has a row", () => {
    const declared = new Set(DECLARED.map(key));
    const missing = [...new Set(manifestBindings.filter((binding) => !declared.has(key(binding))).map(key))].sort();
    expect(
      missing,
      "A manifest declares a d1, kv or r2 binding this table does not know about. Add a row to DECLARED naming the capability's own namer for the resource, or `null` if the generic `<project>-<env>-<binding>` rule is its only writer.",
    ).toEqual([]);
  });

  test("every row names a binding some manifest still declares", () => {
    // The inverse. A renamed or deleted binding leaves a row asserting nothing — and, if it carried an
    // exemption, a tracked defect that has silently stopped being tracked.
    const shipped = new Set(manifestBindings.map(key));
    const stale = DECLARED.filter((row) => !shipped.has(key(row)))
      .map(key)
      .sort();
    expect(stale, "DECLARED names a binding no manifest declares any more. Remove the row.").toEqual([]);
  });

  test("every row agrees with the manifest about the kind of resource", () => {
    // A row that says `d1` for an `r2` binding would compare a name against a namespace nothing provisions
    // it in — the comparison would still run, and would still pass or fail, for the wrong reason.
    const byKey = new Map(manifestBindings.map((binding) => [key(binding), binding.kind]));
    const wrong = DECLARED.filter((row) => byKey.has(key(row)) && byKey.get(key(row)) !== row.kind)
      .map((row) => `${key(row)}: row says ${row.kind}, manifest says ${byKey.get(key(row))}`)
      .sort();
    expect(wrong).toEqual([]);
  });
});

describe("the generic composer and the capability's own namer produce one string", () => {
  /** Every row with a second namer that is not a tracked exemption — the rows that must agree today. */
  const compared = DECLARED.filter((row) => row.namer !== null && row.exemption === undefined);

  test("there is something to compare", () => {
    expect(compared.length).toBeGreaterThan(0);
  });

  for (const project of [SHORT_PROJECT, LONG_PROJECT]) {
    test(`byte-identical for a ${project.length}-character project name`, () => {
      const disagreements = compared
        .filter((row) => genericName(project, row) !== row.namer?.(project, ENVIRONMENT))
        .map(
          (row) =>
            `${key(row)}: provision says ${genericName(project, row)}, ${row.why.split(" — ")[0]} says ${row.namer?.(project, ENVIRONMENT)}`,
        )
        .sort();
      expect(
        disagreements,
        "Two writers compose different names for one resource. Whichever is right, only one of them may be composing it — that is #513.",
      ).toEqual([]);
    });
  }

  test("the long project name is the longest a config can declare", () => {
    // The comparison above is worth its second case only if this string is actually at the boundary. A
    // hand-typed literal drifts the moment `MAX_PROJECT_NAME`'s derivation moves, and drifts *quietly*,
    // because a shorter name agrees more easily rather than less.
    expect(LONG_PROJECT.length).toBe(MAX_PROJECT_NAME);
  });
});

describe("the disagreements that may stand", () => {
  test("are exactly the ones EXEMPT names — none", () => {
    const exempted = DECLARED.filter((row) => row.exemption !== undefined)
      .map(key)
      .sort();
    expect(
      exempted,
      "An exemption is a defect this gate has agreed not to fail on. Adding one is a decision with an issue behind it, not a way past a red test.",
    ).toEqual([...EXEMPT].sort());
  });

  test("each names its follow-up", () => {
    const unattributed = DECLARED.filter(
      (row) => row.exemption !== undefined && !EXEMPTION_ISSUE.test(row.exemption.issue),
    )
      .map((row) => `${key(row)}: ${row.exemption?.issue}`)
      .sort();
    expect(unattributed, "Every exemption names the issue that deletes it, as `#519`.").toEqual([]);
  });

  test("each still disagrees — a fixed one is a row to delete, not a row to keep", () => {
    // The half that makes an exemption temporary, and the half that did its job: #519 landed, media's and
    // storage's namers converged with their manifests, and this test is what said so. Without it a fixed
    // row sits here forever claiming a defect that no longer exists — which is how the next author reads
    // this table and believes the wrong thing about the code.
    const converged = DECLARED.filter((row) => row.exemption !== undefined)
      .filter((row) =>
        [SHORT_PROJECT, LONG_PROJECT].every(
          (project) => genericName(project, row) === row.namer?.(project, ENVIRONMENT),
        ),
      )
      .map(key)
      .sort();
    expect(converged, "These now agree. Delete their exemption rows.").toEqual([]);
  });
});

/**
 * The `[` opening a `requiredBindings` array literal, in the two spellings this repo uses:
 * `requiredBindings: [` on the `defineCapability` object, and
 * `const requiredBindings: BindingSpecInput[] = [` beside it. Plus `requiredBindings.push(`, which
 * `@pithy-sh/core` uses to add a binding a config option turns on.
 */
const REQUIRED_BINDINGS =
  /requiredBindings\s*(?::[^=;\n]*)?=\s*\[|requiredBindings\s*:\s*\[|requiredBindings\.push\s*\(/g;

/** A `scope:` or `resource:` key — the two fields #513 and #519 add to `BindingSpec`, on the manifest. */
const SECOND_SOURCE = /\b(scope|resource)\s*:/;

/** The text of one `requiredBindings` literal or `.push(…)` call, brackets balanced. */
function bindingRegions(source: string): string[] {
  const text = blankComments(source);
  const regions: string[] = [];
  for (const match of text.matchAll(REQUIRED_BINDINGS)) {
    const open = match.index + match[0].length - 1;
    const closing = text[open] === "(" ? ")" : "]";
    let depth = 0;
    for (let index = open; index < text.length; index++) {
      const char = text[index];
      if (char === "[" || char === "{" || char === "(") depth++;
      else if (char === "]" || char === "}" || char === ")") {
        depth--;
        if (depth === 0) {
          if (char !== closing) break;
          regions.push(text.slice(open, index + 1));
          break;
        }
      }
    }
  }
  return regions;
}

describe("the manifest is the only place a binding's scope or resource is declared", () => {
  const packages = capabilityPackages();

  test("every capability.ts states its requiredBindings in a shape this scan can read", () => {
    // The vacuity guard, and it is the whole gate's load-bearing half: a scan that silently matches
    // nothing reports no violations, which reads exactly like a clean tree. A third spelling of
    // `requiredBindings` fails here rather than opening a hole in the test below.
    const unreadable = packages
      .filter((pkg) => bindingRegions(readFileSync(pkg.file, "utf8")).length === 0)
      .map((pkg) => pkg.dir)
      .sort();
    expect(
      unreadable,
      "This file's scan reads `requiredBindings: [`, `requiredBindings: T[] = [` and `requiredBindings.push(`. A capability spelling it a fourth way is a capability this gate does not check — teach the scan the spelling.",
    ).toEqual([]);
  });

  test("no capability declares a binding's scope or resource in its own source", () => {
    // **Two writers is the disease, not the cure.** `pithy add` reads `wiredBindings(manifest)` and never
    // reaches a composed instance — it runs before any config exists. `pithy upgrade` reads
    // `effectiveBindings`, which resolves `optional` against the instance but returns **manifest** specs.
    // Only `provision` sees an instance. A `scope` or `resource` declared here would therefore be invisible
    // to the two writers that produce the split #513 is about, while looking, in the source, exactly like
    // the fix. And it cannot be gated the way the manifest half is: a capability factory needs config, and
    // there is no config to give it that would not be inventing one.
    const violations: string[] = [];
    for (const pkg of packages) {
      for (const region of bindingRegions(readFileSync(pkg.file, "utf8"))) {
        if (SECOND_SOURCE.test(region)) violations.push(pkg.dir);
      }
    }
    expect(
      [...new Set(violations)].sort(),
      "Declare `scope` and `resource` in packages/<name>/pithy.manifest.json. `pithy add` and `pithy upgrade` both read the manifest and neither reads this.",
    ).toEqual([]);
  });
});
