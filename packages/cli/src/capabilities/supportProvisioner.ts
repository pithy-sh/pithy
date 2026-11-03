// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { statusOf } from "@pithy-sh/cloudflare/src/client/errors";
import type { R2Credentials } from "@pithy-sh/cloudflare/src/r2/r2Credentials";
import type { CloudflareWorkflowsClient } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import type { ZoneInfo } from "@pithy-sh/cloudflare/src/zones/zonesManager";
import { PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { GLOBAL_SCOPE } from "@pithy-sh/core/src/naming/environment";
import { bindingResourceName, type ProjectGlobalNaming } from "@pithy-sh/core/src/naming/provisionScope";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { parse } from "comment-json";
import { z } from "zod";
import type { CliAuditEmit } from "../audit/cliAudit";
import { answerOnConfirmedAccount, type ConfirmedAccount, findOnConfirmedAccount } from "../cloudflare/accountAnswer";
import { describeUnconfirmedCloudflareAccount, UNCONFIRMED_CLOUDFLARE_ACCOUNT_ACTION } from "../cloudflare/config";
import { kitImport } from "../project/kitResolve";
import { kitSource } from "../project/kitSource";
import { deployHostWorker, kitPackageVersion } from "./hostDeploy";
import { deleteHostWorkflows } from "./hostWorkflows";
import { capabilityLoadError } from "./loadFailure";
import { deleteR2BucketWithContents } from "./r2Bucket";

/**
 * The live support provisioner — the Cloudflare + wrangler implementation behind `@pithy-sh/support`'s
 * `SupportProvisioner` seam. Control-plane steps go through `@pithy-sh/cloudflare` (CLAUDE.md: the CF API
 * only via that client) and are each idempotent; the classification worker's deploy shells out to wrangler
 * with the bootstrap token.
 *
 * `@pithy-sh/support` is an **optional** capability, so the CLI must not hard-depend on it. Types come in
 * through type-only imports (erased at build), and every runtime value comes through {@link loadSupport} —
 * a guarded dynamic import that turns "the package isn't installed" into an actionable error rather than an
 * unresolved-module crash.
 *
 * **No secret is written here, and that is the whole shape of this file.** The classification worker reads
 * a message and writes a label over the `AI` binding, so it holds no credential at all — which is why
 * provisioning support is three steps (a bucket, a worker per environment, a routing rule per environment) where media is
 * five. The one credential support does use, the R2 key pair its attachment presigning needs, is read
 * through `@pithy-sh/storage`'s `ObjectStore` under support's **own** secret name — `support-r2-credentials`,
 * per `support/src/http/resolve.ts` — and no command in the kit writes it. `pithy storage provision` writes
 * `storage-r2-credentials`, a different secret naming a different bucket, so it is not the answer here.
 * The operator writes support's, and `pithy doctor`'s `shared:` section says so when the bucket the
 * signature addresses has to move.
 */

/** The support runtime surface provisioning needs, loaded from the project's own install. */
type SupportProvisionModule = typeof import("@pithy-sh/support/src/provision/provisionSupport");
type SupportResolveModule = typeof import("@pithy-sh/support/src/provision/resolveSupportConfig");
type SupportCapabilityModule = typeof import("@pithy-sh/support/src/capability");
type SupportConfigModule = typeof import("@pithy-sh/support/src/config/config");

/** The provisioner seams, referenced by type only so the CLI gains no dependency on the package. */
type SupportProvisioner = import("@pithy-sh/support/src/provision/provisionSupport").SupportProvisioner;
type SupportDeprovisioner = import("@pithy-sh/support/src/provision/provisionSupport").SupportDeprovisioner;
type SupportConfig = import("@pithy-sh/support/src/config/config").SupportConfig;

/** Everything `pithy support` loads out of the optional package, in one guarded import. */
export type SupportModule = SupportProvisionModule &
  SupportResolveModule &
  SupportCapabilityModule &
  SupportConfigModule;

/**
 * Load `@pithy-sh/support` from the project's own install. The one place the optional dependency is
 * resolved, so a project that has not added support gets one clear instruction instead of a module error
 * from whichever call site happened to run first.
 */
export async function loadSupport(projectDir: string): Promise<SupportModule> {
  try {
    const [provision, resolve, capability, config] = await Promise.all([
      kitImport<SupportProvisionModule>(projectDir, "@pithy-sh/support/src/provision/provisionSupport"),
      kitImport<SupportResolveModule>(projectDir, "@pithy-sh/support/src/provision/resolveSupportConfig"),
      kitImport<SupportCapabilityModule>(projectDir, "@pithy-sh/support/src/capability"),
      // `supportNeedsBucket` comes from here. The predicate must be the capability's own — the CLI
      // holding a second copy is exactly the drift that let provisioning and declaration disagree.
      kitImport<SupportConfigModule>(projectDir, "@pithy-sh/support/src/config/config"),
    ]);
    return { ...provision, ...resolve, ...capability, ...config };
  } catch (error) {
    throw await capabilityLoadError("support", "@pithy-sh/support", error, projectDir);
  }
}

/**
 * The search-index lifecycle and the typed database it runs against, from the optional package.
 *
 * A second guarded import beside {@link loadSupport} rather than an addition to it, because these two
 * modules are only needed by `ensureSearchIndex` — and `loadSupport` is already on the hot path of
 * every other step, where paying for two more dynamic imports buys nothing.
 */
export async function loadSupportSearch(
  projectDir: string,
): Promise<
  typeof import("@pithy-sh/support/src/store/searchIndex") & typeof import("@pithy-sh/support/src/store/provisionIndex")
> {
  try {
    const [searchIndex, provision] = await Promise.all([
      kitImport<typeof import("@pithy-sh/support/src/store/searchIndex")>(
        projectDir,
        "@pithy-sh/support/src/store/searchIndex",
      ),
      kitImport<typeof import("@pithy-sh/support/src/store/provisionIndex")>(
        projectDir,
        "@pithy-sh/support/src/store/provisionIndex",
      ),
    ]);
    return { ...searchIndex, ...provision };
  } catch (error) {
    throw await capabilityLoadError("support", "@pithy-sh/support", error, projectDir);
  }
}

/**
 * The semantic message index's naming and shape, from the optional package. Its own guarded import, used
 * only by the two index steps — the orchestrator that calls them ships in the same release as this module.
 */
async function loadSupportSemantic(
  projectDir: string,
): Promise<typeof import("@pithy-sh/support/src/semantic/messageIndex")> {
  try {
    return await kitImport<typeof import("@pithy-sh/support/src/semantic/messageIndex")>(
      projectDir,
      "@pithy-sh/support/src/semantic/messageIndex",
    );
  } catch (error) {
    throw await capabilityLoadError("support", "@pithy-sh/support", error, projectDir);
  }
}

/**
 * The binding the semantic message index arrives on — restated from `@pithy-sh/support/src/semantic/messageIndex`
 * because the app Worker's entry is written here, and **pinned to it by `supportProvisioner.test.ts`**.
 */
export const SUPPORT_VECTORIZE_BINDING = "SUPPORT_VECTORIZE";

/** The R2 binding the bucket is bound to, in every Worker and every environment. */
const SUPPORT_BUCKET_BINDING = "SUPPORT_BUCKET";

/**
 * What `packages/support/pithy.manifest.json` declares about naming {@link SUPPORT_BUCKET_BINDING} —
 * restated here because this file resolves through the CLI rather than through that package, and **pinned
 * to it by `ci/bindingResourceNames.test.ts`**, which fails the moment the two answers differ.
 */
const SUPPORT_BUCKET_NAMING: ProjectGlobalNaming = { scope: GLOBAL_SCOPE, resource: "support" };

/**
 * The R2 bucket attachments and raw messages live in — `<project>-global-support`.
 *
 * **One bucket for the project, not one per environment**, which is the opposite of what `pithy media` and
 * `pithy storage` do and is the seam's own shape (`ensureBucket()` takes no environment). It follows from
 * where the bytes are written from: the `SUPPORT_BUCKET` binding hangs off the *app* worker that receives
 * the mail, and a Worker addresses a bucket by the name its own `wrangler.jsonc` gives, per environment. So
 * the environments are separated by the binding an operator points at a bucket, and this command's job is
 * to make sure one exists to point at. `global` sits in the environment slot to say that out loud rather
 * than by omission.
 *
 * A function rather than a constant, because the project segment is not a constant — and it is what makes
 * `ensureBucket`'s find-then-create safe. R2's namespace is flat and account-wide, so the old fixed
 * `pithy-support` meant a second Pithy project in the same account adopted this one's bucket: two products'
 * customer correspondence in one place, and either teardown deleting both.
 *
 * **Through {@link bindingResourceName}, the one expression `pithy add` and `pithy provision` also compose
 * with (#513).** They composed `<project>-<env>-support-bucket` from the binding alone, created it, and
 * wrote it into the stanza — so on a split project the **per-environment** bucket is the one holding the
 * correspondence and this one is empty, and `pithy support deprovision --storage` has been deleting the
 * empty one while the customer mail it was meant to remove stayed on the account. That is also why the
 * repoint is not the first step of the upgrade: it changes which bucket the binding names and moves no
 * object, so the objects have to be synced here over R2's S3 endpoint before `pithy provision` runs
 * (`docs/commands/support.md`). The manifest declares both halves of the difference now — `scope:
 * "global"` and `resource: "support"` — and this reads the same two, so there is one name rather than two
 * writers of it.
 *
 * The binding keeps `_BUCKET` and the resource drops `-bucket`: `env.SUPPORT_BUCKET` is read in a Worker
 * and should say what kind of thing it is, while `r2` is already the composed name's own kind (#519).
 */
export function supportBucketName(project: string): string {
  return bindingResourceName(project, SUPPORT_BUCKET_BINDING, "r2", SUPPORT_BUCKET_NAMING);
}

/** The per-environment resource ids the support classification worker binds, resolved by the caller. */
export interface SupportEnvResources {
  /** The app database id for this environment — where the support tables live. */
  appDatabaseId: string;
}

/** Resolve the per-environment resources for the support worker (from the app Worker's wrangler config). */
export type ResolveSupportEnv = (env: ManagedEnvironment) => Promise<SupportEnvResources>;

/**
 * The inbound routing the three routing flags name: the zone, the address it matches, and the Worker it feeds. One
 * project-global rule, created exactly as described.
 */
export interface SupportRouting {
  /** Zone the rule lives on. Email Routing must already be enabled on it — enabling it moves the zone's MX. */
  zoneId: string;
  /** The exact recipient address the rule matches. */
  address: string;
  /** The deployed app worker the matched mail is delivered to — the one running the `email()` handler. */
  appWorkerName: string;
}

/** One environment's inbound routing, derived from its own composition. */
export interface SupportEnvRouting {
  /** The environment. */
  env: ManagedEnvironment;
  /** The addresses support's `inboundAddresses` claims in this environment's composition. */
  addresses: readonly string[];
  /** The app Worker this environment deploys as, `<project>-<env>-<worker>` unless its stanza names another. */
  workerName: string | null;
  /** Why this environment's routing could not be derived. Set, every address of it is refused with this reason. */
  refused?: string;
}

/** One inbound routing rule a provision settled. `docs/commands/support.md`. */
export const SupportRoute = z
  .object({
    env: z
      .string()
      .nullable()
      .describe(
        "The environment this rule routes, or `null` for the project-global rule the three routing flags name.",
      ),
    address: z
      .string()
      .nullable()
      .describe("The exact address the rule matches. `null` when the environment's composition claims none."),
    zone: z
      .string()
      .nullable()
      .describe(
        "The zone the rule lives on, by name: the zone holding the address's domain, the parent zone for a subdomain. `null` when no zone the token can list holds it.",
      ),
    zoneId: z.string().nullable().describe("That zone's id. `null` when no zone holds the address's domain."),
    worker: z
      .string()
      .nullable()
      .describe(
        "The app Worker the rule sends the mail to, as `pithy deploy` names it for the environment. `null` when it could not be resolved.",
      ),
    outcome: z
      .enum(["created", "updated", "unchanged", "skipped", "refused"])
      .describe(
        "`created`: this run made the rule. `updated`: the sole enabled rule for the address sent it elsewhere, and now sends it to the Worker. `unchanged`: a rule already did. `skipped`: the environment claims no address. `refused`: no rule was made, and `reason` says why.",
      ),
    reason: z.string().nullable().describe("Why the route was skipped or refused. `null` otherwise."),
  })
  .describe("One inbound routing rule `pithy support provision` settled.");
export type SupportRoute = z.infer<typeof SupportRoute>;

/** One environment's inbound rule a deprovision settled. `docs/commands/support.md`. */
export const SupportRouteRemoval = z
  .object({
    env: z.string().describe("The environment torn down."),
    address: z.string().nullable().describe("The address the rule matched. `null` when the composition claims none."),
    zone: z.string().nullable().describe("The zone the rule lived on, by name. `null` when no zone holds the domain."),
    worker: z
      .string()
      .nullable()
      .describe("The app Worker the rule sent mail to. `null` when it could not be resolved."),
    outcome: z
      .enum(["removed", "absent", "skipped"])
      .describe(
        "`removed`: this run deleted the environment's rule for the address. `absent`: no rule sent it to the Worker. `skipped`: nothing could be looked up, and `reason` says why.",
      ),
    reason: z.string().nullable().describe("Why the removal was skipped. `null` otherwise."),
  })
  .describe("One environment's inbound routing rule `pithy support deprovision` settled.");
export type SupportRouteRemoval = z.infer<typeof SupportRouteRemoval>;

/** The part of an address after its last `@`, lowercased. */
function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** Where an operator turns Email Routing on for `domain`. */
function enableRoutingAction(domain: string, zone: string): string {
  return domain === zone
    ? `Turn it on in the Cloudflare dashboard under ${zone} > Email > Email Routing, and the next run routes it.`
    : `Turn it on for the subdomain in the Cloudflare dashboard under ${zone} > Email > Email Routing > Settings > Subdomains, and the next run routes it.`;
}

export interface CloudflareSupportProvisionerOptions {
  /**
   * The project root — the directory `pithy.config.ts` was read from, and the base every
   * `@pithy-sh/support` module is resolved against. Not derivable from `project`, which is a *name*;
   * see `project/kitResolve.ts` for why a resolution may not fall back to the CLI's own copy.
   */
  readonly projectDir: string;
  cf: CloudflareClients;
  /**
   * The account this provisions into, and what vouches for it (#378).
   *
   * Replaces a bare `accountId`, and the replacement is the point: an id on its own is what six sites
   * already held while a find-or-create read an empty listing as "this account has none" and minted a
   * real resource in whichever account the shell had named. The id is still here — `account.accountId` —
   * and it now travels with the answer to "who says so".
   */
  account: ConfirmedAccount;
  /**
   * The project name, from `requireProjectName(await loadProject(projectDir))` — never
   * `resolveProjectName`. The bucket, every environment's worker, and the inbound routing rule all lead
   * with it, and the bucket is *found by name and reused*: a guessed value adopts another project's
   * correspondence.
   */
  project: string;
  /** The broad bootstrap token (`.dev.vars` `CLOUDFLARE_API_TOKEN`) that authenticates the worker deploy. */
  apiToken: string;
  /**
   * The app's resolved support config. Decides whether a bucket is needed at all, and travels into the
   * worker's `SUPPORT_CONFIG` var so an adopter's own categories reach the prompt as data.
   */
  supportConfig: SupportConfig;
  /** Resolve the per-env app DB id — injected so it is testable + decoupled from where the config lives. */
  resolveEnv: ResolveSupportEnv;
  /**
   * The rule the three routing flags name, created exactly as described. Set, it is the only rule this run makes.
   */
  routing?: SupportRouting;
  /**
   * Each provisioned environment's routing, derived from its own composition. Routed when {@link routing} is
   * absent: the zone is found from each address, a domain Email Routing is not enabled for is refused, and routing
   * is never enabled here, because enabling it moves the domain's MX.
   */
  environmentRouting?: readonly SupportEnvRouting[];
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
  /**
   * The account's Workflows client — how a freshly created message index is backfilled, by starting the
   * reprocess Workflow the worker just deployed. Absent, a created index is left for
   * `pithy vector reprocess --index support-messages --all` and the result says it was not backfilled.
   */
  workflows?: Pick<CloudflareWorkflowsClient, "createInstance">;
}

/**
 * Look for the index `search.semantic` no longer asks for, on a token that may not reach Vectorize at all.
 *
 * With semantic search off, nothing else in support needs Vectorize: the token's grants come from the
 * composed capabilities, and Vectorize also needs a paid Workers plan. So a 401 or 403 here means this
 * credential cannot hold or see an index, and the answer is "nothing to drop" rather than a failed run.
 * Every other failure still throws. A stamp left behind by an index this skips keeps the purge refusing
 * while the index is unbound, so nothing is erased on a guess.
 */
async function findIndexToDrop(
  vectorize: ReturnType<CloudflareClients["vectorizeProvisioner"]>,
  indexName: string,
): Promise<boolean> {
  try {
    return (await vectorize.findIndexByName(indexName)) !== null;
  } catch (error) {
    const status = statusOf(error instanceof Error ? error.cause : undefined);
    if (status === 401 || status === 403) return false;
    throw error;
  }
}

/** The live {@link SupportProvisioner}. Every step is idempotent, so provisioning is safe to re-run. */
export class CloudflareSupportProvisioner implements SupportProvisioner {
  readonly #projectDir: string;
  readonly #cf: CloudflareClients;
  readonly #account: ConfirmedAccount;
  readonly #project: string;
  readonly #apiToken: string;
  readonly #supportConfig: SupportConfig;
  readonly #resolveEnv: ResolveSupportEnv;
  readonly #routing: SupportRouting | undefined;
  readonly #environmentRouting: readonly SupportEnvRouting[];
  readonly #audit: CliAuditEmit;
  readonly #workflows: Pick<CloudflareWorkflowsClient, "createInstance"> | undefined;
  readonly #routes: SupportRoute[] = [];

  constructor(options: CloudflareSupportProvisionerOptions) {
    this.#projectDir = options.projectDir;
    this.#cf = options.cf;
    this.#account = options.account;
    this.#project = options.project;
    this.#apiToken = options.apiToken;
    this.#supportConfig = options.supportConfig;
    this.#resolveEnv = options.resolveEnv;
    this.#routing = options.routing;
    this.#environmentRouting = options.environmentRouting ?? [];
    this.#audit = options.audit ?? (async () => {});
    this.#workflows = options.workflows;
  }

  /** Every inbound rule the last {@link ensureRoutingRule} settled, in order. Empty before it runs. */
  get routes(): readonly SupportRoute[] {
    return this.#routes;
  }

  /**
   * Create the semantic message index when `search.semantic` is on and it does not exist. Find-then-create,
   * so a re-run reuses it. An index that exists with another shape — a model of another width — is refused,
   * because querying it would compare vectors from two spaces and return plausible, wrong neighbors.
   */
  async ensureSemanticIndex(env: ManagedEnvironment): Promise<{ indexName: string; created: boolean }> {
    const { supportMessageIndexName, supportMessageIndexShape } = await loadSupportSemantic(this.#projectDir);
    const indexName = supportMessageIndexName(this.#project, env);
    const shape = supportMessageIndexShape(this.#supportConfig.search);
    if (!shape) return { indexName, created: false };
    const vectorize = this.#cf.vectorizeProvisioner();
    const existing = await vectorize.findIndexByName(indexName);
    if (existing) {
      if (existing.config.dimensions !== shape.dimensions || existing.config.metric !== shape.metric) {
        throw new ValidationError({
          message: `The \`${indexName}\` index already exists with a different shape.`,
          action:
            "Dimensions and metric are fixed when an index is created. Change `search.semantic` back, or turn it off and provision to drop the index, then on again to rebuild it.",
          detail: `live ${existing.config.dimensions}/${existing.config.metric}, config ${shape.dimensions}/${shape.metric}`,
        });
      }
      return { indexName, created: false };
    }
    await vectorize.createIndex(indexName, shape);
    await this.#audit({
      environment: env,
      action: "support/semantic_index_created",
      outcome: "success",
      severity: "info",
      resourceType: "cf_vectorize_index",
      resourceId: indexName,
    });
    return { indexName, created: true };
  }

  /** Whether the environment holds inbound mail and no model stamp at all — an index never backfilled. */
  async #unstamped(env: ManagedEnvironment): Promise<boolean> {
    const { appDatabaseId } = await this.#resolveEnv(env);
    try {
      const row = await this.#cf
        .d1(appDatabaseId)
        .prepare(
          "SELECT (SELECT COUNT(*) FROM (SELECT 1 FROM pithy_support_messages WHERE direction = 'inbound' LIMIT 1)) AS messages, (SELECT COUNT(*) FROM (SELECT 1 FROM pithy_support_embeddings LIMIT 1)) AS stamps",
        )
        .first<{ messages: number; stamps: number }>();
      return Number(row?.messages ?? 0) > 0 && Number(row?.stamps ?? 0) === 0;
    } catch (error) {
      // A database that never ran the migration holds no mail to backfill.
      if (String(error instanceof Error ? error.message : error).includes("no such table")) return false;
      throw error;
    }
  }

  /**
   * After the worker is deployed: backfill an index that holds nothing yet, once, or drop one `search.semantic`
   * no longer asks for — with the model stamps, which would otherwise name vectors that are gone.
   *
   * **Nothing yet** is decided from what is stored, not from this run: an index this run created, or one that
   * exists while inbound mail does and no message carries a stamp. A run that created the index and then failed
   * leaves exactly that, so the next run backfills it. An index that holds any stamp is never re-embedded here.
   *
   * The backfill is started, not awaited: re-embedding an inbox is a Workflow's job, and a provisioning command
   * that blocked on it would block for as long as the inbox is large.
   */
  async settleSemanticIndex(
    env: ManagedEnvironment,
    created: boolean,
  ): Promise<{ dropped: boolean; backfilled: boolean }> {
    const { supportMessageIndexName, supportMessageIndex, SUPPORT_MESSAGES_INDEX } = await loadSupportSemantic(
      this.#projectDir,
    );
    const indexName = supportMessageIndexName(this.#project, env);
    if (supportMessageIndex(this.#supportConfig.search)) {
      if (!this.#workflows) return { dropped: false, backfilled: false };
      if (!created && !(await this.#unstamped(env))) return { dropped: false, backfilled: false };
      await this.#workflows.createInstance(resourceNames(this.#project).env(env).workflow("support", "reprocess"), {
        index: SUPPORT_MESSAGES_INDEX,
        all: true,
      });
      return { dropped: false, backfilled: true };
    }
    const vectorize = this.#cf.vectorizeProvisioner();
    if (!(await findIndexToDrop(vectorize, indexName))) return { dropped: false, backfilled: false };
    await vectorize.deleteIndex(indexName);
    const { appDatabaseId } = await this.#resolveEnv(env);
    try {
      await this.#cf.d1(appDatabaseId).prepare("DELETE FROM pithy_support_embeddings").run();
    } catch (error) {
      // A database that never ran the migration holds no stamps to clear.
      if (!String(error instanceof Error ? error.message : error).includes("no such table")) throw error;
    }
    await this.#audit({
      environment: env,
      action: "support/semantic_index_dropped",
      outcome: "success",
      severity: "info",
      resourceType: "cf_vectorize_index",
      resourceId: indexName,
    });
    return { dropped: true, backfilled: false };
  }

  /** Require a registered `workers.dev` subdomain — Cloudflare needs one to deploy the Workflow-hosting worker. */
  async preflight(): Promise<void> {
    if (!(await this.#cf.workers().accountSubdomain())) {
      throw new ValidationError({
        message: "This Cloudflare account has no workers.dev subdomain, which Workflows require.",
        action: "Open Workers & Pages in the dashboard once to create one, then re-run.",
      });
    }
  }

  /**
   * Reuse the bucket if it exists, otherwise create it — unless nothing will be written to it.
   *
   * **Gated on `supportNeedsBucket`, which is the same predicate the capability declares the binding
   * with.** Three settings put bytes here and each has its own writer: mail attachments, the raw MIME
   * copy, and an in-app submission's files. This gate asked about the first two and never about the
   * third, so a project that wanted uploads but no mail attachments got a `SUPPORT_BUCKET` binding
   * pointing at a bucket nothing had created, and every submitted file was dropped with a warning
   * (#440). Asking the capability's own predicate is what keeps provisioning and declaration from
   * drifting again — a fourth writer teaches both at once.
   *
   * Why the raw copy earns a flag of its own: keying on `attachments.enabled` alone meant an adopter
   * who turned off attachment storage also, silently, lost the immutable raw MIME that makes
   * re-parsing and re-sanitizing possible — a property the message schema documents as load-bearing.
   */
  async ensureBucket(): Promise<{ bucket: string; created: boolean; skipped: boolean }> {
    const { supportNeedsBucket } = await loadSupport(this.#projectDir);
    const name = supportBucketName(this.#project);
    if (!supportNeedsBucket(this.#supportConfig)) {
      return { bucket: name, created: false, skipped: true };
    }
    // On a confirmed account only: a miss read on an account nothing claims would create the bucket in whichever
    // account the shell named.
    const existing = await findOnConfirmedAccount({
      ...this.#account,
      what: `the ${name} bucket`,
      find: () => this.#cf.r2Provisioner().findBucketByName(name),
    });
    if (existing) return { bucket: existing.name, created: false, skipped: false };
    const created = await this.#cf.r2Provisioner().createBucket(name);
    await this.#audit({
      environment: "global",
      action: "support/bucket_created",
      outcome: "success",
      severity: "info",
      resourceType: "cf_r2_bucket",
      resourceId: created.name,
      // R2 exposes no tags through the API, so the name is the whole ownership record on the bucket
      // itself; this is the only place a human can later read which project it belongs to.
      metadata: { name: created.name },
    });
    return { bucket: created.name, created: true, skipped: false };
  }

  /** Resolve the env's wrangler config from the committed template + the app DB id, then `wrangler deploy`. */
  async deployWorker(env: ManagedEnvironment): Promise<void> {
    const { supportWorkerName, resolveSupportConfig } = await loadSupport(this.#projectDir);
    const { appDatabaseId } = await this.#resolveEnv(env);
    const dir = await supportWorkerDir(this.#projectDir);
    const template = parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as WorkflowHostTemplate;
    const config = resolveSupportConfig(template, {
      project: this.#project,
      env,
      appDatabaseId,
      supportConfig: this.#supportConfig,
    });

    // **The gate, inherited rather than opted into (#537).** `deployHostWorker` stamps the resolved
    // config with this package's version and a hash of the config itself, compares that against what
    // the deployed Worker carries, and ships only when they differ. A first provision has no stamp, so
    // it deploys. Anything it cannot establish — no Worker, no stamp, an unreachable account — deploys
    // too: a false redeploy costs seconds, a false skip is silent.
    try {
      const { outcome } = await deployHostWorker({
        capability: "support",
        pkg: "@pithy-sh/support",
        version: await kitPackageVersion(this.#projectDir, "@pithy-sh/support"),
        config,
        dir,
        env,
        readVars: (script) => this.#cf.workers().getWorkerVars(script),
        account: { accountId: this.#account.accountId, apiToken: this.#apiToken },
      });
      // A skipped deploy shipped nothing, so it records nothing. An audit row saying a Worker was
      // deployed on a run where wrangler never ran is worse than a gap in the trail.
      if (outcome === "deployed") {
        await this.#audit({
          environment: env,
          action: "support/worker_deployed",
          outcome: "success",
          severity: "info",
          resourceType: "cf_worker",
          resourceId: supportWorkerName(this.#project, env),
        });
      }
    } catch (error) {
      await this.#audit({
        environment: env,
        action: "support/worker_deployed",
        outcome: "failure",
        severity: "info",
        resourceType: "cf_worker",
        resourceId: supportWorkerName(this.#project, env),
      });
      throw error;
    }
  }

  /**
   * Bring the full-text index **and its triggers** in this environment's app database into line with
   * `search.fts`.
   *
   * Deliberately **not** a migration. The index is derived — every row comes from
   * `pithy_support_messages`, and `reindexThread` rebuilds it on demand — so it is a provisioned
   * resource like the bucket and the routing rule, not schema whose loss loses data. It also has to
   * live here for a second reason: composing it conditionally into the migration set meant turning
   * the flag off removed an already-applied migration, which Kysely reads as corruption and which
   * blocked `pithy migrate` for **every** capability sharing that database, not just support. The
   * triggers inherit both reasons exactly.
   *
   * **What is read is the table and its triggers, not the table alone.** This compared one boolean to
   * one boolean — present against wanted, equal means nothing to do — and that early return is the
   * state an adopter lands in after taking the release that moved the index onto triggers: the table is
   * there, the flag is set, the triggers were never created, and no write path calls `indexMessage` any
   * more. `pithy doctor` names this command for exactly that drift, so this command has to be the one
   * that clears it. `searchIndexAction` is the decision and is unit-tested in `@pithy-sh/support`.
   *
   * Every statement is idempotent, so this is safe to re-run — and the current state is read rather
   * than assumed, so the result reports what actually changed instead of what was attempted.
   */
  async ensureSearchIndex(env: ManagedEnvironment): Promise<{ created: boolean; dropped: boolean; repaired: boolean }> {
    const { provisionSearchIndex, SEARCH_TABLE } = await loadSupportSearch(this.#projectDir);
    const { appDatabaseId } = await this.#resolveEnv(env);
    // The capability's own step, which `pithy restore` runs too (#848): one read of the table and its three
    // triggers, the decision, and the change — a create or a repair backfills straight away, because an index
    // that exists and is empty answers "no matches" while the `LIKE` fallback no longer fires.
    const action = await provisionSearchIndex(this.#cf.d1(appDatabaseId), this.#supportConfig.search.fts);
    if (action === "none") return { created: false, dropped: false, repaired: false };

    await this.#audit({
      environment: env,
      action:
        action === "drop"
          ? "support/search_index_dropped"
          : action === "repair"
            ? "support/search_triggers_repaired"
            : "support/search_index_created",
      outcome: "success",
      severity: "info",
      resourceType: "d1_table",
      resourceId: SEARCH_TABLE,
    });
    return { created: action === "create", dropped: action === "drop", repaired: action === "repair" };
  }

  /**
   * Route inbound mail to the app worker: the rule the three flags name, or else each environment's own addresses.
   * Every rule settled is in {@link routes}.
   *
   * An environment's address is routed on the zone that holds its domain, the longest-suffix match over the
   * account's zones, so a subdomain's rule lives on its parent zone. A domain Email Routing is not enabled for is
   * refused for that environment, by name, and nothing is enabled here. An address two environments both claim is
   * refused for both, because one exact-address rule can send it to one Worker. A refusal is recorded, never
   * thrown, so every other environment is still routed.
   */
  async ensureRoutingRule(): Promise<{ created: boolean; skipped: boolean }> {
    this.#routes.length = 0;
    if (this.#routing) {
      this.#routes.push(await this.#ensureFlaggedRule(this.#routing));
    } else {
      await this.#ensureEnvironmentRules();
    }
    return {
      created: this.#routes.some((route) => route.outcome === "created" || route.outcome === "updated"),
      skipped: this.#routes.every((route) => route.outcome === "skipped"),
    };
  }

  /**
   * The one project-global rule the flags describe, keyed on support's own `<project>-global-support-inbound`, on the
   * zone they name. Held to what a derived route is: a confirmed account, a zone the token can list, and Email
   * Routing enabled for the address's domain.
   */
  async #ensureFlaggedRule(routing: SupportRouting): Promise<SupportRoute> {
    const { supportRoutingRuleName } = await loadSupport(this.#projectDir);
    const ruleName = supportRoutingRuleName(this.#project);
    return this.#routeOne({
      env: null,
      address: routing.address,
      workerName: routing.appWorkerName,
      ruleName,
      what: `the zone ${routing.zoneId}`,
      locate: async () => (await this.#cf.zones().listZones()).find((zone) => zone.id === routing.zoneId) ?? null,
      missing: `No zone this token can list has the id ${routing.zoneId}: the account does not hold it, or the token is not granted Zone Read on it.`,
      write: async (zone) => {
        const { created } = await this.#cf.emailRouting().ensureWorkerRoute({
          zoneId: zone.id,
          address: routing.address,
          workerName: routing.appWorkerName,
          ruleName,
        });
        return { outcome: created ? "created" : "unchanged" };
      },
    });
  }

  async #ensureEnvironmentRules(): Promise<void> {
    const claimedBy = new Map<string, ManagedEnvironment[]>();
    for (const routing of this.#environmentRouting) {
      if (routing.refused !== undefined) continue;
      for (const address of new Set(routing.addresses.map((candidate) => candidate.toLowerCase()))) {
        claimedBy.set(address, [...(claimedBy.get(address) ?? []), routing.env]);
      }
    }
    const { supportRoutingRuleName } = await loadSupport(this.#projectDir);
    for (const routing of this.#environmentRouting) {
      const base = { env: routing.env, worker: routing.workerName };
      const workerName = routing.workerName;
      if (routing.refused !== undefined || workerName === null) {
        this.#routes.push({
          ...base,
          address: null,
          zone: null,
          zoneId: null,
          outcome: "refused",
          reason: routing.refused ?? `The ${routing.env} app Worker could not be resolved.`,
        });
        continue;
      }
      if (routing.addresses.length === 0) {
        this.#routes.push({
          ...base,
          address: null,
          zone: null,
          zoneId: null,
          outcome: "skipped",
          reason: `support() claims no inboundAddresses in ${routing.env}.`,
        });
        continue;
      }
      for (const address of routing.addresses) {
        const sharers = claimedBy.get(address.toLowerCase()) ?? [];
        if (sharers.length > 1) {
          this.#routes.push({
            ...base,
            address,
            zone: null,
            zoneId: null,
            outcome: "refused",
            reason: `${address} is claimed by ${sharers.join(" and ")}, and one rule sends an address to one Worker. Give each environment its own address, or pass --routing-zone, --inbound-address and --app-worker.`,
          });
          continue;
        }
        const domain = domainOf(address);
        const ruleName = supportRoutingRuleName(this.#project, routing.env);
        this.#routes.push(
          await this.#routeOne({
            env: routing.env,
            address,
            workerName,
            ruleName,
            what: `the zone holding ${domain}`,
            locate: () => this.#cf.zones().findActiveZoneForHostname(domain),
            missing: `No zone this token can list holds ${domain}: the account does not hold it, or the token is not granted Zone Read on it.`,
            write: async (zone) => {
              const routed = await this.#cf
                .emailRouting()
                .routeAddressToWorker({ zoneId: zone.id, address, workerName, ruleName });
              if (routed.outcome !== "conflict") return { outcome: routed.outcome };
              return {
                outcome: "refused",
                reason: `More than one enabled rule claims ${address} on ${zone.name}, and not all send it to ${workerName}: ${routed.rules.join(", ")}. Disable or delete the ones that should not, and the next run routes it.`,
              };
            },
          }),
        );
      }
    }
  }

  /**
   * Route one address, or say why not. Every refusal is recorded, never thrown: an account nothing claims, a zone the
   * token cannot list, Email Routing off for the domain, a rule this will not override, and any Cloudflare failure,
   * which names the permissions routing takes when Cloudflare refused the token.
   */
  async #routeOne(route: {
    env: ManagedEnvironment | null;
    address: string;
    workerName: string;
    ruleName: string;
    what: string;
    locate: () => Promise<ZoneInfo | null>;
    missing: string;
    write: (zone: ZoneInfo) => Promise<{ outcome: SupportRoute["outcome"]; reason?: string }>;
  }): Promise<SupportRoute> {
    const domain = domainOf(route.address);
    const base = { env: route.env, address: route.address, worker: route.workerName };
    let zone: ZoneInfo | null = null;
    let step = "list the account's zones";
    try {
      const answer = await answerOnConfirmedAccount({ ...this.#account, what: route.what, find: route.locate });
      if (answer.state === "unconfirmed") {
        return {
          ...base,
          zone: null,
          zoneId: null,
          outcome: "refused",
          reason: `${describeUnconfirmedCloudflareAccount(answer.accountId)} No routing rule was made. ${UNCONFIRMED_CLOUDFLARE_ACCOUNT_ACTION}`,
        };
      }
      zone = answer.state === "found" ? answer.value : null;
      if (!zone) return { ...base, zone: null, zoneId: null, outcome: "refused", reason: route.missing };
      const located = { ...base, zone: zone.name, zoneId: zone.id };
      step = `read Email Routing's settings for ${domain}`;
      const status = await this.#cf.emailRouting().routingEnabledFor({ zoneId: zone.id, zoneName: zone.name, domain });
      if (!status.enabled) {
        return { ...located, outcome: "refused", reason: `${status.reason} ${enableRoutingAction(domain, zone.name)}` };
      }
      step = `write the routing rule for ${route.address}`;
      const written = await route.write(zone);
      if (written.outcome === "created" || written.outcome === "updated") {
        await this.#audit({
          environment: route.env ?? "global",
          action: written.outcome === "created" ? "support/routing_rule_created" : "support/routing_rule_updated",
          outcome: "success",
          severity: "info",
          resourceType: "cf_email_routing_rule",
          resourceId: route.address,
          metadata: { zoneId: zone.id, address: route.address, workerName: route.workerName, ruleName: route.ruleName },
        });
      }
      return { ...located, outcome: written.outcome, reason: written.reason ?? null };
    } catch (error) {
      return {
        ...base,
        zone: zone?.name ?? null,
        zoneId: zone?.id ?? null,
        outcome: "refused",
        reason: routingFailure(step, zone?.name ?? domain, error),
      };
    }
  }
}

