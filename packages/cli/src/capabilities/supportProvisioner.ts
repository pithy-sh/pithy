// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { R2Credentials } from "@pithy-sh/cloudflare/src/r2/r2Credentials";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { parse } from "comment-json";
import type { CliAuditEmit } from "../audit/cliAudit";
import { type ConfirmedAccount, findOnConfirmedAccount } from "../cloudflare/accountAnswer";
import { kitSource } from "../project/kitSource";
import { runWrangler } from "../project/wrangler";
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
 * provisioning support is three steps (a bucket, a worker per environment, a routing rule) where media is
 * five. The one credential support does use, the R2 key pair its attachment presigning needs, belongs to
 * `@pithy-sh/storage`'s `ObjectStore` and is written by `pithy storage provision`.
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
export async function loadSupport(): Promise<SupportModule> {
  try {
    const [provision, resolve, capability, config] = await Promise.all([
      import("@pithy-sh/support/src/provision/provisionSupport"),
      import("@pithy-sh/support/src/provision/resolveSupportConfig"),
      import("@pithy-sh/support/src/capability"),
      // `supportNeedsBucket` comes from here. The predicate must be the capability's own — the CLI
      // holding a second copy is exactly the drift that let provisioning and declaration disagree.
      import("@pithy-sh/support/src/config/config"),
    ]);
    return { ...provision, ...resolve, ...capability, ...config };
  } catch (error) {
    throw capabilityLoadError("support", "@pithy-sh/support", error);
  }
}

/**
 * The search-index lifecycle and the typed database it runs against, from the optional package.
 *
 * A second guarded import beside {@link loadSupport} rather than an addition to it, because these two
 * modules are only needed by `ensureSearchIndex` — and `loadSupport` is already on the hot path of
 * every other step, where paying for two more dynamic imports buys nothing.
 */
async function loadSupportSearch(): Promise<
  typeof import("@pithy-sh/support/src/store/searchIndex") &
    typeof import("@pithy-sh/support/src/data/tables") &
    typeof import("@pithy-sh/support/src/store/search")
> {
  try {
    const [searchIndex, tables, search] = await Promise.all([
      import("@pithy-sh/support/src/store/searchIndex"),
      import("@pithy-sh/support/src/data/tables"),
      import("@pithy-sh/support/src/store/search"),
    ]);
    return { ...searchIndex, ...tables, ...search };
  } catch (error) {
    throw capabilityLoadError("support", "@pithy-sh/support", error);
  }
}

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
 */
export function supportBucketName(project: string): string {
  return resourceNames(project).global.r2("support");
}

/** The per-environment resource ids the support classification worker binds, resolved by the caller. */
export interface SupportEnvResources {
  /** The app database id for this environment — where the support tables live. */
  appDatabaseId: string;
}

/** Resolve the per-environment resources for the support worker (from the app Worker's wrangler config). */
export type ResolveSupportEnv = (env: ManagedEnvironment) => Promise<SupportEnvResources>;

/** The inbound routing a rule is created for: the zone, the address it matches, and the Worker it feeds. */
export interface SupportRouting {
  /** Zone the rule lives on. Email Routing must already be enabled on it — enabling it moves the zone's MX. */
  zoneId: string;
  /** The exact recipient address the rule matches. */
  address: string;
  /** The deployed app worker the matched mail is delivered to — the one running the `email()` handler. */
  appWorkerName: string;
}

export interface CloudflareSupportProvisionerOptions {
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
   * Optional inbound routing. Absent → the routing step is skipped, because **enabling Email Routing points
   * a zone's MX at Cloudflare**: a rule on the wrong zone moves an adopter's real mail off their provider,
   * which is not a mistake a provisioning command gets to make on their behalf.
   */
  routing?: SupportRouting;
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
}

