// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type BindingSpec, BindingType, isProvisionedBinding } from "@pithy-sh/core/src/capability/bindings";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import {
  type CapabilityManifest,
  ConfigOption,
  renderCapabilityRegistration,
  renderConfigOptionComment,
  renderConfigOptionLine,
} from "@pithy-sh/core/src/capability/manifest";
import { type PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import type { CloudflareAccountSelection } from "../cloudflare/config";
import { type DatabaseRun, migrateProject, ProjectLedger, readProjectLedger } from "../migrations/run";
import {
  appendBinding,
  appendDurableObjectMigrations,
  type BindingScope,
  envStanzas,
  stanzaHasBinding,
  type WranglerStanza,
} from "../project/bindingEntries";
import { allCapabilities, loadWorkerConfig, readDeclinedBindings, type WorkerConfig } from "../project/config";
import { readOptionalFile } from "../project/readOptionalFile";
import { applyVersionMetadata, hasVersionMetadata } from "../project/versionMetadata";
import { workerIdentity } from "../project/workerIdentity";
import { readWranglerConfig, workerEntryPath, writeWranglerConfig } from "../project/wrangler";
import { declaresConstant } from "./configConstants";
import { exportsName } from "./configImports";
import { ejectedCapabilities } from "./eject";
import { findEntitlementGap } from "./entitlementGap";
import { durableObjectExports, withDurableObjectExports } from "./entryExports";
import { availableManifests } from "./manifests";
import { MissingPrerequisite, missingPrerequisites } from "./prerequisites";
import { requiredOptionRefusal } from "./requiredOptions";

/**
 * The shared reconcile engine behind `pithy upgrade` and (read-only) `pithy doctor` — one plan-builder,
 * two commands. {@link buildReconcilePlan} inspects **one Worker** and reports the drift between each
 * capability's manifest and that Worker's `wrangler.jsonc` + `pithy.config.ts` without writing a byte;
 * {@link applyReconcilePlan} is the write step `upgrade` runs against that plan. Doctor calls the builder
 * alone and only renders it. Both commands fan the engine out over every Worker.
 *
 * **Two directories, deliberately distinct.** `workerDir` (`apps/<name>/`) is the *wiring*: the Worker's own
 * `pithy.config.ts` and `wrangler.jsonc` — what a plan reads and an apply writes. `projectDir` (the repo root)
 * is only where **manifests** resolve from, since packages install once into the root
 * `node_modules/@pithy-sh/*` and every Worker shares them.
 *
 * **Installed is not composed.** Because that one install is shared, the manifests at the root are every
 * capability installed *anywhere* in the project — not what this Worker is made of. A plan is therefore scoped
 * to the Worker's own composed set (its `pithy.config.ts`): a capability another Worker added contributes
 * nothing here. Anything else would put a foreign capability's bindings, and its Durable Object class
 * migrations, on a script that never declared them.
 */

/** A required binding a capability's manifest declares that a given environment's wrangler stanza lacks. */
export const MissingBinding = z
  .object({
    env: z
      .string()
      .describe('The environment missing the binding — "dev" for the top-level stanza, else the env.<name> key.'),
    name: z.string().describe('The Worker env binding name the capability requires (e.g. "DB", "SESSIONS").'),
    type: BindingType.describe(
      "The kind of Cloudflare resource the binding refers to (d1, kv, r2, durable_object, …).",
    ),
  })
  .describe("A required binding absent from one environment's wrangler.jsonc stanza.");
export type MissingBinding = z.infer<typeof MissingBinding>;

/** A binding an apply was asked to write and could not, with the reason the writer gave. */
export const SkippedBinding = MissingBinding.extend({
  reason: z
    .string()
    .describe(
      "Why the entry could not be composed, in an operator's words — the field the spec did not state, or the name that could not be derived.",
    ),
}).describe(
  "A required binding `pithy upgrade` could not write. Named rather than counted: reporting the plan instead of the write is what made `upgrade` claim five bindings it had declined, while `doctor` correctly still called them missing (#318).",
);
export type SkippedBinding = z.infer<typeof SkippedBinding>;

/**
 * One entry in a Worker's `declinedBindings`, resolved against what it actually composes.
 *
 * **Four states, because "declined" is a claim that can be wrong in three distinct ways**, and each
 * wants a different sentence from an operator surface. `honored` is the working case. `required` and
 * `undeclinable` are refusals — an upgrade stops before it writes anything, because both mean the
 * adopter believes a binding is being left out that is not. `unrecognized` is neither: nothing is
 * being left out for it, which is worth a line and is never worth failing a project over, since
 * `pithy remove <capability>` produces it and no command could then clear the red.
 */
export const BindingDecline = z
  .discriminatedUnion("state", [
    z
      .object({
        state: z.literal("honored").describe("The decline is being applied — this binding is left out."),
        name: z.string().describe("The binding name, as the adopter wrote it and as the capability declares it."),
        type: BindingType.describe("The kind of Cloudflare resource the declined binding refers to."),
        capability: z.string().describe("The composed capability that declares this binding as optional."),
        reason: z.string().describe("The adopter's own reason, printed back verbatim by `pithy doctor`."),
        stillPresentIn: z
          .array(z.string())
          .describe(
            "Environments whose wrangler.jsonc still carries a stanza for it — written by an upgrade that ran before the decline. Declining stops the binding being re-added; it never deletes what is already there, because removing a binding an adopter may still be pointing at is not a reporting command's decision.",
          ),
      })
      .describe("A decline this Worker's composition supports, and which upgrade is applying."),
    z
      .object({
        state: z.literal("required").describe("The binding is not optional — the decline is refused."),
        name: z.string().describe("The binding name the adopter declined."),
        type: BindingType.describe("The kind of Cloudflare resource it refers to."),
        capability: z.string().describe("A composed capability that requires this binding outright."),
        reason: z.string().describe("The adopter's stated reason, carried so the refusal can quote the line."),
      })
      .describe(
        "A decline of a binding some composed capability requires. Refused: `optional` is the capability's own statement that its code has a path for the absence, and a required binding has none — leaving it out is a boot failure, not a configuration.",
      ),
    z
      .object({
        state: z.literal("undeclinable").describe("The binding's kind cannot be declined — the decline is refused."),
        name: z.string().describe("The binding name the adopter declined."),
        type: BindingType.describe("The kind that cannot be declined: workflow or durable_object."),
        capability: z.string().describe("The composed capability that declares it."),
        reason: z.string().describe("The adopter's stated reason, carried so the refusal can quote the line."),
      })
      .describe(
        "A decline of a kind where `optional` does not mean what it means elsewhere. For a Workflow, absent means *not provisioned yet* — `pithy <capability> provision` is the fix, and declining it only hides the instruction. For a Durable Object it is worse: a class migration tag is written once and never revisited, so a decline that arrives after one upgrade cannot undo what an earlier one stamped.",
      ),
    z
      .object({
        state: z.literal("unrecognized").describe("Nothing this Worker composes declares this binding."),
        name: z.string().describe("The binding name the adopter declined."),
        reason: z.string().describe("The adopter's stated reason, carried so the line can quote it."),
      })
      .describe(
        "A decline naming a binding no composed capability declares. Reported, never fatal: `pithy remove <capability>` leaves exactly this state behind, and a CLI that failed on it would create a red no command could clear.",
      ),
  ])
  .describe("One `declinedBindings` entry, resolved against what this Worker composes.");
export type BindingDecline = z.infer<typeof BindingDecline>;

/**
 * A Worker's whole `declinedBindings` declaration, or the fact that it could not be read.
 *
 * The same two-state shape as {@link EntitlementGap} and the ledger, for the same reason: a declaration
 * that does not parse is neither "declines nothing" nor a crash, and a count cannot say so. `pithy
 * doctor` reports it; `pithy upgrade` refuses on it before writing.
 */
export const BindingDeclines = z
  .discriminatedUnion("state", [
    z
      .object({
        state: z.literal("read").describe("The declaration parsed."),
        declines: z.array(BindingDecline).describe("Every entry, resolved. Empty is the ordinary case."),
      })
      .describe("A `declinedBindings` declaration that parsed, with each entry resolved."),
    z
      .object({
        state: z.literal("invalid").describe("The declaration is present and malformed."),
        problem: z
          .string()
          .describe("What is wrong with it, naming the entry — an operator's sentence, not a Zod dump."),
      })
      .describe("A `declinedBindings` declaration that is present and cannot be read."),
  ])
  .describe(
    "This Worker's declined optional bindings, resolved against its composition — or the fact that the declaration could not be read.",
  );
export type BindingDeclines = z.infer<typeof BindingDeclines>;

/**
 * Whether a binding of this kind may never be declined.
 *
 * **Two rules, and only one of them is hand-written.** A *provisioned* kind — `secret`, `workflow`,
 * `vectorize` — is one whose resource exists only after `pithy <capability> provision`, so `optional`
 * there means *not provisioned yet*, never *not wanted*: declining it suppresses the very binding the
 * provision command exists to supply, and hides the instruction that would have fixed it. That set is
 * asked of {@link isProvisionedBinding} rather than copied, because a copy is a list that stops
 * agreeing the day a kind joins it — the first draft here listed only `workflow` and silently admitted
 * declines of the other two.
 *
 * A Durable Object is refused for a different reason and so is named separately:
 * `appendDurableObjectMigrations` writes a `new_sqlite_classes` tag once and never revisits a class
 * already named by one, so a decline arriving after an upgrade cannot undo that upgrade's stamp and
 * would leave the tag and the binding disagreeing permanently. Un-stamping one is how a Durable Object
 * loses its storage, so there is no repair to offer either.
 */
function isUndeclinableKind(type: BindingType): boolean {
  return isProvisionedBinding(type) || type === "durable_object";
}

/** The sentence that says what a kind's absence actually means, for an operator reading a refusal. */
export function undeclinableReason(type: BindingType): string {
  if (type === "durable_object") {
    return "A Durable Object's class migration tag is written once and never revisited, so this cannot be taken back later.";
  }
  return "Absent means not provisioned.";
}

/** A capability config option present in the manifest but not yet written into its pithy.config.ts call. */
export const MissingConfigKey = z
  .object({
    // Every field is the manifest's own contract, not a copy of one. The copied `default` was a scalar
    // union, so an option whose value is a literal only the adopter can fill in — the one `pithy add
    // secrets` could not render at all (#161) — was the one option `pithy upgrade` could not report as
    // missing either. That value is now a whole worked example (#168), which is exactly why it is
    // rendered through the manifest's own `renderConfigOptionLine` rather than by anything this file
    // writes itself (#171). `key` and `describe` were still bare `z.string()` here after #174 narrowed
    // them at the manifest, which is the same copy waiting to drift the same way.
    key: ConfigOption.shape.key.describe(
      "The option name to add to the capability's registration call in pithy.config.ts.",
    ),
    default: ConfigOption.shape.default.describe(
      "The manifest default rendered as the option's value (an adopter can change it afterward). Absent for a **required** option — one the manifest states no default for, because the answer is the adopter's. The key is still reported, so `pithy doctor` names the drift; what `pithy upgrade` cannot do is choose a value for it.",
    ),
    choices: ConfigOption.shape.choices.describe(
      "The closed set this option takes, when it states one — carried so a refusal to write a required key can name the legal values rather than only the key.",
    ),
    describe: ConfigOption.shape.describe.describe(
      "The option's rationale, rendered as the comment above it in pithy.config.ts.",
    ),
    constant: ConfigOption.shape.constant.describe(
      "Present when this option is written as one of the scaffolded config's constants — `publicOrigin` renders as `PUBLIC_ORIGIN` — instead of as `default`. Only when this Worker's pithy.config.ts declares it; an older project keeps the literal rather than being handed an identifier nothing defines.",
    ),
  })
  .describe("A manifest config option not yet present in the capability's pithy.config.ts registration.");
export type MissingConfigKey = z.infer<typeof MissingConfigKey>;

/** One installed, non-ejected capability's drift: the bindings and config keys its manifest adds beyond the project. */
export const CapabilityReconcile = z
  .object({
    name: z.string().describe("The capability's short name (its manifest name)."),
    missingBindings: z
      .array(MissingBinding)
      .describe("Required bindings absent from one or more environments' wrangler.jsonc stanzas."),
    missingConfigKeys: z
      .array(MissingConfigKey)
      .describe("Manifest config options not yet present in this capability's pithy.config.ts registration."),
    missingEntryExports: z
      .array(z.string())
      .describe(
        "Durable Object classes this capability binds in this Worker that the module its `main` names does not export. wrangler resolves `class_name` against that module and refuses the deploy without it, so this is drift a `wrangler.jsonc` read alone cannot see: the binding is there and the class is nowhere. An upgrade writes them.",
      ),
  })
  .describe("The reconcile drift for a single installed, non-ejected capability.");
export type CapabilityReconcile = z.infer<typeof CapabilityReconcile>;

/**
 * Whether this Worker's routes gate on an entitlement nothing composed provides — or that the scan could
 * not run (#371).
 *
 * The scan reads the Worker's own source tree, so it fails the way a directory fails: a permission, a
 * symlink loop, a tree that moved mid-read. An empty `gates` array was the answer for both "no gate" and
 * "no scan", and only one of those is good news — so the list lives behind `read` and a caller reaches it
 * by narrowing.
 */
export const EntitlementGap = z
  .discriminatedUnion("state", [
    z
      .object({
        state: z.literal("read").describe("The Worker's source tree was scanned."),
        gates: z
          .array(z.string())
          .describe(
            "This Worker's own source files that gate a route on an entitlement while nothing it composes provides one, relative to its directory. Empty means no gap — the healthy state.",
          ),
      })
      .describe("The scan's answer. An empty list here is a real answer and means there is no gap."),
    z
      .object({
        state: z.literal("unavailable").describe("The Worker's source tree could not be scanned."),
      })
      .describe(
        "No scan was made, so nothing is known about this Worker's gates. Deliberately empty: nothing derived from the failure travels, and there is no empty list here to mistake for no gap.",
      ),
  ])
  .describe(
    "The entitlement-composition gap for one Worker, or that it could not be looked for. The file list sits behind the discriminant, so `no gap` and `no scan` cannot be confused.",
  );
export type EntitlementGap = z.infer<typeof EntitlementGap>;

/** The read-only reconcile plan: what an upgrade would add, what it would skip, and how far the schema is behind. */
export const ReconcilePlan = z
  .object({
    worker: z.string().describe("The Worker this plan targets, as its apps/<name> directory — what --worker accepts."),
    deployedAs: z
      .string()
      .describe("The same Worker's deployed script name, from wrangler.jsonc — what the Cloudflare dashboard shows."),
    env: z.string().describe("The environment the pending-migration count was computed for."),
    perCapability: z
      .array(CapabilityReconcile)
      .describe("Per installed, non-ejected capability: the bindings and config keys an upgrade would add."),
    ejectedSkipped: z
      .array(z.string())
      .describe("Ejected capabilities, by name — never reconciled, since ejected code no longer tracks its package."),
    ledger: ProjectLedger.describe(
      "What `env`'s databases have applied against what this Worker declares, in both directions — unapplied migrations (which an upgrade applies with --migrate) and migrations the ledger records that nothing declares any more (which it cannot: whether to restore the migration or drop its ledger row depends on what the database holds, so it is report-only). It is the ledger's own four-way value rather than two flat fields, because a database that could not be read is neither of those things and a count alone cannot say so (#282, #371).",
    ),
    entitlements: EntitlementGap.describe(
      "Whether this Worker gates a route on an entitlement while nothing it composes provides one — and whether the question could be asked at all. Report-only: an upgrade cannot fix it, because which capability to compose is the adopter's decision.",
    ),
    missingPrerequisites: z
      .array(MissingPrerequisite)
      .describe(
        "Capabilities this Worker composes whose manifest declares a peer it does not compose. The Worker will not assemble: createBackend refuses on exactly this pair, so it is a boot failure rather than drift. Report-only, like the entitlement gap — composing a capability is the adopter's decision, and `pithy add <cap> --with-prerequisites` is the command that makes it.",
      ),
    declinedBindings: BindingDeclines.describe(
      "Optional bindings this Worker's pithy.config.ts declines, each resolved against what it composes. An honored decline is left out of wrangler.jsonc by an upgrade and reported as declined rather than missing by doctor; a refused one stops an upgrade before it writes. It rides the plan because `applyReconcilePlan` re-reads nothing — plan and write must be one decision, which is what #318 cost when they were two.",
    ),
    missingVersionMetadata: z
      .boolean()
      .describe(
        "Whether this Worker's wrangler.jsonc lacks the `version_metadata` binding named `CF_VERSION_METADATA`. Without it a Worker cannot report which build is running, so log records carry no `version`, audit events carry no build id, and `pithy deploy` cannot verify the deploy it just made. An upgrade adds it; a config naming a different binding is reported and left alone.",
      ),
  })
  .describe(
    "A read-only reconcile plan for one Worker: binding/config drift, ejected skips, pending migrations, and the entitlement composition gap.",
  );
export type ReconcilePlan = z.infer<typeof ReconcilePlan>;

/** The one Worker a migration seam runs against, plus the project root its local D1 state lives under. */
export interface MigrationScope {
  /** The project root — the owner of the shared `.wrangler/state` store, not a source of wiring. */
  projectDir: string;
  /** The Worker's directory — its `wrangler.jsonc` supplies the D1 bindings and their ids. */
  workerDir: string;
  /** The Worker's name, so the migration run reports against it. */
  worker: string;
  /** The environment to run against. */
  env: string;
  /**
   * The Cloudflare account this project belongs to, from `projectCloudflareAccount(projectDir)`, or
   * `null` when it names none. Required (#234): `pithy upgrade --migrate --env staging` reaches a real
   * D1 through this scope, and the account it reaches it in is the project's, never the default file's.
   */
  account: CloudflareAccountSelection | null;
  /** The Worker's composed capabilities — the migration registry. */
  capabilities: Capability[];
}

/**
 * A scope that will **write**: the same Worker, plus the project every database it touches is claimed
 * for. Separate from {@link MigrationScope} because the read side is not the write side — `pithy doctor`
 * counts pending migrations on a project that may have no `name` yet, while `pithy upgrade --migrate`
 * must name itself or leave a database unowned for the next project to adopt.
 */
export interface MigrateScope extends MigrationScope {
  /** The project name (root `pithy.config.ts` `name`, via `requireProjectName`) each database is claimed for. */
  project: string;
}

/**
 * Read one Worker's migration ledger for an environment — the migration seam, injectable for tests.
 *
 * It used to return a number, and that number was the whole of what any caller could learn: how many
 * declared migrations had not run. An applied migration the project no longer declares is invisible to
 * that subtraction and is the state that stops `pithy migrate` dead, so the seam returns the comparison
 * rather than one side of it (#282).
 */
export type ReadLedger = (options: MigrationScope) => Promise<ProjectLedger>;

/** Run one Worker's migrations for an environment — the apply-time migration seam, injectable for tests. */
export type RunMigrate = (options: MigrateScope) => Promise<DatabaseRun[]>;

// The migration entry points fan out over `apps/` themselves; reconcile is already inside that fan-out, so it
// hands them the single pre-resolved Worker it is reconciling. `projectDir` stays the project root — the local
// Miniflare store lives at `<root>/.wrangler/state`, shared with `wrangler dev`, never per Worker.
function scopeFor({ projectDir, workerDir, worker, env, capabilities, account }: MigrationScope) {
  return { projectDir, env, account, workers: [{ name: worker, dir: workerDir, capabilities }] };
}

const defaultReadLedger: ReadLedger = (scope) => readProjectLedger(scopeFor(scope));

const defaultRunMigrate: RunMigrate = async (scope) =>
  (await migrateProject({ ...scopeFor(scope), project: scope.project })).flatMap((run) => run.databases);

/** Options for {@link buildReconcilePlan}. `capabilities` may be passed to skip loading (and executing) pithy.config.ts. */
export interface BuildReconcilePlanOptions {
  /** The project root — only where `node_modules/@pithy-sh/*` (and so every capability manifest) resolves from. */
  projectDir: string;
  /** The Worker's directory (`apps/<name>/`) — the wiring: its own pithy.config.ts and wrangler.jsonc. */
  workerDir: string;
  /**
   * The Worker's **deployed** script name, from its `wrangler.jsonc`. Reported on the plan as
   * `deployedAs`; the plan's `worker` is always `workerDir`'s basename and is never taken from here.
   * Defaults to the basename when a caller has no config to read.
   */
  worker?: string;
  /** The environment the pending-migration count is computed for. Binding drift is reported across every environment regardless. */
  env: string;
  /**
   * The Worker's composed capabilities (libraries + app) — **the scope of the whole plan**, not just its
   * migration count. Only a capability named here is reconciled; one installed at the project root for
   * another Worker contributes nothing. Loaded from this Worker's own `pithy.config.ts` when omitted.
   */
  capabilities?: Capability[];
  /**
   * The Cloudflare account this project belongs to, or `null` when it names none. Reaches the plan's one
   * network-capable step, the pending-migration count, and nothing else (#234).
   */
  account: CloudflareAccountSelection | null;
  /** Test seam: read the migration ledger without a real Miniflare/D1 run. */
  readLedger?: ReadLedger;
  /**
   * Test seam: find the entitlement gap without a source tree that refuses to read.
   *
   * It exists for the same reason `readLedger` does. The walk behind {@link findEntitlementGap} is
   * deliberately hard to make throw — `ci/sourceFiles.ts` treats a directory it cannot list as skipped —
   * and a guard nobody can drive is a guard nobody can prove. #371's gate on this contributor plants the
   * throw through here.
   */
  findGap?: (workerDir: string, capabilities: readonly Capability[]) => Promise<string[]>;
  /**
   * This Worker's own `pithy.config.ts`, as its caller already loaded it.
   *
   * Only `declinedBindings` is read from it, and **the whole object rather than that one field on
   * purpose**: {@link readDeclinedBindings} also refuses a key that is nearly `declinedBindings`, and
   * it can only see such a key if it is handed the object the adopter actually wrote. Passing the
   * field alone made that check unreachable — every real config arrived as a synthetic two-key object
   * and `declined_bindings` sailed through, which is the silence this whole feature removes.
   *
   * It travels beside `capabilities` rather than being re-read here for the same reason `capabilities`
   * does: both callers already hold the loaded config, and reading it twice is how the two commands
   * would come to disagree about one Worker.
   */
  workerConfig?: WorkerConfig;
}

/** Escape a capability name for use inside a `RegExp`. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The bindings a capability actually needs *in this Worker*.
 *
 * A manifest is one static file and cannot vary with config, so a binding a capability needs only under
 * a particular setting is declared there as `optional` — the seam's `CONTROL_PLANE` KV, which nothing
 * reads under the default `d1` replay backend.
 *
 * **The manifest decides what is required; the composed instance decides whether an optional one is
 * needed here.** Non-optional entries always apply — that is what the manifest is for, and it is the
 * only source available to `pithy add`, which runs before any config exists. An optional entry is
 * included only when this Worker's *composed* capability genuinely requires it, which is knowable
 * because `controlplane({ replayBackend: "kv" })` pushes the KV binding, non-optional, exactly when it
 * is needed.
 *
 * Both halves matter. Skipping optional bindings outright left an adopter who selected `kv` with no
 * binding written by any CLI path and a hard assembly failure at boot. Taking the composed instance's
 * list wholesale instead would make the manifest dead weight and would report nothing at all for a
 * caller that passes a name-only capability marker.
 *
 * **`declined` is the third source, and the adopter's.** A capability can only say a binding is optional;
 * it cannot know that this Worker's account has no R2. Only the `optional` half is filtered, so a
 * decline can never remove a binding the composition genuinely requires.
 *
 * The parameter is required and undefaulted **on purpose**. This is the single function every consumer
 * resolves `optional` through — the plan, the entry-export check, the stanza writer, the Durable Object
 * migration tagger, and the entry-export writer — and #318 was exactly the shape where one of them
 * answered from a different list than the others. A sixth consumer must be a compile error, not a
 * silent write.
 */
function effectiveBindings(
  manifest: CapabilityManifest,
  composed: Capability | undefined,
  declined: ReadonlySet<string>,
): BindingSpec[] {
  const required = manifest.requiredBindings.filter((binding) => !binding.optional);
  const optional = manifest.requiredBindings.filter((binding) => binding.optional);
  if (optional.length === 0) return required;

  const needed = new Set((composed?.requiredBindings ?? []).map((binding) => `${binding.type}:${binding.name}`));
  return [
    ...required,
    ...optional.filter((binding) => needed.has(`${binding.type}:${binding.name}`) && !declined.has(binding.name)),
  ];
}

/**
 * The binding names an upgrade is actually leaving out, from a plan.
 *
 * One helper rather than a filter at each apply-side call site, so three writers cannot each decide
 * what "declined" means. Only `honored` entries count: a refused decline is refused everywhere, and an
 * unrecognized one names nothing to leave out.
 */
/**
 * Resolve a Worker's declared declines against the capabilities it actually composes.
 *
 * Every entry lands in exactly one of {@link BindingDecline}'s four states, decided in this order:
 *
 * 1. **`required`** if *any* composed capability declares the binding non-optionally. Any, not all:
 *    two capabilities may share a binding name — that is how Workers share one D1 — and a binding one
 *    of them needs outright is not declinable because another calls it optional.
 * 2. **`undeclinable`** if the binding's kind is one where `optional` does not mean "not wanted".
 * 3. **`honored`** if some composed capability declares it optionally.
 * 4. **`unrecognized`** otherwise. Nothing is being left out for it.
 *
 * Sorted by name so two runs of `pithy doctor` over one unchanged project print the same report — a
 * `--json` consumer diffing two runs must not see a reordering as a change.
 */
function resolveDeclines(
  declared: Record<string, string>,
  manifests: readonly CapabilityManifest[],
  composed: ReadonlySet<string>,
  ejected: readonly string[],
  stanzas: readonly { env: string; stanza: WranglerStanza }[],
  instances: ReadonlyMap<string, Capability>,
): BindingDecline[] {
  // Only what this Worker composes and has not ejected — the same scope the rest of the plan uses.
  // An ejected capability's code no longer tracks its package, so its manifest says nothing about
  // what this Worker binds.
  // **Sorted, because the capability named in the report is chosen from this order.** `manifests` comes
  // from an unsorted `readdir`, and fifteen shipped capabilities declare `d1 DB` — so declining it named
  // `auth` on one machine and `media` on another, in the terminal and in `--json` alike. The decision is
  // the same either way; the sentence must not be, or two runs of one unchanged project disagree.
  const relevant = manifests
    .filter((manifest) => composed.has(manifest.name) && !ejected.includes(manifest.name))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  return Object.entries(declared)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, reason]): BindingDecline => {
      const declarers = relevant.flatMap((manifest) =>
        manifest.requiredBindings.filter((binding) => binding.name === name).map((binding) => ({ manifest, binding })),
      );
      // **Both sources, and either one is enough to refuse.** `effectiveBindings` states the rule this
      // follows: the manifest says what is required everywhere, and the composed instance says what is
      // required *here*. `@pithy-sh/core` is the live case — its manifest marks `CONTROL_PLANE`
      // optional, because a manifest is one static file and cannot vary with config, while
      // `controlplane({ replayBackend: "kv" })` pushes the same binding non-optionally, because under
      // that setting the replay guard reads it on every request and there is no absence path at all.
      // Reading the manifest alone resolved that decline as `honored` and had `pithy doctor` print
      // "takes its optional path" about a Worker that would 500 on every control-plane route.
      const requiredBy =
        declarers.find(({ binding }) => !binding.optional) ??
        declarers.find(({ manifest }) =>
          (instances.get(manifest.name)?.requiredBindings ?? []).some(
            (binding) => binding.name === name && !binding.optional,
          ),
        );
      if (requiredBy) {
        return {
          state: "required",
          name,
          type: requiredBy.binding.type,
          capability: requiredBy.manifest.name,
          reason,
        };
      }
      const optionalBy = declarers[0];
      if (!optionalBy) return { state: "unrecognized", name, reason };
      if (isUndeclinableKind(optionalBy.binding.type)) {
        return {
          state: "undeclinable",
          name,
          type: optionalBy.binding.type,
          capability: optionalBy.manifest.name,
          reason,
        };
      }
      return {
        state: "honored",
        name,
        type: optionalBy.binding.type,
        capability: optionalBy.manifest.name,
        reason,
        // Computed from the stanzas already read, so declining tells the adopter what an earlier
        // upgrade left behind rather than leaving them to find it. It is reported, never deleted:
        // removing a binding they may still be pointing at is not a reporting command's decision.
        stillPresentIn: stanzas
          .filter(({ stanza }) => stanzaHasBinding(stanza, optionalBy.binding) === true)
          .map(({ env }) => env),
      };
    });
}

