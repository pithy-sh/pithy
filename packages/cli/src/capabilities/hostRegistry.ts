// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { FeatureIdentity } from "@pithy-sh/core/src/naming/feature";
import { environmentScope, featureScope } from "@pithy-sh/core/src/naming/provisionScope";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import type { OwnedVault, StampedEncryptedColumns } from "@pithy-sh/secrets/src/provision/resolveManagerConfig";
import { parse } from "comment-json";
import { kitImport } from "../project/kitResolve";
import { kitSource } from "../project/kitSource";
import type { HostPeerSeam } from "./hostEntry";
import { composable } from "./hostWorkflows";
import { capabilityLoadError } from "./loadFailure";

/**
 * **Which capability owns which host Worker — the one production statement of it.**
 *
 * A capability that owns Workflows ships a committed `wrangler.jsonc` beside its worker entry, and
 * `pithy <capability> provision` resolves that template into one deployable config per environment. None of
 * these Workers lives in `apps/`. `pithy dev`, `pithy deploy` and `pithy provision --feature` read this table and
 * know nothing about email, media or vector; a tenth capability adds one entry here and joins all three.
 *
 * ## Why every import is dynamic
 *
 * Most of the packages below are `devDependencies` of the CLI, because a capability is optional and the CLI must
 * never hard-depend on one. So each entry resolves its resolver through a guarded `import()` at the moment the
 * project turns out to compose it, and a package that is not installed becomes {@link capabilityLoadError}'s
 * actionable refusal rather than an unresolved-module crash.
 *
 * **And every one of them is resolved from the project, never from the CLI.** A globally installed `pithy` has no
 * `@pithy-sh/payments` of its own, so asking its own `node_modules` would refuse a composed, installed, working
 * capability as "not installed". See `project/kitResolve.ts`.
 *
 * ## What a resolution is, and where its configuration comes from
 *
 * {@link HostResolveContext} is capability-agnostic on purpose: project, environment, the app's base
 * URL, the id each binding resolves to, and the composed capability object. Each entry maps that onto
 * its own resolver's bespoke parameters, which is the shape the provisioners already have and the
 * shape `hostTemplates.test.ts` already drives.
 *
 * **A capability's own configuration is read from the composed capability, always.** No entry parses
 * `Config.parse({})`, and {@link HostResolveContext.capability} is required rather than optional so a new entry
 * cannot: a host resolved on schema defaults deploys an adopter's Worker on somebody else's settings, and
 * `hostConfigParity.test.ts` holds this table and the provisioners to one configuration. A composed object that is
 * not the shape its own package defines is {@link ownCapability}'s refusal, never a default. **The dev path supplies
 * its defaults out loud instead**: `pithy dev` answers `storeId()` with the empty string at its own call site, where
 * the sentence explaining that a developer's machine has no Secrets Store can be read.
 */

/** What one host resolution needs, stated without reference to any particular capability. */
export interface HostResolveContext {
  /**
   * The project root — where `pithy.config.ts` was read from, and the base every `@pithy-sh/*` module
   * below is resolved against.
   *
   * Distinct from {@link project}, which is a *name* and resolves nothing. And never `process.cwd()`:
   * these resolvers run under `pithy dev`, where the cwd may be a worktree.
   */
  projectDir: string;
  /** The project name — the leading segment of every name the resolution derives. Never guessed. */
  project: string;
  /** The environment being resolved. `dev` for a local host; a managed name for a deploy; `feature` for a branch. */
  env: string;
  /**
   * **The feature being resolved for, when `env` is `feature`.** A host deployed for a branch takes the
   * feature's names — its script, its Workflows, its store entries — because every one of those namespaces is
   * account-wide and `<project>-feature-<capability>` would be one host every open branch shared. A resolver
   * that does not read this composes the environment's names, and `pithy deploy` refuses its row for it.
   */
  feature?: FeatureIdentity;
  /**
   * **The Worker whose own host this is, when it is one.** A Worker that owns a binding its capability's host binds
   * gets a host of its own ({@link hostOwnerFor}), named for it and bound to what it owns. Absent for the host every
   * other Worker shares. The ids {@link databaseId} answers are already that Worker's; this decides the names.
   */
  owner?: HostOwner;
  /** The app Worker's origin for this environment — what callback links are built against. */
  baseUrl: string;
  /**
   * The project's declared environments, least production first (`docs/NAMING.md`), when the caller has them.
   * The secrets manager reads the last one as the environment whose manager alone rotates a `global` secret.
   * Absent, no manager is told it owns one, so none rotates one.
   */
  environments?: readonly string[];
  /**
   * The database id a D1 binding resolves to. Under `dev` this answers the **binding name**, because
   * that is wrangler's own local key (`getRemoteId(database_id) ?? binding`) and therefore the one
   * `pithy migrate --env dev` filled. A host answering anything else opens an empty database.
   */
  databaseId: (binding: string) => string;
  /**
   * The Secrets Store id, asked for rather than read, so a host that binds the store says so by
   * calling — exactly as it says which databases it needs by calling {@link databaseId}.
   *
   * A function and not a string because the two callers answer it differently and both answers are
   * deliberate: `pithy dev` answers `""`, since a developer's machine has no store and the block is
   * stripped before the config reaches disk; `pithy deploy --kit` answers the account's id, or
   * records the miss and skips. A default here would ship `store_id: ""` from the deploy path.
   */
  storeId: () => string;
  /** The Cloudflare account id, on the same terms. Only the secrets manager stamps it into its vars. */
  accountId: () => string;
  /**
   * The project's encrypted columns and the D1 each lives in, which only the secrets manager is stamped
   * with. Supplied by `pithy deploy` for a declared environment; absent, nothing is stamped.
   */
  encryptedColumns?: () => Promise<StampedEncryptedColumns>;
  /**
   * The vaults of the Workers that own `SECRETS`, which only the shared secrets manager binds: each is sealed under
   * this environment's master key, so its at-rest rotation re-seals them. Supplied by `pithy deploy`.
   */
  ownedVaults?: () => Promise<readonly OwnedVault[]>;
  /**
   * **The composed capability this host belongs to. Required.**
   *
   * The host is in the set *because* a Worker composed it, so there is always one — `discoverHostWorkers`
   * reads it off the project's own `pithy.config.ts` for the dev path and the deploy path alike. It is
   * required rather than optional because optional is what let five entries quietly resolve an
   * adopter's Worker from schema defaults.
   */
  capability: Capability;
  /**
   * The project's **other** composed capabilities, for the one resolution that reads across
   * capabilities: testers' host mails, and its sending identity is the email capability's.
   *
   * Optional, and empty means what it says — this project composes nothing else this resolver wants.
   * That is a legitimate state (a testers host with no email capability advances roster state and
   * sends nothing), which is exactly why it may stay optional where {@link capability} may not.
   */
  siblings?: readonly Capability[];
  /**
   * No message may leave this machine. Set when `pithy dev`'s delivery preflight established that real
   * delivery is impossible here — no Cloudflare login, or a from address nobody could onboard — so the
   * host is resolved for its local simulator instead of a binding that would fail at startup.
   *
   * Capability-agnostic by wording and acted on today only by `email`, which is the one capability
   * holding a binding that puts a message on the wire.
   */
  simulateDelivery?: boolean;
}