/** The live {@link SupportProvisioner}. Every step is idempotent, so provisioning is safe to re-run. */
export class CloudflareSupportProvisioner implements SupportProvisioner {
  readonly #cf: CloudflareClients;
  readonly #account: ConfirmedAccount;
  readonly #project: string;
  readonly #apiToken: string;
  readonly #supportConfig: SupportConfig;
  readonly #resolveEnv: ResolveSupportEnv;
  readonly #routing: SupportRouting | undefined;
  readonly #audit: CliAuditEmit;

  constructor(options: CloudflareSupportProvisionerOptions) {
    this.#cf = options.cf;
    this.#account = options.account;
    this.#project = options.project;
    this.#apiToken = options.apiToken;
    this.#supportConfig = options.supportConfig;
    this.#resolveEnv = options.resolveEnv;
    this.#routing = options.routing;
    this.#audit = options.audit ?? (async () => {});
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
    const { supportNeedsBucket } = await loadSupport();
    const name = supportBucketName(this.#project);
    if (!supportNeedsBucket(this.#supportConfig)) {
      return { bucket: name, created: false, skipped: true };
    }
    const existing = await this.#cf.r2Provisioner().findBucketByName(name);
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
    const { supportWorkerName, resolveSupportConfig } = await loadSupport();
    const { appDatabaseId } = await this.#resolveEnv(env);
    const dir = supportWorkerDir();
    const template = parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as WorkflowHostTemplate;
    const config = resolveSupportConfig(template, {
      project: this.#project,
      env,
      appDatabaseId,
      supportConfig: this.#supportConfig,
    });
    const configPath = join(dir, `.wrangler.${env}.json`);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    try {
      await runWrangler(["deploy", "--config", configPath], {
        cwd: dir,
        env: { CLOUDFLARE_API_TOKEN: this.#apiToken, CLOUDFLARE_ACCOUNT_ID: this.#account.accountId },
      });
      await this.#audit({
        environment: env,
        action: "support/worker_deployed",
        outcome: "success",
        severity: "info",
        resourceType: "cf_worker",
        resourceId: supportWorkerName(this.#project, env),
      });
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
    } finally {
      // The resolved config carries provisioned resource ids and is written inside an installed package.
      // It exists for the length of one deploy and is removed whether that deploy worked or not.
      await unlink(configPath).catch(() => {});
    }
  }

  /**
   * Bring the full-text index in this environment's app database into line with `search.fts`.
   *
   * Deliberately **not** a migration. The index is derived — every row comes from
   * `pithy_support_messages`, and `reindexThread` rebuilds it on demand — so it is a provisioned
   * resource like the bucket and the routing rule, not schema whose loss loses data. It also has to
   * live here for a second reason: composing it conditionally into the migration set meant turning
   * the flag off removed an already-applied migration, which Kysely reads as corruption and which
   * blocked `pithy migrate` for **every** capability sharing that database, not just support.
   *
   * Both statements are `IF [NOT] EXISTS`, so this is safe to re-run — and the current state is read
   * rather than assumed, so the result reports what actually changed instead of what was attempted.
   */
  async ensureSearchIndex(env: ManagedEnvironment): Promise<{ created: boolean; dropped: boolean }> {
    const { supportDatabase, createSearchIndex, dropSearchIndex, reindexAll, SEARCH_TABLE } = await loadSupportSearch();
    const { appDatabaseId } = await this.#resolveEnv(env);
    const database = this.#cf.d1(appDatabaseId);

    const listed = await database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .bind(SEARCH_TABLE)
      .all<{ name: string }>();
    const present = (listed.results ?? []).length > 0;
    const wanted = this.#supportConfig.search.fts;

    if (wanted === present) return { created: false, dropped: false };

    const db = supportDatabase(database);
    if (wanted) {
      await createSearchIndex(db);
      // **Backfilled immediately.** An index created over messages that already exist is empty, and
      // because the table now exists the runtime's `LIKE` fallback stops firing — so the inbox would
      // answer "no matches" for a term plainly in the body. Creating without populating turns the
      // feature on and the results off, which is the one direction a filter must never fail in.
      await reindexAll(db);
    } else {
      await dropSearchIndex(db);
    }
    await this.#audit({
      environment: env,
      action: wanted ? "support/search_index_created" : "support/search_index_dropped",
      outcome: "success",
      severity: "info",
      resourceType: "d1_table",
      resourceId: SEARCH_TABLE,
    });
    return { created: wanted, dropped: !wanted };
  }

