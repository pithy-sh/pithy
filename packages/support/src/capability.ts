// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import { noopEmit } from "@pithy-sh/core/src/audit/recorder";
import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { DatabaseSpecMap } from "@pithy-sh/core/src/data/databases";
import type { KvNamespaceSpecMap } from "@pithy-sh/core/src/kv/namespaces";
import { workflowBindings } from "@pithy-sh/core/src/workflow/bindings";
import type { EmailCapability } from "@pithy-sh/email/src/capability";
import { isEmailCapability } from "@pithy-sh/email/src/capability";
import type { Migration } from "kysely/migration";
import type { SupportClientProjection } from "./client/projection";
import { type SupportConfig, type SupportConfigInput, SupportConfig as SupportConfigSchema } from "./config/config";
import { resolveCategories, type SupportCategories } from "./data/categories";
import { supportTables } from "./data/tables";
import { makeResolveDeps } from "./http/resolve";
import { registerSupportRoutes } from "./http/routes";
import { supportAdminRoutes } from "./http/scopes";
import { createSupportEmailHandler } from "./inbound/handler";
import { support_0001_threads } from "./migrations/0001_threads";
import { resolveReplies, type SupportReplySnippets } from "./reply/snippets";
import { supportSecretsRegistry } from "./secret/registry";
import { supportExampleSeed } from "./seeds/example";
import { PACKAGE_VERSION } from "./version.generated";
import { supportWorkflows } from "./workflows/specs";

/**
 * Sort order of the support migrations within the app database, relative to other capabilities.
 * Unique per database; the registry composes keys like `1200_support_0001_threads`.
 *
 * Taken from `NEXT_FREE_ORDER` in `packages/cli/src/migrations/orders.test.ts` at implementation
 * time, as the procedure in that file requires — never picked by grepping, which is how two pairs of
 * capabilities once collided in a range that was 99% empty. Stable forever: renumbering would rename
 * the composed keys, and Kysely would then read applied migrations as unapplied and re-run them.
 */
export const SUPPORT_MIGRATION_ORDER = 1200;

/** The options `support()` accepts: the config, plus the path its admin routes mount under. */
export type SupportOptions = SupportConfigInput & {
  /** The path the control-plane routes mount under. Defaults to `/support`. */
  basePath?: string;
};

/**
 * What the capability resolves at construction and at compose time, shared with the routes and the
 * inbound handler. Mutable in exactly one direction: `compose` fills the optional seams once, at
 * startup, and nothing writes to it afterwards.
 */
export interface SupportWiring {
  /** The resolved config. */
  config: SupportConfig;
  /** The effective taxonomy. */
  categories: SupportCategories;
  /** The effective canned-reply catalog. */
  snippets: SupportReplySnippets;
  /**
   * The email capability's bound enqueue seam — how a reply is delivered. Set by `compose` when
   * `email()` is composed, and left undefined otherwise, which is a supported deployment: an inbox
   * that receives and classifies but cannot answer is still worth having, and the reply route says
   * so with `support/reply_failed` rather than the capability refusing to start.
   */
  enqueueEmail: EmailCapability["enqueue"] | undefined;
  /**
   * The audit seam the inbound handler emits through.
   *
   * Held here rather than read from a request because an `email()` handler has no request — there is
   * no `c.var.emit` to reach for. `compose` cannot supply the real recorder either (that is
   * per-request state), so this stays the no-op and inbound rejections are recorded in the log. The
   * decisions that most need auditing — archive, reply, reclassify — all happen on a request and go
   * through the real seam.
   */
  emit: AuditEmit;
}