/**
 * What a capability would put on the wire from a developer's machine, when it puts anything there.
 *
 * On {@link HostWorkerSpec} rather than read off the composed capability by the dev command, so
 * `pithy dev`'s delivery preflight asks every host the same question and branches on none of them.
 * One capability answers today: `email` holds the kit's only binding that sends a message.
 */
export interface HostDeliveryIdentity {
  /** The delivery mode the adopter's config selected. `simulator` is a choice, not a failure. */
  requested: "remote" | "simulator";
  /** The address messages are sent from. Its domain is what must be onboarded onto the service. */
  fromAddress?: string;
}

/**
 * **One index a host binds that a feature must create for itself** — a Vectorize index, which the generic
 * feature provisioning (D1, KV, R2) has no kind for, because an index is created with a shape. Named for the
 * feature, bound by the host and the app Worker under the same binding, and deleted with the feature.
 */
export interface FeatureIndex {
  /** The binding both the host and the app Worker read the index through, e.g. `VECTORIZE`. */
  binding: string;
  /** The feature's own index name. */
  name: string;
  /** The vector width the index is created with. Fixed at creation. */
  dimensions: number;
  /** The distance metric the index is created with. Fixed at creation. */
  metric: "cosine" | "euclidean" | "dot-product";
  /** The metadata indexes to create on it, as `pithy vector provision` does. */
  metadata: readonly { propertyName: string; indexType: string }[];
}

/** One capability's host Worker: where its template and entry live, and how a context resolves it. */
export interface HostWorkerSpec {
  /** The capability's name — the key a composed `Capability` is matched against, and the host's label. */
  readonly capability: string;
  /** The worker entry module the host runs. Its sibling `wrangler.jsonc` is the template. */
  readonly entry: string;
  /** The npm package the entry ships in, named when the guarded import fails. */
  readonly package: string;
  /**
   * The D1 and R2 bindings the host reads, by the app Worker's binding names. A Worker owning any of them gets a
   * host of its own ({@link hostOwnerFor}). Read off the composed capability, because one host reads the database
   * its capability's config names.
   */
  binds(capability: Capability): readonly string[];
  /**
   * The buckets this host keys or sweeps against one of its databases. A Worker that owns the database and shares
   * the bucket is refused ({@link hostOwnerFor}): its own host would read its database against objects another
   * database's host also writes or deletes. With `bothWays`, owning the bucket and sharing the database is refused
   * too, for a bucket whose keys never name the database, so two hosts over one database would each hold half of
   * its record. Absent for a host whose bucket holds nothing keyed to a database row.
   */
  pairedBuckets?(capability: Capability): readonly PairedBucket[];
  /** Fill the template for one environment. Throws {@link capabilityLoadError} when the package is absent. */
  resolve(template: WorkflowHostTemplate, context: HostResolveContext): Promise<WorkflowHostTemplate>;
  /** What this host would send from a developer's machine, or `undefined` when it sends nothing. */
  delivery?(capability: Capability, projectDir: string): Promise<HostDeliveryIdentity | undefined>;
  /**
   * The indexes this host binds that a feature creates for itself, named for the feature, and for `owner` when they
   * are a Worker's own host's. Absent for a host that binds none — every resource it binds is then one the generic
   * feature provisioning names. With `skipUncomposable`, an index whose name the namer refuses is left out rather than
   * thrown: no provision could have created it, so a teardown has nothing to delete under it.
   */
  featureIndexes?(
    capability: Capability,
    projectDir: string,
    feature: FeatureIdentity,
    owner?: string,
    options?: FeatureIndexOptions,
  ): Promise<FeatureIndex[]>;
  /**
   * The optional peers this host can be handed, and which of them a composition hands it. Absent for a
   * host that reaches no optional peer. See `hostEntry.ts` for why a host is handed a peer rather than
   * importing it, and how.
   */
  readonly peers?: HostPeerSeam;
}