/**
 * The binding names a Worker is leaving out, resolved from its config against what it composes.
 *
 * **The one export of this rule, for callers that hold no plan.** `pithy provision` and `pithy feature
 * create` create the resource behind each provisionable binding, and a decline that stopped `pithy
 * upgrade` writing a binding while provisioning still made the bucket handed the adopter exactly the
 * resource they had declined (#440). They reach the same {@link resolveDeclines} the plan does rather
 * than re-deciding what "declined" means — a second expression of a four-state rule is how two commands
 * come to disagree, which is this issue one level up.
 *
 * No stanzas, because `stillPresentIn` is a fact about a `wrangler.jsonc` and provisioning is not
 * reading one; the field is empty here and nothing consumes it. Only `honored` names come back, so a
 * refused decline changes nothing about what is provisioned — exactly as it changes nothing about what
 * is written.
 */
export function honoredDeclineNames(options: {
  /** Every installed capability manifest, read once by the caller — this is called per Worker. */
  manifests: readonly CapabilityManifest[];
  /** That Worker's composed capabilities. */
  capabilities: readonly Capability[];
  /** That Worker's own `pithy.config.ts`. Absent means it declines nothing. */
  workerConfig?: WorkerConfig | undefined;
  /** Capabilities this Worker has ejected, whose manifests no longer describe its wiring. */
  ejected?: readonly string[];
}): ReadonlySet<string> {
  const read = readDeclinedBindings(options.workerConfig ?? { capabilities: [] });
  if (read.state === "invalid") return new Set();
  const composed = new Set(options.capabilities.map((capability) => capability.name));
  const byName = new Map(options.capabilities.map((capability) => [capability.name, capability]));
  const declines = resolveDeclines(read.declared, options.manifests, composed, options.ejected ?? [], [], byName);
  return new Set(declines.filter((decline) => decline.state === "honored").map((decline) => decline.name));
}

