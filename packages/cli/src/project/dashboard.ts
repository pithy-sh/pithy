// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Cloudflare dashboard deep-link builders, keyed by resource kind. `pithy env` renders a
 * provisioned resource's id as a link to the exact dashboard page for that resource, so an
 * operator jumps straight from the inventory to the console.
 *
 * **Every path here was checked against a live dashboard.** A kind with no confirmed path gets no
 * link — {@link dashboardUrl} returns `null` for it — because an unconfirmed deep link is worse
 * than a bare id: it looks authoritative and lands on a 404. All links share the base
 * `https://dash.cloudflare.com/<account_id>/…`.
 *
 * Two shapes of link live here. **Resource links** address one provisioned resource by its id.
 * **Account links** address a product page that has no per-resource route at all (Workers AI usage,
 * Images, Stream, Email Service); they ignore the id, so a caller may pass an empty one.
 *
 * Two kinds deliberately have no builder:
 * - **`ratelimit`** — Workers Rate Limiting has no dashboard page at all.
 * - **`service`** — a service binding is not a resource; it is direct RPC to *another Worker*. Its
 *   page is that Worker's, so a caller resolves the target script name and asks for the `worker`
 *   kind instead.
 */

/** Kinds whose dashboard page addresses one resource by id. */
type ResourceKind =
  | "worker"
  | "d1"
  | "kv"
  | "r2"
  | "vectorize"
  | "workflow"
  | "durable_object"
  | "queue"
  | "secret"
  | "turnstile";

/** Kinds with no per-resource page — the link is the product's account-level page. */
type AccountKind = "ai" | "images" | "stream" | "email";

/** The base every dashboard link is built on. */
const DASHBOARD_BASE = "https://dash.cloudflare.com";

/**
 * One builder per id-addressed kind. `id` is that kind's **dashboard** identifier, which is not
 * always the identifier `wrangler.jsonc` carries — see the notes below before wiring a caller.
 *
 * D1 and KV land on the resource's metrics tab, which is the dashboard's own default page for those
 * two, so the link lands exactly where clicking through the console would.
 */
const RESOURCE_BUILDERS: Record<ResourceKind, (accountId: string, id: string) => string> = {
  worker: (accountId, id) => `${DASHBOARD_BASE}/${accountId}/workers/services/view/${id}/production`,
  d1: (accountId, id) => `${DASHBOARD_BASE}/${accountId}/workers/d1/databases/${id}/metrics`,
  kv: (accountId, id) => `${DASHBOARD_BASE}/${accountId}/workers/kv/namespaces/${id}/metrics`,
  r2: (accountId, id) => `${DASHBOARD_BASE}/${accountId}/r2/default/buckets/${id}`,
  vectorize: (accountId, id) => `${DASHBOARD_BASE}/${accountId}/ai/vectorize/${id}`,
  workflow: (accountId, id) => `${DASHBOARD_BASE}/${accountId}/workers/workflows/${id}/instances`,
  // `id` is the Durable Object **namespace id** Cloudflare assigns (32-char hex), not the class
  // name. `wrangler.jsonc` carries only the class name, so a caller holding just that must not build
  // this link — see `envInventory`, which renders DO bindings unlinked for exactly this reason.
  durable_object: (accountId, id) => `${DASHBOARD_BASE}/${accountId}/workers/durable-objects/view/${id}/overview`,
  // `id` is the **queue id** (32-char hex), not the queue name a producer binding declares. Same
  // caveat as `durable_object`: a caller holding only the name must not build this link.
  queue: (accountId, id) => `${DASHBOARD_BASE}/${accountId}/workers/queues/${id}/metrics`,
  // `id` is the Secrets Store id, not a secret's name — the page is the store, not one entry.
  secret: (accountId, id) => `${DASHBOARD_BASE}/${accountId}/secrets-store/${id}`,
  // `id` is the widget's sitekey (e.g. `0x4AAA…`), which `pithy turnstile` writes into wrangler vars.
  turnstile: (accountId, id) => `${DASHBOARD_BASE}/${accountId}/turnstile/widget/${id}`,
};

/**
 * The product **list** page for a kind whose per-resource id a project cannot know from config alone.
 *
 * A Durable Object binding names a *class* and a queue binding names a *queue*, but the dashboard addresses
 * both by an id Cloudflare assigns — a DO namespace id when a Worker exporting the class deploys, a queue id
 * when the queue is created. Neither is written back into `wrangler.jsonc`, and resolving one would take an
 * API call this read-only, credential-optional command deliberately does not make. So the link goes to the
 * product's list, which is one click from the resource and always correct, rather than nowhere.
 *
 * Both routes below were checked against a live dashboard, like every other path in this file.
 */
const LIST_BUILDERS: Record<string, (accountId: string) => string> = {
  durable_object: (accountId) => `${DASHBOARD_BASE}/${accountId}/workers/durable-objects`,
  queue: (accountId) => `${DASHBOARD_BASE}/${accountId}/workers/queues`,
};

/**
 * The list page for a kind, or `null` when it has none. Used as the fallback when a resource is real and
 * provisioned but its dashboard id is not knowable from the project's own config.
 */
export function dashboardListUrl(kind: string, accountId: string): string | null {
  const build = LIST_BUILDERS[kind];
  return build ? build(accountId) : null;
}

/** One builder per account-level kind. The resource id is not part of the route. */
const ACCOUNT_BUILDERS: Record<AccountKind, (accountId: string) => string> = {
  ai: (accountId) => `${DASHBOARD_BASE}/${accountId}/ai/workers-ai/usage`,
  images: (accountId) => `${DASHBOARD_BASE}/${accountId}/images/hosted`,
  stream: (accountId) => `${DASHBOARD_BASE}/${accountId}/stream/videos`,
  email: (accountId) => `${DASHBOARD_BASE}/${accountId}/email-service/sending`,
};

/**
 * Build the Cloudflare dashboard URL for a resource, or `null` when the kind has no confirmed
 * dashboard path. `kind` is a plain string so callers can pass any binding kind (`ratelimit`,
 * `service`, …) without narrowing; an unsupported kind returns `null` rather than a guessed link.
 * An account-level kind ignores `id`, so `""` is fine for those.
 */
export function dashboardUrl(kind: string, accountId: string, id: string): string | null {
  const account = (ACCOUNT_BUILDERS as Record<string, ((accountId: string) => string) | undefined>)[kind];
  if (account) return account(accountId);

  const resource = (RESOURCE_BUILDERS as Record<string, ((accountId: string, id: string) => string) | undefined>)[kind];
  // An id-addressed kind with no id has nothing to point at — a bare product page would be a lie.
  if (!resource || !id) return null;
  return resource(accountId, id);
}