/** How {@link HostWorkerSpec.featureIndexes} treats a name the namer refuses. */
export interface FeatureIndexOptions {
  /** Leave such an index out instead of throwing. Teardown sets it; provisioning never does. */
  skipUncomposable?: boolean;
}

/** One composed index name, or none when `options` skips a name the namer refuses. */
function indexNames(compose: () => string, options: FeatureIndexOptions = {}): string[] {
  return options.skipUncomposable ? composable(compose) : [compose()];
}

/** The Worker a host is the own host of, and the bindings it owns that the host binds. */
export interface HostOwner {
  /** The `apps/<worker>` directory name — the owner segment of every name the host takes. */
  worker: string;
  /** The bindings the host binds that this Worker owns. Never empty. */
  bindings: readonly string[];
}

/** A bucket a host keys to the rows of one database ({@link HostWorkerSpec.pairedBuckets}). */
export interface PairedBucket {
  readonly database: string;
  readonly bucket: string;
  /** Whether owning the bucket while sharing the database is refused as well. */
  readonly bothWays?: boolean;
}

/**
 * **Whether a Worker gets a host of its own for a capability, and for which bindings.** One rule for every host: the
 * Worker owns a binding the host binds. Its jobs and rows are then in its own resources, so a host shared with the
 * other Workers would read the wrong ones. `undefined` when the Worker owns none of them and shares the host.
 */
export function hostOwnerFor(
  spec: HostWorkerSpec,
  capability: Capability,
  worker: { dir: string; ownBindings?: readonly string[] },
  options: { refuseSplit?: boolean } = {},
): HostOwner | undefined {
  const owned = new Set(worker.ownBindings ?? []);
  if (owned.size === 0) return undefined;
  const name = basename(worker.dir);
  if (options.refuseSplit !== false) {
    for (const { database, bucket, bothWays } of spec.pairedBuckets?.(capability) ?? []) {
      if (owned.has(database) && !owned.has(bucket)) {
        throw new ValidationError({
          message: `${name} owns ${database} but shares ${bucket}. The ${spec.capability} host keys ${bucket} to the rows in ${database}, so one Worker owns both or neither.`,
          action: `Add ${bucket} to apps/${name}/pithy.worker.jsonc ownBindings, or take ${database} out.`,
        });
      }
      if (bothWays && owned.has(bucket) && !owned.has(database)) {
        throw new ValidationError({
          message: `${name} owns ${bucket} but shares ${database}. The ${spec.capability} host keys ${bucket} to the rows in ${database}, so one Worker owns both or neither.`,
          action: `Add ${database} to apps/${name}/pithy.worker.jsonc ownBindings, or take ${bucket} out.`,
        });
      }
    }
  }
  const bindings = spec.binds(capability).filter((binding) => owned.has(binding));
  return bindings.length > 0 ? { worker: name, bindings } : undefined;
}

/** The absolute path of the `wrangler.jsonc` committed beside a host's worker entry, in the project's copy. */
export function hostTemplatePath(projectDir: string, entry: string): string {
  return join(dirname(kitSource(projectDir, entry)), "wrangler.jsonc");
}

/**
 * Read a capability's committed template exactly as its provisioner does — resolved through the
 * module graph rather than a relative path, so a moved package still resolves, and parsed with
 * `comment-json` because the file is JSONC and heavily commented.
 */
export async function readHostTemplate(projectDir: string, entry: string): Promise<WorkflowHostTemplate> {
  return parse(await readFile(hostTemplatePath(projectDir, entry), "utf8")) as unknown as WorkflowHostTemplate;
}

/**
 * Run a guarded dynamic import, turning an absent optional package into an actionable refusal.
 *
 * `projectDir` is what lets the refusal be honest: {@link capabilityLoadError} checks the project's own
 * `node_modules` before it is allowed to say "not installed" and print `pithy add`.
 */
async function load<T>(capability: string, pkg: string, projectDir: string, importer: () => Promise<T>): Promise<T> {
  try {
    return await importer();
  } catch (error) {
    throw await capabilityLoadError(capability, pkg, error, projectDir);
  }
}

/**
 * **The feature and the owner a resolution is for, spread into every resolver's params the same way.** Every kit
 * host a feature composes is deployed for it, and a Worker's own host is named for that Worker, so every entry below
 * hands this on — `pithy deploy` refuses a feature host any of whose names is not the feature's, so an entry that
 * forgot would fail rather than deploy a Worker every branch shares. See `feature/hosts.ts`.
 */
function hostScopeOf(context: HostResolveContext): { feature?: FeatureIdentity; owner?: string } {
  return {
    ...(context.feature ? { feature: context.feature } : {}),
    ...(context.owner ? { owner: context.owner.worker } : {}),
  };
}

/**
 * The bucket an R2 binding names in this resolution: the capability's own namer for a declared environment, and
 * the feature's own bucket — the one `pithy provision --feature` created for the same binding — for a feature.
 */
function bucketName(context: HostResolveContext, binding: string, own: () => string): string {
  const owner = context.owner?.bindings.includes(binding) ? context.owner.worker : undefined;
  if (context.feature) return featureScope(context.feature).resource(binding, "r2", {}, owner);
  if (owner === undefined) return own();
  return ownedBucketName(context.project, context.env, context.capability, binding, owner);
}

/**
 * The bucket `pithy provision` created for a Worker's own R2 binding, `<project>-<env>-<owner>---<binding>`, named
 * with the binding's declared naming. What a Worker's own host binds, from the kit pass and from
 * `pithy <capability> provision --worker <owner>` alike.
 */
