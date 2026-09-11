// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { parse } from "comment-json";
import { kitImport } from "../project/kitResolve";
import { kitSource } from "../project/kitSource";
import { capabilityLoadError } from "./loadFailure";

/**
 * **Which capability owns which host Worker — the one production statement of it.**
 *
 * A capability that owns Workflows ships a committed `wrangler.jsonc` beside its worker entry, and
 * `pithy <capability> provision` resolves that template into one deployable config per environment.
 * Nine capabilities do; not one of them lives in `apps/`, so until now no host Worker had ever run
 * under `pithy dev` and every locally enqueued email sat `pending` forever (pithy-sh/pithy#410).
 *
 * The mapping from a capability to its template, its entry module and its resolver existed only
 * inside `hostTemplates.test.ts` — a test file, which nothing may import at runtime. This is that
 * mapping as production code. `pithy dev` reads it and knows nothing about email, media or vector;
 * a tenth capability adds one entry here and joins the dev set with no change to the dev command.
 *
 * ## Why every import is dynamic
 *
 * Six of the eight packages below are `devDependencies` of the CLI, because a capability is optional
 * and the CLI must never hard-depend on one. So each entry resolves its resolver through a guarded
 * `import()` at the moment the project turns out to compose it, and a package that is not installed
 * becomes {@link capabilityLoadError}'s actionable refusal rather than an unresolved-module crash.
 *
 * **And every one of them is resolved from the project, never from the CLI (#533).** This file is the
 * issue's own example: a globally installed `pithy` read the project's `pithy.config.ts`, learned it
 * composes `payments`, and then asked *its own* `node_modules` for `@pithy-sh/payments` — which a global
 * install does not have, so a composed, installed, working capability was refused as "not installed"
 * with `pithy add` for a remedy. See `project/kitResolve.ts`.
 *
 * ## What a resolution is, and where its configuration comes from
 *
 * {@link HostResolveContext} is capability-agnostic on purpose: project, environment, the app's base
 * URL, the id each binding resolves to, and the composed capability object. Each entry maps that onto
 * its own resolver's bespoke parameters, which is the shape the provisioners already have and the
 * shape `hostTemplates.test.ts` already drives.
 *
 * **A capability's own configuration is read from the composed capability, always.** There is no
 * branch left that parses `Config.parse({})`, and {@link HostResolveContext.capability} is required
 * rather than optional so a new entry cannot grow one. Five branches did exactly that — media,
 * storage, support, testers and vector — written while this registry served `pithy dev` alone, where
 * a host on schema defaults was a local convenience nobody deployed. #537 pointed
 * `pithy deploy --kit` at the same entries and inherited the wrong half: an adopter on
 * `recordStore: "kv"` had `pithy deploy` strip the `MEDIA` KV binding their config asks for while
 * `pithy media provision` put it back, and testers' deployed host lost `EMAIL_FROM_ADDRESS`
 * entirely, because the entry passed `email: undefined` under a comment about local sending.
 *
 * So the registry serves one master. A composed object that is not the shape its own package defines
 * is {@link ownCapability}'s refusal, never a default — the whole failure was a silent fallback, and
 * a second one would be the same bug spelled differently. **The dev path supplies its defaults out
 * loud instead**: `pithy dev` answers `storeId()` with the empty string at its own call site, where
 * the sentence explaining that a developer's machine has no Secrets Store can be read, rather than
 * through a `?? ""` in here that a deploy silently inherited.
 */