function honoredDeclines(plan: ReconcilePlan): ReadonlySet<string> {
  if (plan.declinedBindings.state !== "read") return new Set();
  return new Set(
    plan.declinedBindings.declines.filter((decline) => decline.state === "honored").map((decline) => decline.name),
  );
}

/** Every required binding absent from an environment, across every environment. Unsupported kinds are skipped. */
function computeMissingBindings(
  manifest: CapabilityManifest,
  stanzas: { env: string; stanza: WranglerStanza }[],
  composed: Capability | undefined,
  declined: ReadonlySet<string>,
): MissingBinding[] {
  const missing: MissingBinding[] = [];
  for (const binding of effectiveBindings(manifest, composed, declined)) {
    for (const { env, stanza } of stanzas) {
      const has = stanzaHasBinding(stanza, binding);
      if (has === null) break; // unsupported kind — the same for every env, skip it entirely
      if (!has) missing.push({ env, name: binding.name, type: binding.type });
    }
  }
  return missing;
}

/** A located capability registration call in pithy.config.ts source. */
type RegistrationLocation =
  | { form: "oneliner"; indent: string; presentKeys: string[] }
  | { form: "block"; indent: string; presentKeys: string[]; closeIndex: number };

/** From a `{`, the index of its matching `}` — string- and comment-aware so braces in strings/comments don't miscount. */
function matchBrace(source: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  let quote = "";
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      if (nl === -1) return -1;
      i = nl;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** True when the next non-whitespace character at or after `from` is a `:` — i.e. the token before it is a key. */
function followedByColon(body: string, from: number): boolean {
  let k = from;
  while (k < body.length && /\s/.test(body[k] as string)) k++;
  return body[k] === ":";
}

/**
 * The top-level object keys in a registration body — string- and comment-aware (line and block comments),
 * recognizing both bare identifier keys (`basePath:`) and quoted keys (`"base-path":`, `'x':`). Scalars-only
 * bodies. A quoted key is returned unquoted, so it compares equal to the manifest option name.
 */
function objectKeys(body: string): string[] {
  const keys: string[] = [];
  let i = 0;
  let depth = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      // Consume the whole string, then — at depth 0 and followed by `:` — record it as a quoted key.
      const quote = ch;
      let j = i + 1;
      while (j < body.length && body[j] !== quote) {
        if (body[j] === "\\") j += 2;
        else j++;
      }
      if (depth === 0 && followedByColon(body, j + 1)) keys.push(body.slice(i + 1, j));
      i = j + 1;
      continue;
    }
    if (ch === "/" && body[i + 1] === "/") {
      const nl = body.indexOf("\n", i);
      if (nl === -1) break;
      i = nl + 1;
      continue;
    }
    if (ch === "/" && body[i + 1] === "*") {
      const end = body.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      i++;
      continue;
    }
    if (depth === 0 && ch !== undefined && /[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < body.length && /[\w$]/.test(body[j] as string)) j++;
      if (followedByColon(body, j)) keys.push(body.slice(i, j));
      i = j;
      continue;
    }
    i++;
  }
  return keys;
}