/**
 * What a browser may know about this project's support — the `virtual:pithy/support` module.
 *
 * **One route on this capability is called by a browser**, and that is the whole reason this exists:
 * `POST {basePath}/feedback`, with the two reads beside it. Everything else answers to a control-plane
 * credential a management client holds, and a management client reads the manifest. So the list is
 * `basePath` and the bounds the compose form must hold somebody to before it lets them press Send —
 * a form that stops at 200 characters because the handler refuses at 200 characters is a better form
 * than one that finds out afterwards.
 *
 * **`{ enabled: false }` when the submission channel is off**, and that is not the same statement as
 * "support is not composed" only in a sentence nobody writes. `registerSupportRoutes` does not mount
 * the feedback routes when `submission.enabled` is false — they answer 404, not 403 — so a browser
 * then has nothing on this capability to call and no use for a path. A screen branches on `enabled`
 * rather than guarding, exactly as it does for a payments catalog with nothing in it.
 *
 * **What deliberately does not cross, and why each one was considered.**
 * - **The taxonomy.** A category's value is the instruction a model reads and it lands in the prompt
 *   verbatim — prompt input written for a classifier, not copy for a chooser. An adopter's UI wants
 *   its own words either way, and the descriptions are the closest thing here to authored internals.
 * - **`inboundAddresses` and `reply.replyToAddress`.** The inbox's own mail addresses. A browser never
 *   writes to them, and publishing an address into every bundle is a favor to nobody but a spammer.
 * - **`reply.snippets`.** Canned copy an operator picks and edits in a dashboard. Staff-side, and the
 *   dashboard reads it through the control-plane route that already serves it.
 * - **`submission.maxPerAccountPerHour`.** A rate a client cannot pre-enforce honestly — the count
 *   lives in D1 and the server's refusal is the only truth about it — so projecting it would publish
 *   an abuse budget in exchange for a number no form can act on.
 * - **`ai`, `guard`, `attachments`, `search`.** The model and its prompt budget, the mail path's size
 *   and rate bounds, what happens to mail attachments, and how search is indexed. Each describes the
 *   deployment or a surface a browser never touches. The mail path's `attachments` block in
 *   particular is *not* the submission's: `config.ts` says at length why the two are stated
 *   separately, and inheriting one for the other here would undo that in the one place it reaches a
 *   client.
 *
 * There is no secret in reach of this closure to begin with — the R2 credential bundle lives in the
 * secrets store behind `supportSecretsRegistry` and is never in config — so what discipline covers is
 * the list above. `capability.test.ts` locks the key set by hand and sweeps the serialized result.
 *
 * `null` for attachments that are off, never `undefined`: the projection is inlined into a bundle with
 * `JSON.stringify`, which drops an undefined value and leaves the screen reading a key that is simply
 * absent. Null is also what makes "render no file picker" one check rather than three absences.
 *
 * The return type is {@link SupportClientProjection} — **declared, not inferred**. `ClientProjection` is
 * `{ enabled: boolean }` plus a JSON catchall, which accepts anything this function could return. The
 * declared type is what makes a dropped field a compile error here rather than a browser's problem, and
 * what stops the list above widening by accident when `SupportConfig` grows.
 */
function clientProjection(config: SupportConfig, basePath: string): SupportClientProjection {
  const submission = config.submission;
  if (!submission.enabled) return { enabled: false };
  const attachments = submission.attachments;
  return {
    enabled: true,
    basePath,
    // Nested under the channel these bounds belong to. `maxBytes` alone would be ambiguous between the
    // mail path and this one, and the mail path's numbers are a different answer to a different
    // question — see `SupportSubmissionAttachmentsConfig`.
    submission: {
      maxSubjectChars: submission.maxSubjectChars,
      maxBodyChars: submission.maxBodyChars,
      attachments: attachments.enabled
        ? {
            maxCount: attachments.maxCount,
            maxBytes: attachments.maxBytes,
            // The `accept` attribute of a file input, and the check a client makes before it spends a
            // request on bytes the handler will refuse. An allowlist is not a secret: it is the
            // contract the route already publishes by refusing everything else.
            allowedContentTypes: [...attachments.allowedContentTypes],
          }
        : null,
    },
  };
}

/**
 * The support capability, with its resolved config, taxonomy, and reply catalog attached. The
 * workflow slice is kept literal so a composed project types
 * `c.var.workflows.trigger("support/classify", …)` precisely — an unregistered key or a mistyped
 * payload is a compile error, not a 500.
 */
export interface SupportCapability
  extends Capability<DatabaseSpecMap, KvNamespaceSpecMap, "support", typeof supportWorkflows> {
  /** The resolved support config. */
  supportConfig: SupportConfig;
  /** The effective taxonomy: the eight Pithy ships, plus the adopter's, theirs winning on a collision. */
  categories: SupportCategories;
  /** The effective canned-reply catalog. */
  snippets: SupportReplySnippets;
  /** The path the admin routes mounted under — the one the manifest advertises. */
  basePath: string;
}