/** What one host resolution needs, stated without reference to any particular capability. */
export interface HostResolveContext {
  /**
   * The project root — where `pithy.config.ts` was read from, and the base every `@pithy-sh/*` module
   * below is resolved against (#533).
   *
   * Distinct from {@link project}, which is a *name* and resolves nothing. And never `process.cwd()`:
   * these resolvers run under `pithy dev`, where the cwd may be a worktree.
   */
  projectDir: string;
  /** The project name — the leading segment of every name the resolution derives. Never guessed. */
  project: string;
  /** The environment being resolved. `dev` for a local host; a managed name for a deploy. */
  env: string;
  /** The app Worker's origin for this environment — what callback links are built against. */
  baseUrl: string;
  /**
   * The database id a D1 binding resolves to. Under `dev` this answers the **binding name**, because
   * that is wrangler's own local key (`getRemoteId(database_id) ?? binding`) and therefore the one
   * `pithy migrate --env dev` filled. A host answering anything else opens an empty database.
   */
  databaseId: (binding: string) => string;
  /**
   * The KV namespace id a binding resolves to, on the same rule {@link databaseId} states and for the
   * same reason: wrangler's local key for a namespace is `id ?? binding`, so under `dev` this answers
   * the **binding name** and a host answering anything else opens a namespace nothing wrote.
   *
   * Asked for rather than derived, because the only id a derivation could invent is the namespace's
   * *title* — `acme-prod-media` — and a title is not an id. `pithy deploy --kit` reads the real one
   * off the app Worker's own `wrangler.jsonc`, exactly as it reads a database id.
   */
  kvNamespaceId: (binding: string) => string;
  /**
   * The Secrets Store id, asked for rather than read, so a host that binds the store says so by
   * calling — exactly as it says which databases it needs by calling {@link databaseId}.
   *
   * A function and not a string because the two callers answer it differently and both answers are
   * deliberate: `pithy dev` answers `""`, since a developer's machine has no store and the block is
   * stripped before the config reaches disk; `pithy deploy --kit` answers the account's id, or
   * records the miss and skips. It was `storeId ?? ""` here, which meant the deploy path shipped
   * `store_id: ""` and reported the row as deployed (#537).
   */
  storeId: () => string;
  /** The Cloudflare account id, on the same terms. Only the secrets manager stamps it into its vars. */
  accountId: () => string;
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

/** One capability's host Worker: where its template and entry live, and how a context resolves it. */
export interface HostWorkerSpec {
  /** The capability's name — the key a composed `Capability` is matched against, and the host's label. */
  readonly capability: string;
  /** The worker entry module the host runs. Its sibling `wrangler.jsonc` is the template. */
  readonly entry: string;
  /** The npm package the entry ships in, named when the guarded import fails. */
  readonly package: string;
  /** Fill the template for one environment. Throws {@link capabilityLoadError} when the package is absent. */
  resolve(template: WorkflowHostTemplate, context: HostResolveContext): Promise<WorkflowHostTemplate>;
  /** What this host would send from a developer's machine, or `undefined` when it sends nothing. */
  delivery?(capability: Capability, projectDir: string): Promise<HostDeliveryIdentity | undefined>;
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
 * `node_modules` before it is allowed to say "not installed" and print `pithy add` (#533).
 */
async function load<T>(capability: string, pkg: string, projectDir: string, importer: () => Promise<T>): Promise<T> {
  try {
    return await importer();
  } catch (error) {
    throw capabilityLoadError(capability, pkg, error, projectDir);
  }
}

/** The three ids every host that reads a secret needs, mapped off the context in one place. */
function shared(context: HostResolveContext) {
  return {
    project: context.project,
    env: context.env,
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
 * The one place a capability's configuration enters a resolution, and deliberately the only one. Each
 * entry used to narrow inline and fall back to `Config.parse({})` when the guard said no, which reads
 * as defensive and is the #537 defect in miniature: the fallback fires on exactly the input nobody
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
 * providers to distrust the real one — which is why the entry passed `email: undefined` before #537,
 * and why that was right locally and wrong for every deployed testers host.
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
        // `hostCatalogs()` answers `{}` on one whose `compose` hook has not run, and this sentence was
        // false for exactly as long as it did not (pithy-sh/pithy#441).
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
          bucketName: mediaBucketName(context.project, context.env),
          // Records live in D1 by default, and in that mode the KV binding is dropped rather than
          // pointed at a namespace nothing created. `recordStore` decides — **the adopter's, not the
          // schema's**: this branch read `MediaConfig.parse({})`, so a project storing records in KV
          // had its `MEDIA` binding deleted by `pithy deploy` and restored by `pithy media provision`,
          // and the two commands fought over every deploy (#537).
          //
          // A KV namespace *does* have an account-minted id, so it is asked for rather than derived —
          // the derivable value is the namespace's title, and binding a title as an id fails at the
          // Worker's first read.
          kvNamespaceId: mediaConfig.recordStore === "kv" ? context.kvNamespaceId("MEDIA") : null,
        },
        mediaConfig,
      });
    },
  },
  {
    capability: "storage",
    entry: "@pithy-sh/storage/src/workflows/worker",
    package: "@pithy-sh/storage",
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
        resources: { bucketName: storageBucketName(context.project, context.env) },
        storageConfig: ownCapability(context, "storage", "@pithy-sh/storage", isStorageCapability).storageConfig,
      });
    },
  },
  {
    capability: "payments",
    entry: "@pithy-sh/payments/src/workflows/worker",
    package: "@pithy-sh/payments",
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
      // There is nothing left to fall back to, and `billingSubject` is why the fallback was always
      // wrong: the key is required precisely because nothing may pick it silently (#412), so the
      // `PaymentsConfig.parse({ billingSubject: "user" })` that stood here picked it silently.
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
        appDatabaseId: context.databaseId("DB"),
        supportConfig: ownCapability(context, "support", "@pithy-sh/support", isSupportCapability).supportConfig,
      });
    },
  },
  {
    capability: "testers",
    entry: "@pithy-sh/testers/src/workflows/worker",
    package: "@pithy-sh/testers",
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
        appDatabaseId: context.databaseId("DB"),
        // `vectorIndexName`, which is what `pithy vector provision` creates the index by. The local
        // `resourceNames(project).env(env).vectorizeIndex(index)` that stood here omitted the
        // capability segment the namer adds, so this path bound `acme-prod-notes` while provisioning
        // created `acme-prod-vector-notes` — an index nothing had made, and a search that fails.
        indexNames: Object.fromEntries(
          Object.keys(config.indexes).map((index) => [index, vectorIndexName(context.project, index, context.env)]),
        ),
        config,
      });
    },
  },
  {
    capability: "secrets",
    entry: "@pithy-sh/secrets/src/manager/worker",
    package: "@pithy-sh/secrets",
    async resolve(template, context) {
      const { resolveManagerConfig } = await load("secrets", "@pithy-sh/secrets", context.projectDir, () =>
        kitImport<typeof import("@pithy-sh/secrets/src/provision/resolveManagerConfig")>(
          context.projectDir,
          "@pithy-sh/secrets/src/provision/resolveManagerConfig",
        ),
      );
      return resolveManagerConfig(template as Parameters<typeof resolveManagerConfig>[0], {
        project: context.project,
        env: context.env,
        databaseId: context.databaseId("SECRETS"),
        storeId: context.storeId(),
        accountId: context.accountId(),
      });
    },
  },
];

/** The host Worker a capability owns, or `undefined` when it owns none (`auth`, `audit`, `turnstile`, …). */
export function hostWorkerFor(capability: string): HostWorkerSpec | undefined {
  return HOST_WORKERS.find((spec) => spec.capability === capability);
}