/**
 * Why a Cloudflare call in the routing step failed, as a refusal reason. A 401 or 403 is the token's grant, so the
 * reason names the three permissions routing takes on the zone; anything else is said as Cloudflare said it.
 */
function routingFailure(step: string, zone: string, error: unknown): string {
  const status = statusOf(error instanceof Error ? error.cause : undefined);
  if (status === 401 || status === 403) {
    return `Cloudflare refused to ${step} (${status}). Routing takes ${ROUTING_PERMISSION_NAMES} on ${zone}; this token does not hold them all.`;
  }
  const message = error instanceof PithyError ? error.payload.message : String(error);
  return `Cloudflare could not ${step}: ${message}`;
}

/** The permission groups routing takes on a zone, as an operator reads them. */
const ROUTING_PERMISSION_NAMES = "Zone Read, Zone Settings Read and Email Routing Rules Write";

/**
 * Remove one environment's inbound rules: each rule that sends one of its addresses to its app worker, on the zone
 * that holds the address's domain. A rule for the address that sends it anywhere else is left, and so is every other
 * environment's. Read-only towards Email Routing itself: nothing is disabled and no DNS is touched.
 */
export async function removeEnvironmentRoutes(options: {
  cf: CloudflareClients;
  /** The account the rules are removed from. Unconfirmed, the removal is refused before anything is deleted. */
  account: ConfirmedAccount;
  routing: SupportEnvRouting;
  audit?: CliAuditEmit;
}): Promise<SupportRouteRemoval[]> {
  const { cf, routing, account } = options;
  const audit = options.audit ?? (async () => {});
  const base = { env: routing.env, worker: routing.workerName };
  if (routing.refused !== undefined || routing.workerName === null) {
    return [
      {
        ...base,
        address: null,
        zone: null,
        outcome: "skipped",
        reason: routing.refused ?? `The ${routing.env} app Worker could not be resolved.`,
      },
    ];
  }
  if (routing.addresses.length === 0) {
    return [
      {
        ...base,
        address: null,
        zone: null,
        outcome: "skipped",
        reason: `support() claims no inboundAddresses in ${routing.env}.`,
      },
    ];
  }
  const removals: SupportRouteRemoval[] = [];
  for (const address of routing.addresses) {
    const domain = domainOf(address);
    try {
      const zone = await findOnConfirmedAccount({
        ...account,
        what: `the zone holding ${domain}`,
        find: () => cf.zones().findActiveZoneForHostname(domain),
      });
      if (!zone) {
        removals.push({
          ...base,
          address,
          zone: null,
          outcome: "skipped",
          reason: `No zone this token can list holds ${domain}: the account does not hold it, or the token is not granted Zone Read on it.`,
        });
        continue;
      }
      const { removed } = await cf
        .emailRouting()
        .unrouteAddressFromWorker({ zoneId: zone.id, address, workerName: routing.workerName });
      if (removed > 0) {
        await audit({
          environment: routing.env,
          action: "support/routing_rule_removed",
          outcome: "success",
          severity: "warning",
          resourceType: "cf_email_routing_rule",
          resourceId: address,
          metadata: { zoneId: zone.id, address, workerName: routing.workerName },
        });
      }
      removals.push({ ...base, address, zone: zone.name, outcome: removed > 0 ? "removed" : "absent", reason: null });
    } catch (error) {
      // An account nothing claims is refused before anything is deleted, as every teardown's is.
      if (error instanceof PithyError && error.payload.code === "core/conflict") throw error;
      removals.push({
        ...base,
        address,
        zone: null,
        outcome: "skipped",
        reason: `${routingFailure(`remove the routing rule for ${address}`, domain, error)} The rule was left in place.`,
      });
    }
  }
  return removals;
}

