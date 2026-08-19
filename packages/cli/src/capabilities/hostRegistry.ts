// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { parse } from "comment-json";
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
 * ## What a dev resolution is, and what it deliberately is not
 *
 * {@link HostResolveContext} is capability-agnostic on purpose: project, environment, the app's base
 * URL, the id each D1 binding resolves to, and the composed capability object when the project has
 * one. Each entry maps that onto its own resolver's bespoke parameters, which is the shape the
 * provisioners already have and the shape `hostTemplates.test.ts` already drives.
 *
 * A capability's *own* configuration (`MediaConfig`, `StorageConfig`, …) is read from the composed
 * capability where the capability exposes it — email does, through `emailConfig` — and otherwise
 * falls back to that capability's schema defaults. A capability that wants its adopter's tuning in
 * the local host attaches it to its composed object the way `@pithy-sh/email` does; until it does,
 * the local host runs on defaults and the deployed one runs on the adopter's config, because
 * provisioning has the config object and `pithy dev` has only the `Capability`.
 */

/** What one host resolution needs, stated without reference to any particular capability. */
export interface HostResolveContext {
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
  /** The Secrets Store id. Absent locally — dev has no store, and the master key arrives in `.dev.vars`. */
  storeId?: string;
  /** The Cloudflare account id, which only the secrets manager's own resolver stamps into its vars. */
  accountId?: string;
  /** The composed capability object, when one of the project's Workers composes this capability. */
  capability?: Capability;
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
  delivery?(capability: Capability | undefined): Promise<HostDeliveryIdentity | undefined>;
}

/** The absolute path of the `wrangler.jsonc` committed beside a host's worker entry. */
export function hostTemplatePath(entry: string): string {
  return join(dirname(fileURLToPath(import.meta.resolve(entry))), "wrangler.jsonc");
}

/**
 * Read a capability's committed template exactly as its provisioner does — resolved through the
 * module graph rather than a relative path, so a moved package still resolves, and parsed with
 * `comment-json` because the file is JSONC and heavily commented.
 */
export async function readHostTemplate(entry: string): Promise<WorkflowHostTemplate> {
  return parse(await readFile(hostTemplatePath(entry), "utf8")) as unknown as WorkflowHostTemplate;
}

/** Run a guarded dynamic import, turning an absent optional package into an actionable refusal. */
async function load<T>(capability: string, pkg: string, importer: () => Promise<T>): Promise<T> {
  try {
    return await importer();
  } catch (error) {
    throw capabilityLoadError(capability, pkg, error);
  }
}