  /**
   * Create the inbound routing rule that actually delivers the support address to the app worker, when
   * routing was supplied; otherwise skip.
   *
   * The rule name is support's own (`<project>-global-support-inbound`), never `@pithy-sh/email`'s, and it
   * carries the project. Idempotency keys on the name, so a shared one would make whichever capability —
   * or whichever project on the same zone — provisioned second silently believe its rule already existed,
   * and its mail would go to the other one's Worker.
   */
  async ensureRoutingRule(): Promise<{ created: boolean; skipped: boolean }> {
    if (!this.#routing) return { created: false, skipped: true };
    const { supportRoutingRuleName } = await loadSupport();
    const ruleName = supportRoutingRuleName(this.#project);
    const { created } = await this.#cf.emailRouting().ensureWorkerRoute({
      zoneId: this.#routing.zoneId,
      address: this.#routing.address,
      workerName: this.#routing.appWorkerName,
      ruleName,
    });
    if (created) {
      await this.#audit({
        environment: "global",
        action: "support/routing_rule_created",
        outcome: "success",
        severity: "info",
        resourceType: "cf_email_routing_rule",
        resourceId: this.#routing.address,
        metadata: {
          zoneId: this.#routing.zoneId,
          address: this.#routing.address,
          workerName: this.#routing.appWorkerName,
          ruleName,
        },
      });
    }
    return { created, skipped: false };
  }
}

/** The directory of the prebuilt support worker inside the installed `@pithy-sh/support` package (holds wrangler.jsonc). */
function supportWorkerDir(): string {
  try {
    return dirname(kitSource("@pithy-sh/support/src/workflows/worker"));
  } catch (error) {
    throw capabilityLoadError("support", "@pithy-sh/support/src/workflows/worker", error);
  }
}

export interface CloudflareSupportDeprovisionerOptions {
  cf: CloudflareClients;
  /** The project name, from `requireProjectName` — teardown finds resources by no other key. */
  project: string;
  /**
   * The zone the inbound rule lives on. Needed to remove it, and there is no honest way to derive it: a
   * rule is addressed through its zone, and sweeping every zone on the account looking for a name is a
   * search this command should not be making across an adopter's domains. Omitted → the rule is left, and
   * the command says so rather than reporting mail stopped when it has not.
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
  readonly #cf: CloudflareClients;
  readonly #project: string;
  readonly #routingZoneId: string | undefined;
  readonly #r2Credentials: R2Credentials | undefined;
  readonly #account: ConfirmedAccount;
  readonly #audit: CliAuditEmit;

  constructor(options: CloudflareSupportDeprovisionerOptions) {
    this.#cf = options.cf;
    this.#project = options.project;
    this.#routingZoneId = options.routingZoneId;
    this.#r2Credentials = options.r2Credentials;
    this.#account = options.account;
    this.#audit = options.audit ?? (async () => {});
  }

  /** Delete the env's classification worker if it is deployed. */
  async deleteWorker(env: ManagedEnvironment): Promise<void> {
    const { supportWorkerName } = await loadSupport();
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
   * Remove the inbound rule, so mail stops being delivered here. Matched on support's own rule name, so a
   * teardown can never take the bounce handler's rule — or an operator's hand-written one — with it.
   */
  async removeRoutingRule(): Promise<{ removed: boolean }> {
    if (!this.#routingZoneId) return { removed: false };
    const { supportRoutingRuleName } = await loadSupport();
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