/** The directory of the prebuilt support worker inside the installed `@pithy-sh/support` package (holds wrangler.jsonc). */
async function supportWorkerDir(projectDir: string): Promise<string> {
  try {
    return dirname(kitSource(projectDir, "@pithy-sh/support/src/workflows/worker"));
  } catch (error) {
    throw await capabilityLoadError("support", "@pithy-sh/support/src/workflows/worker", error, projectDir);
  }
}

export interface CloudflareSupportDeprovisionerOptions {
  /**
   * The project root — the directory `pithy.config.ts` was read from, and the base every
   * `@pithy-sh/support` module is resolved against. Not derivable from `project`, which is a *name*;
   * see `project/kitResolve.ts` for why a resolution may not fall back to the CLI's own copy.
   */
  readonly projectDir: string;
  cf: CloudflareClients;
  /** The account's Workflows client — the classification Workflow is deleted through it, by name (#789). */
  workflows: Pick<CloudflareWorkflowsClient, "deleteWorkflow">;
  /** The project name, from `requireProjectName` — teardown finds resources by no other key. */
  project: string;
  /**
   * The zone the project-global rule the routing flags created lives on. Omitted, that rule is left. An
   * environment's own rule is found from its address instead, by {@link removeEnvironmentRoutes}.
   */
  routingZoneId?: string;
  /**
   * The R2 S3 key pair, needed only when the bucket comes down. Emptying a bucket is an S3-protocol
   * operation and R2 refuses to delete a non-empty one, so a bucket teardown cannot run on the API token
   * alone. Omitted when `deleteStorage` is off and no bucket is touched.
   */
  r2Credentials?: R2Credentials;
  /**
   * The account this teardown deletes from, and what vouches for it (#378).
   *
   * Required, and required for the reason `CloudflareConfigOptions.account` is: the guard below reads a
   * miss as "already gone", so against an account nothing claims it deletes nothing, audits nothing, and
   * exits 0. A caller that has not decided which account it is tearing down cannot compile.
   */
  account: ConfirmedAccount;
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
}