/**
 * The support capability — an inbound support inbox in the adopter's own D1, classified on their own
 * Workers AI binding.
 *
 * It contributes five tables (and optionally a full-text index) to the app `DB`, an `email()` handler
 * that claims the configured addresses out of the Worker's single inbound entry, the classification
 * Workflow that handler dispatches to, and a control-plane admin surface for a dashboard to read and
 * act on.
 *
 * **Nothing here is gated by tier.** Every route is reachable with a control-plane credential the
 * adopter issued, whatever anyone pays; a hosted dashboard gates its own UI and nothing else.
 * Crippling MIT code would be both wrong and futile.
 *
 * Attachments presign through `@pithy-sh/storage`'s `ObjectStore` against `SUPPORT_BUCKET` under a
 * credential name support declares, so `secrets` must be composed. The admin routes need the
 * `control-plane` seam; without it every one denies, which is the correct failure for an inbox
 * holding other people's correspondence. `@pithy-sh/auth` and `@pithy-sh/payments` are reached by
 * guarded dynamic import for the sender link, so both stay genuinely optional.
 */
export function support(options: SupportOptions = {}): SupportCapability {
  const { basePath, ...configInput } = options;
  const resolved = SupportConfigSchema.parse(configInput);
  const categories = resolveCategories(resolved.categories);
  const snippets = resolveReplies(resolved.reply.snippets);
  const mountPath = basePath ?? "/support";

  const wiring: SupportWiring = {
    config: resolved,
    categories,
    snippets,
    enqueueEmail: undefined,
    emit: noopEmit,
  };

  // One migration, unconditionally. The full-text index is **not** here: it is derived from the
  // messages table and rebuildable at any time, so it is a provisioned resource that
  // `pithy support provision` creates and drops (see `store/searchIndex.ts`), not schema whose loss
  // loses data. Keeping it out of the ledger is what makes `search.fts` safe to toggle in either
  // direction — a config flag must never be able to corrupt a migration set shared with every other
  // capability in the database.
  const migrations: Record<string, Migration> = { "0001_threads": support_0001_threads };

  const requiredBindings: BindingSpecInput[] = [
    // The app database every support table lives in.
    { type: "d1", name: "DB" },
    // Attachment and raw-message bytes. Optional: an inbox with attachments off never writes an
    // object, and a project that has not provisioned must still boot and still receive mail.
    { type: "r2", name: "SUPPORT_BUCKET", optional: true },
    // The classification Workflow the inbound handler dispatches to, derived from the spec rather
    // than listed again — one declaration, so a binding rename cannot leave the two disagreeing.
    ...workflowBindings(supportWorkflows),
  ];

  const capability = defineCapability({
    name: "support",
    // The package version this capability ships at, stamped by `scripts/stampVersions.ts` — a Worker
    // cannot read its own package.json. Reported per capability by the control-plane manifest.
    version: PACKAGE_VERSION,
    // Attachment presigning reads an R2 credential bundle through @pithy-sh/secrets.
    dependsOn: ["secrets"],
    secretRegistry: supportSecretsRegistry,
    workflows: supportWorkflows,
    requiredBindings,
    // Provisioning creates the routing rule that delivers mail to this Worker.
    ciPermissions: ["email:routing"],
    databases: {
      app: {
        binding: "DB",
        tables: supportTables,
        migrationOrder: SUPPORT_MIGRATION_ORDER,
        migrations,
      },
    },
    /**
     * Bind the optional email seam once, at startup.
     *
     * Deliberately not a hard `dependsOn`. Auth *requires* email — a magic link that cannot be sent
     * is a broken sign-in — but a support inbox that receives, threads, and classifies without being
     * able to answer is a coherent and useful thing, so a missing email capability degrades one
     * route instead of refusing to boot.
     */
    compose: ({ capabilities }) => {
      const email = capabilities.find(isEmailCapability);
      wiring.enqueueEmail = email?.enqueue;
    },
    // What a browser may know. Built from the resolved `mountPath`, never the default — the whole
    // point is that moving the mount moves the address the client posts to. See `clientProjection`
    // for why the list is as short as it is.
    client: (): SupportClientProjection => clientProjection(resolved, mountPath),
    adminRoutes: supportAdminRoutes(mountPath),
    routes: registerSupportRoutes({
      basePath: mountPath,
      submission: resolved.submission.enabled,
      resolveDeps: makeResolveDeps(wiring),
    }),
    email: createSupportEmailHandler(wiring),
    seeds: [supportExampleSeed],
  });

  return Object.assign(capability, {
    supportConfig: resolved,
    categories,
    snippets,
    basePath: mountPath,
  });
}

/** Whether a capability is the support capability — carries its resolved config and effective taxonomy. */
export function isSupportCapability(capability: Capability): capability is SupportCapability {
  return capability.name === "support" && "supportConfig" in capability;
}