function ownedBucketName(project: string, env: string, capability: Capability, binding: string, owner: string): string {
  const naming = capability.requiredBindings.find((spec) => spec.name === binding) ?? {};
  return environmentScope(project, env).resource(binding, "r2", naming, owner);
}

/** The three ids every host that reads a secret needs, mapped off the context in one place. */
function shared(context: HostResolveContext) {
  return {
    project: context.project,
    env: context.env,
    ...hostScopeOf(context),
    appDatabaseId: context.databaseId("DB"),
    secretsDatabaseId: context.databaseId("SECRETS"),
    // Asked for, so the four hosts that bind the store are the four that ask. Whether an unanswerable
    // one is `""` or a skipped row is the caller's decision and is made at the caller — see
    // {@link HostResolveContext.storeId}.
    storeId: context.storeId(),
  };
}

/**
 * **The host's own composed capability, narrowed by its package's own type guard — or a refusal.**
 *
 * The one place a capability's configuration enters a resolution, and deliberately the only one. A fallback to
 * `Config.parse({})` when the guard says no would read as defensive and fire on exactly the input nobody
 * anticipated, and what it produces is an adopter's Worker deployed on somebody else's settings.
 *
 * A guard says no when the object composed under this name is not the one the package defines — an
 * adopter's own `defineCapability({ name: "media" })`, or two copies of the package in one graph. Both
 * are real, both are the adopter's to fix, and neither is a reason to deploy defaults over their
 * configuration. So it throws, which reaches an operator as a `failed` row under `pithy deploy` and as
 * a named, non-fatal note under `pithy dev` — the same treatment a capability whose package will not
 * load already gets.
 */
function ownCapability<T extends Capability>(
  context: HostResolveContext,
  capability: string,
  pkg: string,
  guard: (value: Capability) => value is T,
): T {
  if (guard(context.capability)) return context.capability;
  throw new ValidationError({
    message: `The composed ${capability} capability does not carry its configuration.`,
    action: `Compose it with ${capability}({ ... }) from ${pkg} in the Worker's pithy.config.ts.`,
    detail: `${pkg}: the object composed under the name "${context.capability.name}" is not the one this package defines.`,
  });
}

/**
 * **The sending identity testers' host mails from — the project's email capability's, or none.**
 *
 * The one place a resolution reads across capabilities, and it reads {@link HostResolveContext.siblings}
 * for it. The four fields are the same four `pithy testers provision` copies (`commands/testers.ts`),
 * `messages` included: the daily-pass host composes nothing, so the project's catalogs can only reach
 * it as a var, and a host without them mails the kit's English however many languages the project
 * speaks.
 *
 * **`undefined` is a state and not a failure**, and it is the only one: the pass advances roster state,
 * writes its snapshot, and sends nothing. `resolveTestersConfig` then deletes the three `EMAIL_*`
 * placeholders the template carries, so nothing deploys looking configured to send. A default address
 * would be worse than none — mail from a domain the adopter's DKIM does not cover trains recipients'
 * providers to distrust the real one.
 */
async function testersSendingIdentity(context: HostResolveContext) {
  // The name first, so a project composing no email capability never asks its package for anything.
  // A sibling *named* email was composed from the package, so the import below cannot be an absence.
  const sibling = (context.siblings ?? []).find((capability) => capability.name === "email");
  if (!sibling) return undefined;
  const { isEmailCapability } = await load("email", "@pithy-sh/email", context.projectDir, () =>
    kitImport<typeof import("@pithy-sh/email/src/capability")>(context.projectDir, "@pithy-sh/email/src/capability"),
  );
  if (!isEmailCapability(sibling)) return undefined;
  return {
    fromAddress: sibling.emailConfig.fromAddress,
    fromName: sibling.emailConfig.fromName,
    theme: sibling.emailConfig.theme,
    messages: sibling.hostCatalogs(),
  };
}

/**
 * **Whether a catalog credits a balance** — any product with a `grants.ledger` clause. Read structurally off the
 * composed object: the CLI holds `@pithy-sh/payments` by type alone, and this is one field of its config.
 */
export function catalogCreditsBalance(capability: Capability): boolean {
  const config = (capability as { paymentsConfig?: { products?: Record<string, { grants?: { ledger?: unknown } }> } })
    .paymentsConfig;
  return Object.values(config?.products ?? {}).some((product) => product.grants?.ledger !== undefined);
}

/**
 * The payments host's peers: the ledger, handed over when the catalog credits a balance.
 *
 * Keyed on the catalog, not on whether a ledger happens to be composed. `payments()` refuses a crediting
 * catalog with no ledger at assembly, so the two agree on every project that runs; and where they would not,
 * an entry naming a ledger the project never installed fails this deploy by name, which is better than a host
 * that deploys and then fails every credit a pass repairs.
 */
export const PAYMENTS_HOST_PEERS: HostPeerSeam = {
  provide: "@pithy-sh/payments/src/workflows/hostPeers",
  needed: (capability) =>
    catalogCreditsBalance(capability)
      ? [{ capability: "ledger", module: "@pithy-sh/ledger/src/peer", export: "ledgerPeer" }]
      : [],
};

/**
 * The testers host's peers: auth, handed over when the project composes it, so the pass can see activity. The
 * kit's auth by its shape (`authConfig`), so an adopter's own capability that happens to be called `auth` is not
 * mistaken for a package the project may never have installed.
 */