/** Find a capability's registration call in pithy.config.ts source, and which option keys it already carries. */
export function locateRegistration(source: string, name: string): RegistrationLocation | null {
  const re = new RegExp(`^([ \\t]*)${escapeRegExp(name)}[ \\t]*\\(`, "m");
  const match = re.exec(source);
  if (!match) return null;
  const indent = match[1] ?? "";
  const parenIndex = match.index + match[0].length - 1;
  let i = parenIndex + 1;
  while (i < source.length && /\s/.test(source[i] as string)) i++;
  const ch = source[i];
  if (ch === ")") return { form: "oneliner", indent, presentKeys: [] };
  if (ch === "{") {
    const closeIndex = matchBrace(source, i);
    if (closeIndex === -1) return null;
    return { form: "block", indent, presentKeys: objectKeys(source.slice(i + 1, closeIndex)), closeIndex };
  }
  return null;
}

/** Manifest config options not yet written into the capability's registration. Unregistered → nothing to add. */
function computeMissingConfigKeys(manifest: CapabilityManifest, configSource: string): MissingConfigKey[] {
  if (manifest.configOptions.length === 0) return [];
  const location = locateRegistration(configSource, manifest.name);
  if (!location) return [];
  return manifest.configOptions
    .filter((option) => !location.presentKeys.includes(option.key))
    .map((option) => ({
      key: option.key,
      // Conditional, because an absent default is a real state and not a missing field: an option the
      // manifest states none for is required, and the plan says so by carrying none either.
      ...(option.default === undefined ? {} : { default: option.default }),
      ...(option.choices === undefined ? {} : { choices: option.choices }),
      describe: option.describe,
      // Decided against this Worker's own source, by the same function `pithy add` calls — so the two
      // commands write the same line for the same option, which is the whole reason the renderers are
      // shared (#171). An `upgrade` on a project that predates the scaffolded constant keeps the literal.
      ...(option.constant && declaresConstant(configSource, option.constant) ? { constant: option.constant } : {}),
    }));
}