/** The three ids every host that reads a secret needs, mapped off the context in one place. */
function shared(context: HostResolveContext) {
  return {
    project: context.project,
    env: context.env,
    appDatabaseId: context.databaseId("DB"),
    secretsDatabaseId: context.databaseId("SECRETS"),
    // Empty rather than a placeholder: a dev resolution has no store, and the block is stripped
    // before the config reaches disk. A marker left standing would read like a value nobody filled.
    storeId: context.storeId ?? "",
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
      const [{ resolveEmailConfig }, { defaultTheme }, { isEmailCapability }] = await load(
        "email",
        "@pithy-sh/email",
        () =>
          Promise.all([
            import("@pithy-sh/email/src/provision/resolveEmailConfig"),
            import("@pithy-sh/email/src/templates/theme"),
            import("@pithy-sh/email/src/capability"),
          ]),
      );
      // The one capability that already hands its resolved config to whoever composed it. The theme
      // and the delivery mode are both the adopter's, so the local host renders and sends exactly
      // what the deployed one would.
      const composed = context.capability && isEmailCapability(context.capability) ? context.capability : undefined;
      return resolveEmailConfig(template as Parameters<typeof resolveEmailConfig>[0], {
        ...shared(context),
        suppressionDatabaseId: context.databaseId("EMAIL_SUPPRESSIONS"),
        // **The context's, never `email({ baseUrl })`.** That key is the *deployed* app's public
        // origin and is required, so it is always set — and a local host resolved against it mints
        // every tracked click, open pixel and unsubscribe link at production, signed with the local
        // signing key. `context.baseUrl` is the origin for the environment being resolved, which is
        // the app's own address in the one environment this resolver is used from.
        baseUrl: context.baseUrl,
        theme: composed?.emailConfig.theme ?? defaultTheme,
        devDelivery: context.simulateDelivery ? "simulator" : composed?.emailConfig.devDelivery,
      });
    },
    async delivery(capability) {
      if (!capability) return undefined;
      const { isEmailCapability } = await load(
        "email",
        "@pithy-sh/email",
        () => import("@pithy-sh/email/src/capability"),
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
      const [{ resolveMediaConfig }, { MediaConfig }] = await load("media", "@pithy-sh/media", () =>
        Promise.all([
          import("@pithy-sh/media/src/provision/resolveMediaConfig"),
          import("@pithy-sh/media/src/config/config"),
        ]),
      );
      const mediaConfig = MediaConfig.parse({});
      return resolveMediaConfig(template, {
        ...shared(context),
        resources: {
          bucketName: resourceNames(context.project).env(context.env).r2("MEDIA"),
          // Records live in D1 by default, and the KV binding is dropped rather than pointed at a
          // namespace nothing created. `recordStore` decides; the resolver reads it.
          kvNamespaceId:
            mediaConfig.recordStore === "kv" ? resourceNames(context.project).env(context.env).kv("MEDIA") : null,
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
      const [{ resolveStorageConfig }, { StorageConfig }] = await load("storage", "@pithy-sh/storage", () =>
        Promise.all([
          import("@pithy-sh/storage/src/provision/resolveStorageConfig"),
          import("@pithy-sh/storage/src/config/config"),
        ]),
      );
      return resolveStorageConfig(template, {
        ...shared(context),
        resources: { bucketName: resourceNames(context.project).env(context.env).r2("STORAGE") },
        storageConfig: StorageConfig.parse({}),
      });
    },
  },
  {
    capability: "payments",
    entry: "@pithy-sh/payments/src/workflows/worker",
    package: "@pithy-sh/payments",
    async resolve(template, context) {
      const [{ resolvePaymentsConfig }, { PaymentsConfig }, { isPaymentsCapability }] = await load(
        "payments",
        "@pithy-sh/payments",
        () =>
          Promise.all([
            import("@pithy-sh/payments/src/provision/resolvePaymentsConfig"),
            import("@pithy-sh/payments/src/config/config"),
            import("@pithy-sh/payments/src/capability"),
          ]),
      );
      // Payments hands its resolved config to whoever composed it, the way email does — so the local
      // reconcile host runs the adopter's own catalog and their own `billingSubject`, and a dev pass
      // narrows to the holder kind the project actually bills.
      //
      // The fallback is a project that composes no payments capability at all. It cannot be
      // `PaymentsConfig.parse({})` any more: `billingSubject` is required precisely because nothing may
      // pick it silently (#412), and an empty catalog has nobody to ask. `user` is stated here as what it
      // is — a placeholder for a local host with no catalog behind it, which reaches no deployed Worker,
      // because `pithy payments provision` resolves the deployed one from the adopter's config object.
      const composed = context.capability && isPaymentsCapability(context.capability) ? context.capability : undefined;
      return resolvePaymentsConfig(template, {
        ...shared(context),
        paymentsConfig: composed?.paymentsConfig ?? PaymentsConfig.parse({ billingSubject: "user" }),
      });
    },
  },
  {
    capability: "support",
    entry: "@pithy-sh/support/src/workflows/worker",
    package: "@pithy-sh/support",
    async resolve(template, context) {
      const [{ resolveSupportConfig }, { SupportConfig }] = await load("support", "@pithy-sh/support", () =>
        Promise.all([
          import("@pithy-sh/support/src/provision/resolveSupportConfig"),
          import("@pithy-sh/support/src/config/config"),
        ]),
      );
      return resolveSupportConfig(template, {
        project: context.project,
        env: context.env,
        appDatabaseId: context.databaseId("DB"),
        supportConfig: SupportConfig.parse({}),
      });
    },
  },
  {
    capability: "testers",
    entry: "@pithy-sh/testers/src/workflows/worker",
    package: "@pithy-sh/testers",
    async resolve(template, context) {
      const [{ resolveTestersConfig }, { TestersConfig }] = await load("testers", "@pithy-sh/testers", () =>
        Promise.all([
          import("@pithy-sh/testers/src/provision/resolveTestersConfig"),
          import("@pithy-sh/testers/src/config/config"),
        ]),
      );
      return resolveTestersConfig(template, {
        project: context.project,
        env: context.env,
        appDatabaseId: context.databaseId("DB"),
        suppressionDatabaseId: context.databaseId("EMAIL_SUPPRESSIONS"),
        testersConfig: TestersConfig.parse({}),
        // No sending identity locally. Undefined is the capability's own legitimate state — the pass
        // advances roster state and sends nothing — and is far better than a default address, which
        // would send from a domain the adopter's DKIM does not cover.
        email: undefined,
      });
    },
  },
  {
    capability: "vector",
    entry: "@pithy-sh/vector/src/workflows/worker",
    package: "@pithy-sh/vector",
    async resolve(template, context) {
      const [{ resolveVectorConfig }, { VectorConfig }] = await load("vector", "@pithy-sh/vector", () =>
        Promise.all([
          import("@pithy-sh/vector/src/provision/resolveVectorConfig"),
          import("@pithy-sh/vector/src/config/config"),
        ]),
      );
      const config = VectorConfig.parse({});
      const names = resourceNames(context.project).env(context.env);
      return resolveVectorConfig(template, {
        project: context.project,
        env: context.env,
        appDatabaseId: context.databaseId("DB"),
        indexNames: Object.fromEntries(
          Object.keys(config.indexes).map((index) => [index, names.vectorizeIndex(index)]),
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
      const { resolveManagerConfig } = await load(
        "secrets",
        "@pithy-sh/secrets",
        () => import("@pithy-sh/secrets/src/provision/resolveManagerConfig"),
      );
      return resolveManagerConfig(template as Parameters<typeof resolveManagerConfig>[0], {
        project: context.project,
        env: context.env,
        databaseId: context.databaseId("SECRETS"),
        storeId: context.storeId ?? "",
        accountId: context.accountId ?? "",
      });
    },
  },
];

/** The host Worker a capability owns, or `undefined` when it owns none (`auth`, `audit`, `turnstile`, …). */
export function hostWorkerFor(capability: string): HostWorkerSpec | undefined {
  return HOST_WORKERS.find((spec) => spec.capability === capability);
}