export const TESTERS_HOST_PEERS: HostPeerSeam = {
  provide: "@pithy-sh/testers/src/workflows/hostPeers",
  needed: (_capability, siblings) =>
    siblings.some((sibling) => sibling.name === "auth" && "authConfig" in sibling)
      ? [{ capability: "auth", module: "@pithy-sh/auth/src/peer", export: "authPeer" }]
      : [],
};

/**
 * Every capability that ships a host Worker, and how one environment's config is filled.
 *
 * `@pithy-sh/leaderboard` is deliberately absent: its rank worker ships a complete template and a
 * `RankRefreshWorkflow`, but no `resolveLeaderboardConfig` and no provisioner — there is nothing to
 * drive, and driving it here would mean writing the resolver. `hostRegistry.test.ts` pins that
 * absence against what is on disk, so it cannot become an oversight.
 */
export const HOST_WORKERS: readonly HostWorkerSpec[] = [
  {
    capability: "email",
    entry: "@pithy-sh/email/src/workflows/worker",
    package: "@pithy-sh/email",
    binds: () => ["DB", "EMAIL_SUPPRESSIONS", "SECRETS"],
    async resolve(template, context) {
      const [{ resolveEmailConfig }, { isEmailCapability }] = await load(
        "email",
        "@pithy-sh/email",
        context.projectDir,
        () =>
          Promise.all([
            kitImport<typeof import("@pithy-sh/email/src/provision/resolveEmailConfig")>(
              context.projectDir,
              "@pithy-sh/email/src/provision/resolveEmailConfig",
            ),
            kitImport<typeof import("@pithy-sh/email/src/capability")>(
              context.projectDir,
              "@pithy-sh/email/src/capability",
            ),
          ]),
      );
      // The capability that has always handed its resolved config to whoever composed it. The theme
      // and the delivery mode are both the adopter's, so the local host renders and sends exactly
      // what the deployed one would.
      const composed = ownCapability(context, "email", "@pithy-sh/email", isEmailCapability);
      return resolveEmailConfig(template as Parameters<typeof resolveEmailConfig>[0], {
        ...shared(context),
        suppressionDatabaseId: context.databaseId("EMAIL_SUPPRESSIONS"),
        // **The context's, never `email({ baseUrl })`.** That key is the *deployed* app's public
        // origin and is required, so it is always set — and a local host resolved against it mints
        // every tracked click, open pixel and unsubscribe link at production, signed with the local
        // signing key. `context.baseUrl` is the origin for the environment being resolved, which is
        // the app's own address in the one environment this resolver is used from.
        baseUrl: context.baseUrl,
        theme: composed.emailConfig.theme,
        // The local host renders through the same catalogs the deployed one is stamped with, so a
        // Spanish magic link looks the same on a developer's machine as it does in production. Empty
        // when nothing composed an i18n capability, and then no var is written at all.
        //
        // True only because `discoverHostWorkers` assembles the set before handing a capability here —
        // `hostCatalogs()` answers `{}` on one whose `compose` hook has not run.
        messages: composed.hostCatalogs(),
        devDelivery: context.simulateDelivery ? "simulator" : composed.emailConfig.devDelivery,
      });
    },
    async delivery(capability, projectDir) {
      const { isEmailCapability } = await load("email", "@pithy-sh/email", projectDir, () =>
        kitImport<typeof import("@pithy-sh/email/src/capability")>(projectDir, "@pithy-sh/email/src/capability"),
      );
      if (!isEmailCapability(capability)) return undefined;
      return { requested: capability.emailConfig.devDelivery, fromAddress: capability.emailConfig.fromAddress };
    },
  },
  {
    capability: "media",
    entry: "@pithy-sh/media/src/workflows/worker",
    package: "@pithy-sh/media",
    binds: () => ["DB", "SECRETS", "MEDIA_BUCKET"],
    async resolve(template, context) {
      const [{ resolveMediaConfig }, { mediaBucketName }, { isMediaCapability }] = await load(
        "media",
        "@pithy-sh/media",
        context.projectDir,
        () =>
          Promise.all([
            kitImport<typeof import("@pithy-sh/media/src/provision/resolveMediaConfig")>(
              context.projectDir,
              "@pithy-sh/media/src/provision/resolveMediaConfig",
            ),
            kitImport<typeof import("@pithy-sh/media/src/provision/provisionMedia")>(
              context.projectDir,
              "@pithy-sh/media/src/provision/provisionMedia",
            ),
            kitImport<typeof import("@pithy-sh/media/src/capability")>(
              context.projectDir,
              "@pithy-sh/media/src/capability",
            ),
          ]),
      );
      const { mediaConfig } = ownCapability(context, "media", "@pithy-sh/media", isMediaCapability);
      return resolveMediaConfig(template, {
        ...shared(context),
        resources: {
          // **The capability's own namer, not a second derivation of it.** An R2 binding names its
          // bucket, so there is no account-minted id to read — but which name is the capability's to
          // say, and `pithy media provision` creates the bucket by calling exactly this. A local
          // `resourceNames(project).env(env).r2("MEDIA")` stood here, and the same shortcut in the
          // vector entry composed `<project>-<env>-<index>` against the provisioner's
          // `<project>-<env>-vector-<index>` — a deployed Worker bound to an index nobody created.
          bucketName: bucketName(context, "MEDIA_BUCKET", () => mediaBucketName(context.project, context.env)),
        },
        mediaConfig,
      });
    },
  },
  {
    capability: "storage",
    entry: "@pithy-sh/storage/src/workflows/worker",
    package: "@pithy-sh/storage",
    binds: () => ["DB", "SECRETS", "STORAGE_BUCKET"],
    // The sweep deletes every derived object older than the TTL with no row in the database it reads.
    pairedBuckets: () => [{ database: "DB", bucket: "STORAGE_BUCKET" }],
    async resolve(template, context) {
      const [{ resolveStorageConfig }, { storageBucketName }, { isStorageCapability }] = await load(
        "storage",
        "@pithy-sh/storage",
        context.projectDir,
        () =>
          Promise.all([
            kitImport<typeof import("@pithy-sh/storage/src/provision/resolveStorageConfig")>(
              context.projectDir,
              "@pithy-sh/storage/src/provision/resolveStorageConfig",
            ),
            kitImport<typeof import("@pithy-sh/storage/src/provision/provisionStorage")>(
              context.projectDir,
              "@pithy-sh/storage/src/provision/provisionStorage",
            ),
            kitImport<typeof import("@pithy-sh/storage/src/capability")>(
              context.projectDir,
              "@pithy-sh/storage/src/capability",
            ),
          ]),
      );
      return resolveStorageConfig(template, {
        ...shared(context),
        // The capability's own namer, for the reason the media entry states.
        resources: {
          bucketName: bucketName(context, "STORAGE_BUCKET", () => storageBucketName(context.project, context.env)),
        },
        storageConfig: ownCapability(context, "storage", "@pithy-sh/storage", isStorageCapability).storageConfig,
      });
    },
  },
  {
    capability: "payments",
    entry: "@pithy-sh/payments/src/workflows/worker",
    package: "@pithy-sh/payments",
    binds: () => ["DB", "SECRETS"],
    // A reconcile pass that repairs a purchase whose product credits a balance owes the credit, and this host
    // composes nothing to find a ledger in — so it is handed one, exactly when the catalog asks for it.
    peers: PAYMENTS_HOST_PEERS,
    async resolve(template, context) {
      const [{ resolvePaymentsConfig }, { isPaymentsCapability }] = await load(
        "payments",
        "@pithy-sh/payments",
        context.projectDir,
        () =>
          Promise.all([
            kitImport<typeof import("@pithy-sh/payments/src/provision/resolvePaymentsConfig")>(
              context.projectDir,
              "@pithy-sh/payments/src/provision/resolvePaymentsConfig",
            ),
            kitImport<typeof import("@pithy-sh/payments/src/capability")>(
              context.projectDir,
              "@pithy-sh/payments/src/capability",
            ),
          ]),
      );
      // Payments hands its resolved config to whoever composed it, the way email does — so the local
      // reconcile host runs the adopter's own catalog and their own `billingSubject`, and a dev pass
      // narrows to the holder kind the project actually bills.
      //
      // There is nothing to fall back to: `billingSubject` is required precisely because nothing may pick it
      // silently.
      return resolvePaymentsConfig(template, {
        ...shared(context),
        paymentsConfig: ownCapability(context, "payments", "@pithy-sh/payments", isPaymentsCapability).paymentsConfig,
      });
    },
  },
  {
    capability: "support",
    entry: "@pithy-sh/support/src/workflows/worker",
    package: "@pithy-sh/support",
    binds: () => ["DB"],
    async resolve(template, context) {
      const [{ resolveSupportConfig }, { isSupportCapability }] = await load(
        "support",
        "@pithy-sh/support",
        context.projectDir,
        () =>
          Promise.all([
            kitImport<typeof import("@pithy-sh/support/src/provision/resolveSupportConfig")>(
              context.projectDir,
              "@pithy-sh/support/src/provision/resolveSupportConfig",
            ),
            kitImport<typeof import("@pithy-sh/support/src/capability")>(
              context.projectDir,
              "@pithy-sh/support/src/capability",
            ),
          ]),
      );
      return resolveSupportConfig(template, {
        project: context.project,
        env: context.env,
        ...hostScopeOf(context),
        appDatabaseId: context.databaseId("DB"),
        supportConfig: ownCapability(context, "support", "@pithy-sh/support", isSupportCapability).supportConfig,
      });
    },
    // The semantic message index, when `search.semantic` is on: a feature gets its own, named the way the
    // resolver above binds the host to it, at the shape `pithy support provision` creates.
    async featureIndexes(capability, projectDir, feature, owner, options) {
      const [{ supportMessageIndex, supportMessageIndexName }, { isSupportCapability }] = await load(
        "support",
        "@pithy-sh/support",
        projectDir,
        () =>
          Promise.all([
            kitImport<typeof import("@pithy-sh/support/src/semantic/messageIndex")>(
              projectDir,
              "@pithy-sh/support/src/semantic/messageIndex",
            ),
            kitImport<typeof import("@pithy-sh/support/src/capability")>(
              projectDir,
              "@pithy-sh/support/src/capability",
            ),
          ]),
      );
      if (!isSupportCapability(capability)) return [];
      const index = supportMessageIndex(capability.supportConfig.search);
      if (!index) return [];
      return indexNames(() => supportMessageIndexName(feature.project, "feature", feature, owner), options).map(
        (name) => ({
          binding: index.binding,
          name,
          dimensions: index.dimensions,
          metric: index.metric,
          metadata: [],
        }),
      );
    },
  },
  {
    capability: "testers",
    // The daily pass reads whether each tester has used the app, through auth when the project composes it.
    peers: TESTERS_HOST_PEERS,
    entry: "@pithy-sh/testers/src/workflows/worker",
    package: "@pithy-sh/testers",
    binds: () => ["DB", "EMAIL_SUPPRESSIONS"],
    async resolve(template, context) {
      const [{ resolveTestersConfig }, { isTestersCapability }] = await load(
        "testers",
        "@pithy-sh/testers",
        context.projectDir,
        () =>
          Promise.all([
            kitImport<typeof import("@pithy-sh/testers/src/provision/resolveTestersConfig")>(
              context.projectDir,
              "@pithy-sh/testers/src/provision/resolveTestersConfig",
            ),
            kitImport<typeof import("@pithy-sh/testers/src/capability")>(
              context.projectDir,
              "@pithy-sh/testers/src/capability",
            ),
          ]),
      );
      return resolveTestersConfig(template, {
        project: context.project,
        env: context.env,
        ...hostScopeOf(context),
        appDatabaseId: context.databaseId("DB"),
        suppressionDatabaseId: context.databaseId("EMAIL_SUPPRESSIONS"),
        testersConfig: ownCapability(context, "testers", "@pithy-sh/testers", isTestersCapability).testersConfig,
        email: await testersSendingIdentity(context),
      });
    },
  },
  {
    capability: "vector",
    entry: "@pithy-sh/vector/src/workflows/worker",
    package: "@pithy-sh/vector",
    binds: () => ["DB"],
    async resolve(template, context) {
      const [{ resolveVectorConfig }, { vectorIndexName }, { isVectorCapability }] = await load(
        "vector",
        "@pithy-sh/vector",
        context.projectDir,
        () =>
          Promise.all([
            kitImport<typeof import("@pithy-sh/vector/src/provision/resolveVectorConfig")>(
              context.projectDir,
              "@pithy-sh/vector/src/provision/resolveVectorConfig",
            ),
            kitImport<typeof import("@pithy-sh/vector/src/provision/provisionVector")>(
              context.projectDir,
              "@pithy-sh/vector/src/provision/provisionVector",
            ),
            kitImport<typeof import("@pithy-sh/vector/src/capability")>(
              context.projectDir,
              "@pithy-sh/vector/src/capability",
            ),
          ]),
      );
      // The adopter's, not the schema's, and here the difference is the *set of indexes*: the names
      // below are derived per configured index, so a defaulted config bound a Worker to whichever
      // indexes the schema ships and to none of the ones the project declared.
      const config = ownCapability(context, "vector", "@pithy-sh/vector", isVectorCapability).vectorConfig;
      return resolveVectorConfig(template, {
        project: context.project,
        env: context.env,
        ...hostScopeOf(context),
        appDatabaseId: context.databaseId("DB"),
        // `vectorIndexName`, which is what `pithy vector provision` creates the index by. The local
        // `resourceNames(project).env(env).vectorizeIndex(index)` that stood here omitted the
        // capability segment the namer adds, so this path bound `acme-prod-notes` while provisioning
        // created `acme-prod-vector-notes` — an index nothing had made, and a search that fails.
        indexNames: Object.fromEntries(
          Object.keys(config.indexes).map((index) => [
            index,
            vectorIndexName(context.project, index, context.env, context.feature, context.owner?.worker),
          ]),
        ),
        config,
      });
    },
    async featureIndexes(capability, projectDir, feature, owner, options) {
      const [{ vectorIndexName }, { isVectorCapability }, { metadataIndexes }] = await load(
        "vector",
        "@pithy-sh/vector",
        projectDir,
        () =>
          Promise.all([
            kitImport<typeof import("@pithy-sh/vector/src/provision/provisionVector")>(
              projectDir,
              "@pithy-sh/vector/src/provision/provisionVector",
            ),
            kitImport<typeof import("@pithy-sh/vector/src/capability")>(projectDir, "@pithy-sh/vector/src/capability"),
            kitImport<typeof import("@pithy-sh/vector/src/index/metadata")>(
              projectDir,
              "@pithy-sh/vector/src/index/metadata",
            ),
          ]),
      );
      if (!isVectorCapability(capability)) return [];
      // The same names the resolver above binds the host to, and the shape `pithy vector provision` creates with.
      return Object.entries(capability.vectorConfig.indexes).flatMap(([index, config]) =>
        indexNames(() => vectorIndexName(feature.project, index, "feature", feature, owner), options).map((name) => ({
          binding: config.binding,
          name,
          dimensions: config.dimensions,
          metric: config.metric,
          metadata: config.metadata ? metadataIndexes(config.metadata) : [],
        })),
      );
    },
  },
  {
    capability: "secrets",
    entry: "@pithy-sh/secrets/src/manager/worker",
    package: "@pithy-sh/secrets",
    binds: () => ["SECRETS"],
    async resolve(template, context) {
      const { resolveManagerConfig } = await load("secrets", "@pithy-sh/secrets", context.projectDir, () =>
        kitImport<typeof import("@pithy-sh/secrets/src/provision/resolveManagerConfig")>(
          context.projectDir,
          "@pithy-sh/secrets/src/provision/resolveManagerConfig",
        ),
      );
      const { isSecretsCapability } = await load("secrets", "@pithy-sh/secrets", context.projectDir, () =>
        kitImport<typeof import("@pithy-sh/secrets/src/capability")>(
          context.projectDir,
          "@pithy-sh/secrets/src/capability",
        ),
      );
      return resolveManagerConfig(template as Parameters<typeof resolveManagerConfig>[0], {
        project: context.project,
        env: context.env,
        databaseId: context.databaseId("SECRETS"),
        storeId: context.storeId(),
        accountId: context.accountId(),
        // **The value-rotation schedule, read off every capability the project composes.** The manager
        // is prebuilt and never reads `pithy.config.ts`, so this stamp is the only way it learns which
        // secrets rotate on their own — the same one `pithy secrets provision` writes. A feature's manager
        // runs no cron and gets none, and local dev has no manager to rotate anything.
        ...(context.feature || context.env === "dev" ? {} : await secretsSchedule(context)),
        // **The cadence the project configured, not the template's literal.** The manager's cron and the
        // capability's `lastAtRestRotation` health key both grade against this number, so both must read the
        // configured one. Read off the composed capability, which is where every other host resolution reads its
        // own configuration.
        rotationIntervalDays: ownCapability(context, "secrets", "@pithy-sh/secrets", isSecretsCapability)
          .rotationIntervalDays,
        // **The encrypted columns, the same stamp `pithy secrets provision` writes.** A feature's manager
        // rotates nothing and local dev has no manager, so neither is stamped.
        ...(context.feature || context.env === "dev" || context.encryptedColumns === undefined
          ? {}
          : { encryptedColumns: await context.encryptedColumns() }),
        ...(context.feature || context.owner || context.ownedVaults === undefined
          ? {}
          : { ownedVaults: await context.ownedVaults() }),
        ...hostScopeOf(context),
      });
    },
  },
  {
    // The checkpoint host: each tenant chain's head and count, written hourly to the checkpoint bucket.
    capability: "audit",
    entry: "@pithy-sh/audit/src/workflows/worker",
    package: "@pithy-sh/audit",
    binds: (capability) => [auditDatabaseOf(capability), "AUDIT_CHECKPOINTS"],
    // A checkpoint key names a tenant and a count, never the database its chain is in, and the first write wins. A
    // prune's tombstone goes to the pruning host's bucket alone, so two hosts over one chain would each see gaps.
    pairedBuckets: (capability) => [
      { database: auditDatabaseOf(capability), bucket: "AUDIT_CHECKPOINTS", bothWays: true },
    ],
    async resolve(template, context) {
      const [{ resolveAuditConfig, auditCheckpointBucketName }, { isAuditCapability }] = await load(
        "audit",
        "@pithy-sh/audit",
        context.projectDir,
        () =>
          Promise.all([
            kitImport<typeof import("@pithy-sh/audit/src/provision/resolveAuditConfig")>(
              context.projectDir,
              "@pithy-sh/audit/src/provision/resolveAuditConfig",
            ),
            kitImport<typeof import("@pithy-sh/audit/src/capability")>(
              context.projectDir,
              "@pithy-sh/audit/src/capability",
            ),
          ]),
      );
      // The database the adopter's `audit({ database })` names, not `DB` by assumption: the host reads the trail
      // wherever the app writes it.
      const { auditDatabase } = ownCapability(context, "audit", "@pithy-sh/audit", isAuditCapability);
      return resolveAuditConfig(template, {
        project: context.project,
        env: context.env,
        ...hostScopeOf(context),
        auditDatabaseId: context.databaseId(auditDatabase),
        // The bucket `pithy provision` creates for the app's `AUDIT_CHECKPOINTS` binding, through the same namer.
        bucketName: bucketName(context, "AUDIT_CHECKPOINTS", () =>
          auditCheckpointBucketName(context.project, context.env),
        ),
      });
    },
  },
];