/** Read a Worker's pithy.config.ts source as text (never executed here); an unreadable file yields no config drift. */
async function readConfigSource(workerDir: string): Promise<string> {
  try {
    return await readFile(join(workerDir, "pithy.config.ts"), "utf8");
  } catch {
    return "";
  }
}

/**
 * The Worker entry's source as text, or `""` when there is no entry to read.
 *
 * Degraded per contributor, like the config source beside it: a Worker whose `wrangler.jsonc` names no
 * `main` — a front end that joins the dev set through `pithy.worker.jsonc` alone — has no entry, and a
 * plan that threw over it would take the other four contributors down with it.
 */
async function readEntrySource(workerDir: string): Promise<string> {
  const path = await workerEntryPath(workerDir).catch(() => null);
  if (path === null) return "";
  // Discarded on purpose, on the terms `readConfigSource` above is — `readOptionalFile.test.ts` holds the
  // sentence. An entry that will not open establishes no export drift; naming every class the Worker
  // binds would be a guess, and taking the other four contributors down over it is #371's own defect.
  return (await readOptionalFile(path).catch(() => null)) ?? "";
}

/**
 * The Durable Object classes this capability binds here that the Worker's entry does not export.
 *
 * **A plan reports what an apply writes.** The apply wrote these and no plan mentioned them, so a project
 * wired before that landed — binding present, export nowhere — read as clean under `pithy doctor` and
 * `pithy upgrade --dry-run` while `wrangler deploy` refused it by name. That is #428's own shape one level
 * up: a property of the entry that nobody states, so nothing checks it, and the failure arrives at deploy.
 * `doctor` is the command an adopter runs *because* something is wrong, so it is the last place a silent
 * property belongs.
 *
 * An entry that could not be read reports nothing rather than everything: an unreadable file is not an
 * entry missing an export, and a plan that guessed would name every class the Worker binds.
 */
function computeMissingEntryExports(bindings: readonly BindingSpec[], entrySource: string): string[] {
  if (entrySource === "") return [];
  return durableObjectExports(bindings)
    .filter((entry) => !exportsName(entrySource, entry.className))
    .map((entry) => entry.className);
}

/** A Worker with no `wrangler.jsonc` has no stanzas to reconcile — report no binding drift rather than failing. */
async function readStanzas(workerDir: string): Promise<{ env: string; stanza: WranglerStanza }[]> {
  try {
    return envStanzas((await readWranglerConfig(workerDir)) as WranglerStanza);
  } catch {
    return [];
  }
}

/**
 * Build the read-only reconcile plan for **one Worker**. For every capability *that Worker composes* and has
 * not ejected, report the required bindings missing from each of its environments and the manifest config
 * options missing from its `apps/<name>/pithy.config.ts` call, plus the Worker's pending-migration count for
 * `env`. Manifests come from the project root (`node_modules/@pithy-sh/*`); everything else is per Worker.
 * Writes nothing — safe for `pithy doctor` to call on every run.
 */
export async function buildReconcilePlan(options: BuildReconcilePlanOptions): Promise<ReconcilePlan> {
  const { projectDir, workerDir, env } = options;
  // The deployed name, kept under its own binding because two different consumers want two different
  // things from it. `readLedger` below builds a migration scope, where the Worker is identified the way
  // the migration ledger identifies it; the plan this returns is read by a person or a script holding the
  // checkout, where the `apps/` directory is the useful handle. Collapsing them is pithy-sh/pithy#144.
  const deployedAs = options.worker ?? basename(workerDir);
  const capabilities = options.capabilities ?? allCapabilities(await loadWorkerConfig(workerDir));
  const readLedger = options.readLedger ?? defaultReadLedger;

  const { manifests } = await availableManifests(projectDir);
  const ejected = await ejectedCapabilities(workerDir);
  const configSource = await readConfigSource(workerDir);
  const entrySource = await readEntrySource(workerDir);
  const stanzas = await readStanzas(workerDir);
  // The Worker's own composed set, by name. Manifests resolve from the shared root install, so this is the
  // only thing that distinguishes "installed in the project" from "part of this Worker".
  const composed = new Set(capabilities.map((capability) => capability.name));
  // The composed instances, by name. Their `requiredBindings` are config-aware where a manifest cannot
  // be — see `effectiveBindings`.
  const byName = new Map(capabilities.map((capability) => [capability.name, capability]));

  // Resolved before the loop below, because every one of that loop's three contributors resolves
  // `optional` through `effectiveBindings` and must resolve it the same way. `readDeclinedBindings`
  // reports rather than throws: a declaration that will not parse costs its own line and leaves the
  // rest of the plan standing, exactly as the ledger and entitlement contributors do (#371).
  const read = readDeclinedBindings(options.workerConfig ?? { capabilities });
  const declinedBindings: BindingDeclines =
    read.state === "invalid"
      ? { state: "invalid", problem: read.problem }
      : { state: "read", declines: resolveDeclines(read.declared, manifests, composed, ejected, stanzas, byName) };
  // The names an upgrade is actually leaving out. A refused decline changes nothing about what is
  // written — the refusal happens at the apply gate, so the plan still reports the binding as missing
  // and the adopter sees both facts.
  const honored = new Set(
    declinedBindings.state === "read"
      ? declinedBindings.declines.filter((decline) => decline.state === "honored").map((decline) => decline.name)
      : [],
  );

  const perCapability: CapabilityReconcile[] = [];
  for (const manifest of manifests) {
    if (ejected.includes(manifest.name)) continue; // ejected — reported below, never reconciled
    if (!composed.has(manifest.name)) continue; // installed at the root for another Worker — not this one's
    perCapability.push({
      name: manifest.name,
      missingBindings: computeMissingBindings(manifest, stanzas, byName.get(manifest.name), honored),
      missingConfigKeys: computeMissingConfigKeys(manifest, configSource),
      // The same binding set the stanzas are compared against — a class is exported exactly when this
      // Worker binds it.
      missingEntryExports: computeMissingEntryExports(
        effectiveBindings(manifest, byName.get(manifest.name), honored),
        entrySource,
      ),
    });
  }
  perCapability.sort((a, b) => a.name.localeCompare(b.name));
  const ejectedSkipped = [...ejected].sort((a, b) => a.localeCompare(b));

  // **Every contributor to this plan is guarded, and none of them is load-bearing (#371).** A plan is a
  // report, and a report is read by an adopter trying to find out why something is wrong — so one
  // contributor failing must cost its own line and leave the other four standing. The two below were the
  // unguarded ones; the config source, the wrangler stanzas and the version-metadata read beside them
  // have degraded per contributor since they were written.
  //
  // Neither guard takes a binding. `readLedger` reaches a customer's D1 and `findEntitlementGap` walks
  // their source tree, so both throw with paths, ids and queries in them — nothing derived from either
  // reaches this plan, which `pithy upgrade --json` prints.
  //
  // `try`/`catch` rather than `.catch()`, because `readLedger` is an injectable seam: a `.catch()` guards
  // a rejected promise and not a function that threw before returning one.
  let ledger: ProjectLedger;
  try {
    ledger = await readLedger({
      projectDir,
      workerDir,
      worker: deployedAs,
      env,
      capabilities,
      account: options.account,
    });
  } catch {
    ledger = { state: "unavailable" };
  }
  // Report-only, and scoped to this Worker's own source: the gates are on its routes, and the provider is
  // in its composed set, so the question is per Worker exactly as the rest of the plan is.
  let entitlements: EntitlementGap;
  try {
    entitlements = { state: "read", gates: await (options.findGap ?? findEntitlementGap)(workerDir, capabilities) };
  } catch {
    entitlements = { state: "unavailable" };
  }
  // Not a capability binding, so it does not travel through the manifest path above: no capability
  // requires it, every Worker wants it, and the platform populates it. It is a property of the scaffold,
  // and the reason it is reconciled at all is that it shipped missing from both templates once already.
  //
  // Only when the config is actually readable. A Worker with no `wrangler.jsonc` — a Vite frontend that
  // joins the dev set through `pithy.worker.jsonc` and never deploys — is not missing a binding, it is
  // missing a deploy target, and reporting drift an apply then declines to fix is worse than silence.
  // The same holds for a config with a syntax error: the honest answer is that this cannot be assessed.
  const wrangler = await readWranglerConfig(workerDir).catch(() => null);
  const missingVersionMetadata = wrangler !== null && !hasVersionMetadata(wrangler);
  return {
    ...workerIdentity({ name: deployedAs, dir: workerDir }),
    env,
    perCapability,
    ejectedSkipped,
    declinedBindings,
    ledger,
    entitlements,
    // Across every composed capability, ejected ones included: eject copies the source, it does not
    // change what that source composes against, and `createBackend` asks the same question of both.
    missingPrerequisites: missingPrerequisites(manifests, composed),
    missingVersionMetadata,
  };
}