/**
 * The live {@link SupportDeprovisioner} — removes the inbound rule and each environment's classification
 * worker and, when asked, the bucket with every attachment and raw message in it. Every step is guarded so
 * a missing resource is a no-op: teardown is idempotent.
 */
export class CloudflareSupportDeprovisioner implements SupportDeprovisioner {
  readonly #projectDir: string;
  readonly #cf: CloudflareClients;
  readonly #workflows: Pick<CloudflareWorkflowsClient, "deleteWorkflow">;
  readonly #project: string;
  readonly #routingZoneId: string | undefined;
  readonly #r2Credentials: R2Credentials | undefined;
  readonly #account: ConfirmedAccount;
  readonly #audit: CliAuditEmit;

  constructor(options: CloudflareSupportDeprovisionerOptions) {
    this.#projectDir = options.projectDir;
    this.#cf = options.cf;
    this.#workflows = options.workflows;
    this.#project = options.project;
    this.#routingZoneId = options.routingZoneId;
    this.#r2Credentials = options.r2Credentials;
    this.#account = options.account;
    this.#audit = options.audit ?? (async () => {});
  }

  /** Whether the env's classification worker is deployed — settled on a confirmed account, like every lookup here. */
  async hasWorker(env: ManagedEnvironment): Promise<boolean> {
    const { supportWorkerName } = await loadSupport(this.#projectDir);
    const name = supportWorkerName(this.#project, env);
    return Boolean(
      await findOnConfirmedAccount({
        ...this.#account,
        what: `the ${name} Worker`,
        find: () => this.#cf.workers().getWorker(name),
      }),
    );
  }

  /** Delete the env's classification Workflows, by the names the project's own `@pithy-sh/support` composes (#789). */
  async deleteWorkflows(env: ManagedEnvironment): Promise<void> {
    const { supportWorkflowNames } = await loadSupport(this.#projectDir);
    await deleteHostWorkflows({
      workflows: this.#workflows,
      account: this.#account,
      capability: "support",
      env,
      names: supportWorkflowNames(this.#project, env),
      audit: this.#audit,
    });
  }

  /** Delete the env's classification worker if it is deployed. */
  async deleteWorker(env: ManagedEnvironment): Promise<void> {
    const { supportWorkerName } = await loadSupport(this.#projectDir);
    const name = supportWorkerName(this.#project, env);
    if (
      await findOnConfirmedAccount({
        ...this.#account,
        what: `the ${name} Worker`,
        find: () => this.#cf.workers().getWorker(name),
      })
    ) {
      await this.#cf.workers().deleteWorker(name);
      await this.#audit({
        environment: env,
        action: "support/worker_removed",
        outcome: "success",
        severity: "warning",
        resourceType: "cf_worker",
        resourceId: name,
      });
    }
  }

  /**
   * Remove the project-global inbound rule the routing flags created. Matched on support's own rule name, so a
   * teardown can never take the bounce handler's rule — or an operator's hand-written one — with it.
   */
  async removeRoutingRule(): Promise<{ removed: boolean }> {
    if (!this.#routingZoneId) return { removed: false };
    const { supportRoutingRuleName } = await loadSupport(this.#projectDir);
    const ruleName = supportRoutingRuleName(this.#project);
    const { removed } = await this.#cf.emailRouting().removeWorkerRoute({
      zoneId: this.#routingZoneId,
      ruleName,
    });
    if (removed) {
      await this.#audit({
        environment: "global",
        action: "support/routing_rule_removed",
        outcome: "success",
        severity: "warning",
        resourceType: "cf_email_routing_rule",
        resourceId: ruleName,
        metadata: { zoneId: this.#routingZoneId, ruleName },
      });
    }
    return { removed };
  }

  /**
   * Delete the bucket and every object in it, if it exists — every attachment and every raw message an
   * adopter's customers ever sent, which is why nothing calls this without an explicit `--storage`. The
   * drain is not optional: R2 refuses to delete a bucket still holding an object or a dangling multipart
   * upload. What went is audited, not just that it went.
   */
  async deleteBucket(): Promise<void> {
    const name = supportBucketName(this.#project);
    const teardown = await deleteR2BucketWithContents({
      cf: this.#cf,
      credentials: this.#r2Credentials,
      bucketName: name,
    });
    if (!teardown.deleted) return;
    await this.#audit({
      environment: "global",
      action: "support/bucket_deleted",
      outcome: "success",
      severity: "warning",
      resourceType: "cf_r2_bucket",
      resourceId: name,
      metadata: {
        name,
        objectsDeleted: teardown.objectsDeleted,
        uploadsAborted: teardown.uploadsAborted,
      },
    });
  }
}