/** The database the adopter's `audit({ database })` names, read off the composed object by its shape. */
function auditDatabaseOf(capability: Capability): string {
  return (capability as { auditDatabase?: string }).auditDatabase ?? "DB";
}

/**
 * The value-rotation schedule the secrets manager is stamped with, from the composed capabilities: every
 * capability's registry slice aggregated the way a Worker aggregates them, and the last declared
 * environment as the one whose manager rotates a global secret.
 */
async function secretsSchedule(context: HostResolveContext) {
  const [{ aggregateSecretRegistries }, { stampedRotations }, { canonicalGlobalEnvironment }] = await load(
    "secrets",
    "@pithy-sh/secrets",
    context.projectDir,
    () =>
      Promise.all([
        kitImport<typeof import("@pithy-sh/secrets/src/sharedSecretsStore")>(
          context.projectDir,
          "@pithy-sh/secrets/src/sharedSecretsStore",
        ),
        kitImport<typeof import("@pithy-sh/secrets/src/rotation/rotationSchedule")>(
          context.projectDir,
          "@pithy-sh/secrets/src/rotation/rotationSchedule",
        ),
        kitImport<typeof import("@pithy-sh/secrets/src/scope")>(context.projectDir, "@pithy-sh/secrets/src/scope"),
      ]),
  );
  const registry = aggregateSecretRegistries([context.capability, ...(context.siblings ?? [])]);
  const globalEnvironment = canonicalGlobalEnvironment(context.environments ?? []);
  return {
    valueRotations: stampedRotations(registry),
    ...(globalEnvironment === undefined ? {} : { globalEnvironment }),
  };
}

/**
 * The own host `pithy <capability> provision --worker <name>` deploys, when that Worker owns a binding the
 * capability's host binds; `undefined` when it shares the host, or the capability has none.
 */
export function provisionHostOwner(
  capability: Capability,
  worker: { dir: string; ownBindings?: readonly string[] } | undefined,
): HostOwner | undefined {
  const spec = hostWorkerFor(capability.name);
  return spec && worker ? hostOwnerFor(spec, capability, worker) : undefined;
}

/** The host Worker a capability owns, or `undefined` when it owns none (`auth`, `turnstile`, …). */
export function hostWorkerFor(capability: string): HostWorkerSpec | undefined {
  return HOST_WORKERS.find((spec) => spec.capability === capability);
}