/**
 * Append every binding a capability needs in this Worker to one environment's stanza.
 *
 * The entries are `project/bindingEntries.ts`'s, the same writer `pithy add` uses. Reconcile used to
 * carry its own copy, "kept in lockstep by intent" with `add`'s, and the two had already drifted: `add`
 * stamped a spec's `remote` flag and wrote the Workers AI binding, this did neither, so a capability
 * wired by `pithy upgrade` got a different config from the same manifest than one wired by `pithy add`.
 *
 * The KV name proposal the writer returns is dropped here on purpose: `upgrade` reports drift, and a KV
 * namespace title is something `pithy add` tells the adopter to create at the moment they compose the
 * capability, not something a later reconcile can act on.
 */
function appendBindings(
  stanza: WranglerStanza,
  manifest: CapabilityManifest,
  scope: BindingScope,
  composed: Capability | undefined,
  declined: ReadonlySet<string>,
): { written: MissingBinding[]; skipped: SkippedBinding[] } {
  const written: MissingBinding[] = [];
  const skipped: SkippedBinding[] = [];
  // Same source of truth as the plan — see `effectiveBindings`. Writing from the manifest here while the
  // plan reported from the composed instance would make `upgrade` decline to write the binding it had
  // just told the adopter was missing.
  for (const binding of effectiveBindings(manifest, composed, declined)) {
    const write = appendBinding(stanza, binding, scope);
    // `present` and `unsupported` are neither: the first is idempotency (the plan already excluded it),
    // the second a kind with no array to be missing from, which `computeMissingBindings` skips too.
    if (write.outcome === "written") written.push({ env: scope.env, name: binding.name, type: binding.type });
    if (write.outcome === "skipped") {
      skipped.push({ env: scope.env, name: binding.name, type: binding.type, reason: write.reason });
    }
  }
  return { written, skipped };
}

/**
 * Render one option's `// describe` + `key: default` lines at a given indent — the same two lines
 * `pithy add` renders, through the same function, because "matching `pithy add`" was a comment and not
 * a mechanism. This called `JSON.stringify` while `add` called `renderConfigValue`, so one manifest
 * default came out as `{"code":"chips"}` here and `{ code: "chips" }` there, and only the second
 * survived the `biome check` a scaffolded project runs on itself (#171).
 */
function renderKeyLines(capability: string, keys: MissingConfigKey[], indent: string): string {
  const lines: string[] = [];
  for (const key of keys) {
    const value = key.constant ? { constant: key.constant } : key.default;
    // A required option — one the manifest states no default for — is reported as drift and cannot be
    // repaired here: `pithy upgrade` has no adopter to ask and no value it is entitled to pick, and the
    // decision is exactly the kind #412 refused to guess at. So it refuses, naming the option and what it
    // takes, rather than writing the word `undefined` into a config the adopter has to find later.
    if (value === undefined) throw requiredOptionRefusal({ capability, missing: [key] });
    lines.push(renderConfigOptionComment(key.describe, indent));
    lines.push(renderConfigOptionLine(key.key, value, indent));
  }
  return lines.join("\n");
}

/**
 * Convert a one-liner `name(),` registration to block form, inserting the missing keys.
 *
 * The call is rendered by core, not written here: it is the third place a capability's name reaches
 * generated source, and `pithy add`'s two were the ones #183 was reported about. No trailing comma —
 * the regex below matches `name()` and leaves the file's own separating comma alone.
 */
function convertOneLiner(source: string, name: string, indent: string, keys: MissingConfigKey[]): string {
  const block = renderCapabilityRegistration({
    name,
    indent,
    optionLines: [renderKeyLines(name, keys, `${indent}  `)],
    trailingComma: false,
  });
  // `indent` is the indent this very regex captured when the registration was located, so the block
  // carries its own opening indent and the match is replaced whole.
  const re = new RegExp(`^[ \\t]*${escapeRegExp(name)}[ \\t]*\\(\\s*\\)`, "m");
  // A replacement function keeps any `$` in the rendered defaults literal.
  return source.replace(re, () => block);
}

/**
 * Insert missing keys into an existing block registration, before its closing brace. Never rewrites a key.
 * A separating comma is spliced onto the prior property when it lacks a trailing one — otherwise inserting
 * after `{ x: 1 }` (an adopter's hand-written inline block) would produce `{ x: 1  y: 2 }`, invalid TypeScript.
 */
function insertIntoBlock(capability: string, source: string, closeIndex: number, keys: MissingConfigKey[]): string {
  // The last real character of the block body: `,` or `{` (empty block) means no separator is needed.
  let last = closeIndex - 1;
  while (last >= 0 && /\s/.test(source[last] as string)) last--;
  const needComma = source[last] !== "," && source[last] !== "{";

  // Splice the comma directly after the last property (not before the closing brace) so no stray space is
  // introduced, then insert the new keys before the — possibly shifted — closing brace.
  const withComma = needComma ? `${source.slice(0, last + 1)},${source.slice(last + 1)}` : source;
  const close = closeIndex + (needComma ? 1 : 0);

  const lineStart = withComma.lastIndexOf("\n", close - 1) + 1;
  const prefixOnLine = withComma.slice(lineStart, close);
  if (prefixOnLine.trim() === "") {
    // The close brace sits on its own line — insert whole key lines above it.
    const inner = `${prefixOnLine}  `;
    return `${withComma.slice(0, lineStart)}${renderKeyLines(capability, keys, inner)}\n${withComma.slice(lineStart)}`;
  }
  // Inline block (`name({ x: 1 })`) — append `key: value,` before the closing brace.
  // One space stands in for the indent: an inline block has no line of its own to sit on. The value is
  // rendered by the same function as every other writer's, so a hand-written block gets Biome's shape
  // too — the whole point of there being one renderer (#171).
  const inline = keys
    .map((key) => {
      const value = key.constant ? { constant: key.constant } : key.default;
      if (value === undefined) throw requiredOptionRefusal({ capability, missing: [key] });
      return renderConfigOptionLine(key.key, value, " ");
    })
    .join("");
  return `${withComma.slice(0, close)}${inline}${withComma.slice(close)}`;
}

/** Options for {@link applyReconcilePlan} — the write step, run only by `pithy upgrade`. */
export interface ApplyReconcilePlanOptions {
  /** The project root — where the capability manifests resolve from. */
  projectDir: string;
  /** The Worker's directory (`apps/<name>/`) — the pithy.config.ts and wrangler.jsonc this writes. */
  workerDir: string;
  /** The plan to apply, from {@link buildReconcilePlan}. */
  plan: ReconcilePlan;
  /** Run the Worker's pending migrations after reconciling; leaves them pending when false. */
  migrate: boolean;
  /** The environment migrations run against when `migrate` is set. */
  env: string;
  /**
   * The project name, resolved by the caller from the root `pithy.config.ts` (`requireProjectName`) and
   * passed as a plain string — the first segment of every `database_name` this proposes, and the owner
   * stamped on every database a `migrate` run touches.
   *
   * Optional, because the two uses have different stakes. A missing name costs the *proposal* nothing
   * worse than a binding-only entry, exactly as before, and `pithy doctor` says why. A missing name on a
   * **write** is not survivable the same way — an unstamped database is one any project can later claim
   * — so `migrate` without a project is refused below, before a single file is touched.
   */
  project?: string;
  /** The Worker's composed capabilities (libraries + app) — passed to the migration run. */
  capabilities: Capability[];
  /**
   * The Cloudflare account this project belongs to, or `null` when it names none. Required (#234) — this
   * is the write side, and `migrate` on a non-`dev` env runs the project's migrations against a live
   * schema in whichever account the credentials belong to.
   */
  account: CloudflareAccountSelection | null;
  /** Test seam: run migrations without a real Miniflare/D1 run. */
  runMigrate?: RunMigrate;
}

/** What one capability's apply changed: the bindings and config keys actually added. */
export interface CapabilityApplied {
  /** The capability's short name. */
  name: string;
  /**
   * The bindings added to wrangler.jsonc for this capability — **read back off the writer**, one entry
   * per environment actually written.
   *
   * This used to be `cap.missingBindings`: the plan, copied across verbatim the moment the apply loop
   * touched the capability at all. So a binding the writer declined was counted as added, by a command
   * whose whole job is to be believed about what it just changed (#318).
   */
  addedBindings: MissingBinding[];
  /** The bindings this capability needed that the writer could not compose, each with its reason. */
  skippedBindings: SkippedBinding[];
  /** The config option keys inserted into this capability's pithy.config.ts registration. */
  addedConfigKeys: string[];
}

/** The summary {@link applyReconcilePlan} returns — what was written, what was skipped, whether migrations ran. */
export interface ReconcileApplied {
  /** The Worker this apply targeted, carried through from the plan so a fan-out report can label it. */
  worker: string;
  /**
   * The same Worker's deployed script name, carried through from the plan beside `worker`.
   *
   * **Both names, or the payload changes shape with a flag.** `pithy upgrade --json` reports
   * `applied ?? plan` out of one `workers` array, so a key the plan carried and the apply dropped meant a
   * consumer that read `deployedAs` worked under `--dry-run` and got `undefined` on the run that actually
   * wrote something — the mode where being sure which script was reconciled matters most. #231.
   */
  deployedAs: string;
  /** Per capability that changed: the bindings and config keys added. */
  perCapability: CapabilityApplied[];
  /** Ejected capabilities, by name — reported, never touched. */
  ejectedSkipped: string[];
  /** Whether the migration step ran (only when the caller passed `migrate`). */
  migrated: boolean;
  /** The per-database migration runs, when `migrated`; empty otherwise. */
  migrations: DatabaseRun[];
  /** Whether this run added the `version_metadata` binding the Worker was missing. */
  addedVersionMetadata: boolean;
  /**
   * The Durable Object classes this run wrote an `export { … } from "…"` for into the Worker's entry.
   *
   * Reported for the reason every other field here is: `upgrade` writes a file in the adopter's repo, and
   * a change it makes without saying so is a `git diff` they have to reverse-engineer (#318). Empty on the
   * common run, which is what idempotent looks like.
   */
  addedEntryExports: string[];
}

/** Add every plan capability's missing bindings to the Worker's wrangler.jsonc, comment-preserving. Returns what was added per capability. */
async function applyBindings(
  projectDir: string,
  workerDir: string,
  plan: ReconcilePlan,
  project: string | undefined,
  capabilities: readonly Capability[],
): Promise<Map<string, { written: MissingBinding[]; skipped: SkippedBinding[] }>> {
  const added = new Map<string, { written: MissingBinding[]; skipped: SkippedBinding[] }>();
  // The one list every writer below resolves `optional` through, taken from the plan rather than
  // recomputed — `applyReconcilePlan` re-reads no file, so the plan is the only place the decline
  // exists on this side.
  const honored = honoredDeclines(plan);
  const caps = plan.perCapability.filter((cap) => cap.missingBindings.length > 0);
  if (caps.length === 0) return added;

  const byName = new Map((await availableManifests(projectDir)).manifests.map((manifest) => [manifest.name, manifest]));
  const composedByName = new Map(capabilities.map((capability) => [capability.name, capability]));
  const config = (await readWranglerConfig(workerDir)) as WranglerStanza;
  const stanzas = envStanzas(config);
  let touched = false;
  for (const cap of caps) {
    const manifest = byName.get(cap.name);
    if (!manifest) continue; // installed manifest vanished — nothing to wire
    // Each stanza is written for the environment it *is*, so the name it proposes has that environment
    // in it. `envStanzas` already pairs them on the read side; the write side uses the same pairing.
    const written: MissingBinding[] = [];
    const skipped: SkippedBinding[] = [];
    for (const { env, stanza } of stanzas) {
      const result = appendBindings(
        stanza,
        manifest,
        { ...(project === undefined ? {} : { project }), env, capability: manifest.name },
        composedByName.get(cap.name),
        honored,
      );
      written.push(...result.written);
      skipped.push(...result.skipped);
    }
    // The same list the stanzas got, never the manifest's whole set: a class migration tag registers a
    // class against the script, and one for a binding this Worker does not derive registers an actor
    // nothing can reach. A tag is applied once and never revisited, so it is not a mistake a later run
    // repairs — `capabilities/add.ts`'s `wiredBindings` states the rule for the other writer.
    appendDurableObjectMigrations(config, effectiveBindings(manifest, composedByName.get(cap.name), honored));
    added.set(cap.name, { written, skipped });
    // Only a real write dirties the file. A capability whose every binding was declined leaves
    // `wrangler.jsonc` byte-identical, and rewriting it would be a diff saying nothing happened.
    if (written.length > 0) touched = true;
  }
  if (touched) await writeWranglerConfig(workerDir, config);
  return added;
}

/**
 * Write every composed capability's Durable Object exports into the Worker's entry — **the other writer**
 * of the two halves of a Durable Object, and the one #428's first fix missed.
 *
 * `pithy add` was not the only command putting a `durable_objects.bindings` entry with a `class_name` in
 * it into a Worker: the reconcile above writes one into every environment that is missing it, and left the
 * export to a human. So the defect survived on the command an adopter reaches for *because* something is
 * wrong, and `pithy upgrade` would report a Worker fully reconciled that `wrangler deploy` still refuses:
 *
 *     Your Worker depends on the following Durable Objects, which are not exported in your entrypoint
 *     file: MultiplayerSession.
 *
 * **Over every composed capability, not only the ones with a missing binding.** A project scaffolded
 * before this landed has the bindings already and the export nowhere, so nothing in `wrangler.jsonc` is
 * missing — and that project is exactly who runs `pithy upgrade`. {@link computeMissingEntryExports} is
 * what puts the same set in the plan, so `doctor` and `--dry-run` name it too; the modules it needs to
 * *write* the line come from the manifests here, which is why this derives the set again rather than
 * reading the plan's class names. {@link withDurableObjectExports} is idempotent, so a Worker that is
 * already right is read and left alone.
 *
 * A Worker whose config names no `main` is passed over rather than refused, unlike in `pithy add`. Add
 * wires one capability into one Worker the adopter just named; upgrade fans out over every Worker in the
 * project, and a Worker with a Durable Object and no entry cannot deploy for a reason older and plainer
 * than this one. Refusing here would abandon the fan-out mid-write over a config that was already broken.
 */
async function applyEntryExports(
  projectDir: string,
  workerDir: string,
  plan: ReconcilePlan,
  capabilities: readonly Capability[],
): Promise<string[]> {
  const byName = new Map((await availableManifests(projectDir)).manifests.map((manifest) => [manifest.name, manifest]));
  const composedByName = new Map(capabilities.map((capability) => [capability.name, capability]));
  // Same list the stanza writer used. A declined Durable Object would otherwise stay exported from the
  // entry, pulling the class into the bundle for a binding nothing declares — #428's shape.
  const honored = honoredDeclines(plan);
  const exports = plan.perCapability.flatMap((cap) => {
    const manifest = byName.get(cap.name);
    // Same source of truth as the binding writer — see `effectiveBindings`. Exporting a class this Worker
    // does not bind would pull a Durable Object into the bundle for nothing.
    return manifest ? durableObjectExports(effectiveBindings(manifest, composedByName.get(cap.name), honored)) : [];
  });
  if (exports.length === 0) return [];

  const path = await workerEntryPath(workerDir).catch(() => null);
  const source = path === null ? null : await readOptionalFile(path);
  if (path === null || source === null) return [];

  const written = withDurableObjectExports(source, exports);
  if (written === source) return [];
  await writeFile(path, written);
  // What went in, decided by the same reader the writer used rather than by the intention — #318's rule,
  // and the reason this is reported at all: `upgrade` editing an adopter's entry and saying nothing is
  // that issue's shape. A class the entry already carried is not something this run added.
  return [...new Set(exports.filter((entry) => !exportsName(source, entry.className)).map((e) => e.className))];
}

/** Insert every plan capability's missing config keys into the Worker's pithy.config.ts, never rewriting an existing key. */
async function applyConfigKeys(workerDir: string, plan: ReconcilePlan): Promise<Map<string, string[]>> {
  const added = new Map<string, string[]>();
  const caps = plan.perCapability.filter((cap) => cap.missingConfigKeys.length > 0);
  if (caps.length === 0) return added;

  const path = join(workerDir, "pithy.config.ts");
  let source = await readFile(path, "utf8");
  let changed = false;
  for (const cap of caps) {
    // Re-locate on the current (possibly-mutated) source so offsets stay valid and already-present keys
    // are re-checked — that makes a re-apply of a stale plan a no-op rather than a duplicate.
    const location = locateRegistration(source, cap.name);
    if (!location) continue;
    const toAdd = cap.missingConfigKeys.filter((key) => !location.presentKeys.includes(key.key));
    if (toAdd.length === 0) continue;
    source =
      location.form === "oneliner"
        ? convertOneLiner(source, cap.name, location.indent, toAdd)
        : insertIntoBlock(cap.name, source, location.closeIndex, toAdd);
    added.set(
      cap.name,
      toAdd.map((key) => key.key),
    );
    changed = true;
  }
  if (changed) await writeFile(path, source);
  return added;
}

/**
 * The project a `--migrate` run claims each database for, or a refusal. `pithy upgrade` reconciles wiring
 * happily without a project name — the proposals just carry their binding — but the moment it is asked to
 * migrate, the name stops being cosmetic: it is the owner stamped on every database the run touches, and a
 * database left unstamped is one any other project can later claim.
 */
function requireMigrationProject(project: string | undefined): string {
  if (project === undefined) {
    throw new ValidationError({
      message: "pithy upgrade --migrate needs a project name.",
      action:
        "Set `name` in pithy.config.ts, then run pithy upgrade --migrate again. It stamps each database as this project's, so another project's database is refused instead of silently merged.",
    });
  }
  return project;
}

/**
 * The required options in a plan that nothing here can supply a value for — a manifest option with no
 * `default` and no `constant`.
 *
 * `pithy upgrade` has no adopter to ask and no value it is entitled to pick: which billing subject a
 * project uses is exactly the decision #412 refused to guess at. So the plan is refused whole, naming every
 * such option across every capability, and the Worker is left as it was.
 */
function refuseUnwritableConfigKeys(plan: ReconcilePlan): void {
  for (const cap of plan.perCapability) {
    const missing = cap.missingConfigKeys.filter((key) => key.default === undefined && key.constant === undefined);
    if (missing.length > 0) throw requiredOptionRefusal({ capability: cap.name, missing });
  }
}

/**
 * Every decline this Worker's composition cannot honor, refused before the first write.
 *
 * Three states get here and all three mean the adopter believes a binding is being left out that is
 * not — a belief that must be corrected before an upgrade writes, not after. `invalid` is the
 * declaration itself; `required` is a binding some capability needs outright, where leaving it out is a
 * boot failure rather than a configuration; `undeclinable` is a kind where `optional` means "not
 * provisioned yet" and declining only hides the command that fixes it.
 *
 * **`unrecognized` is deliberately not here.** `pithy remove <capability>` leaves exactly that state
 * behind, and a CLI that refused on it would create a failure no command could clear. It is reported by
 * `doctor` and by the upgrade summary, and it changes nothing about what gets written.
 *
 * Named together for the same reason `refuseUnwritableConfigKeys` names its options together: an
 * adopter fixing this edits one file once.
 */
function refuseUnhonorableDeclines(plan: ReconcilePlan): void {
  const refusal = declineRefusal(plan);
  if (refusal) throw refusal;
}

/**
 * The refusal a plan's declines earn, or `null` if it has none.
 *
 * **Separated from the throw so a caller can ask before it calls.** `applyReconcilePlan` catches
 * nothing and reports one shape for every failure — "Upgrade failed partway. Its wiring may hold part
 * of the plan" — which is true of a write that died mid-file and false of this, which happens before
 * the first byte. An adopter told their wiring is half-written when it is untouched will go looking for
 * damage that is not there, and never sees the action line naming the entry to remove.
 *
 * So `pithy upgrade` asks first and reports the refusal with its own words; `applyReconcilePlan` still
 * throws, because every other caller wants the failure rather than a value to inspect.
 *
 * The config-key refusal beside it is deliberately not folded in here: it has the same shape and the
 * same defect, and moving it changes output this issue did not touch. It wants its own change.
 */
export function declineRefusal(plan: ReconcilePlan): PithyError | null {
  if (plan.declinedBindings.state === "invalid") {
    return new ValidationError({
      message: "This Worker's `declinedBindings` declaration is not valid.",
      action: `Fix \`declinedBindings\` in ${plan.worker}'s pithy.config.ts. Each entry is a binding name mapped to a one-line reason. ${plan.declinedBindings.problem}`,
    });
  }
  const refused = plan.declinedBindings.declines.filter(
    (decline) => decline.state === "required" || decline.state === "undeclinable",
  );
  if (refused.length === 0) return null;
  const lines = refused.map((decline) =>
    decline.state === "required"
      ? `${decline.name} (${decline.type}) — ${decline.capability} requires it, so it is never left out.`
      : `${decline.name} (${decline.type}) — this kind cannot be declined. ${undeclinableReason(decline.type)}${
          decline.type === "durable_object" ? "" : ` Run \`pithy ${decline.capability} provision\`.`
        }`,
  );
  return new ValidationError({
    message: `This Worker declines ${refused.length === 1 ? "a binding it cannot decline" : "bindings it cannot decline"}.`,
    action: `Remove ${refused.length === 1 ? "the entry" : "these entries"} from \`declinedBindings\` in ${plan.worker}'s pithy.config.ts. ${lines.join(" ")}`,
  });
}

/**
 * Apply a reconcile plan — the write step behind `pithy upgrade`, never called by `doctor`. Adds the
 * missing bindings to the Worker's `wrangler.jsonc` and the missing config keys to its `pithy.config.ts`
 * (a one-liner call becomes block form; an existing block gains only the absent keys — an adopter-changed
 * value is never touched), then runs that Worker's migrations when `migrate` is set. Everything written is
 * inside `workerDir`. Idempotent: re-running after a build finds nothing missing and writes nothing.
 */
export async function applyReconcilePlan(options: ApplyReconcilePlanOptions): Promise<ReconcileApplied> {
  const { projectDir, workerDir, plan, env, capabilities } = options;
  const runMigrate = options.runMigrate ?? defaultRunMigrate;

  // The project to migrate as, or null for "don't migrate" — resolved first, so a nameless project fails
  // having written nothing rather than mid-fan-out with one Worker already reconciled. Reconciling wiring
  // is survivable without a name; writing to a database is not.
  const migrateAs = options.migrate ? requireMigrationProject(options.project) : null;

  // Every required option this plan cannot write, refused **before the first write**, for the same reason
  // `migrateAs` is resolved above it: `applyBindings` rewrites `wrangler.jsonc`, and a refusal raised after
  // it leaves the Worker half-reconciled — new bindings on disk, no config keys, and every *other*
  // capability's keys in the same run silently dropped. Worse, the refusal is unfixable from here by
  // construction, so `pithy upgrade` would report drift it had just made harder to see.
  //
  // Named together rather than one at a time: an adopter fixing config edits one file once, and a refusal
  // that surfaces the second required option only after they have fixed the first is two round trips for
  // one edit.
  // Before `refuseUnwritableConfigKeys`, and in that slot for exactly that comment's reason: a decline
  // this composition cannot honor is unfixable from here, and raising it after `applyBindings` has
  // rewritten `wrangler.jsonc` would leave the Worker half-reconciled against a belief that was wrong.
  refuseUnhonorableDeclines(plan);
  refuseUnwritableConfigKeys(plan);

  const addedBindings = await applyBindings(projectDir, workerDir, plan, options.project, capabilities);
  // After the bindings, deliberately: the export is the second half of a binding, and an entry re-exporting
  // a class nothing binds is the wrong file to leave behind if the write above throws.
  const addedEntryExports = await applyEntryExports(projectDir, workerDir, plan, capabilities);
  const addedConfigKeys = await applyConfigKeys(workerDir, plan);
  // Idempotent, and a no-op on a Worker that already declares it — including one that names a different
  // binding, which is reported rather than repointed.
  const addedVersionMetadata = plan.missingVersionMetadata ? await applyVersionMetadata(workerDir) : false;

  const perCapability: CapabilityApplied[] = [];
  for (const cap of plan.perCapability) {
    const bindings = addedBindings.get(cap.name) ?? { written: [], skipped: [] };
    const keys = addedConfigKeys.get(cap.name) ?? [];
    // A capability that wrote nothing but skipped something still belongs in the report — that is the
    // whole point of naming a skip. Silence here is the shape #318 was reported about.
    if (bindings.written.length === 0 && bindings.skipped.length === 0 && keys.length === 0) continue;
    perCapability.push({
      name: cap.name,
      addedBindings: bindings.written,
      skippedBindings: bindings.skipped,
      addedConfigKeys: keys,
    });
  }

  let migrated = false;
  let migrations: DatabaseRun[] = [];
  if (migrateAs !== null) {
    migrations = await runMigrate({
      projectDir,
      workerDir,
      worker: plan.worker,
      env,
      capabilities,
      account: options.account,
      project: migrateAs,
    });
    migrated = true;
  }

  return {
    worker: plan.worker,
    deployedAs: plan.deployedAs,
    perCapability,
    ejectedSkipped: plan.ejectedSkipped,
    migrated,
    migrations,
    addedVersionMetadata,
    addedEntryExports,
  };
}
