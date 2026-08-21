// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { HttpError } from "../error/http";
import { NotFoundError } from "../error/pithyError";

/**
 * The default export of a Workflow host that serves nothing over HTTP (#426).
 *
 * ## Why a host needs a default export at all
 *
 * wrangler infers a worker's **module format** from one thing: whether the entry has a default export. A
 * module that exports only classes is read as a service worker, and a service worker may not import
 * `cloudflare:workers` — so the build does not warn and continue, it fails:
 *
 *     ▲ [WARNING] The entrypoint … has exports like an ES Module, but hasn't defined a default export
 *               like a module worker normally would. Building the worker using "service-worker" format...
 *     ✘ [ERROR] Unexpected external import of "cloudflare:workers" and "cloudflare:workflows".
 *
 * `pithy dev` builds each worker separately and carries on past one that fails, so the whole of what an
 * adopter sees is a host that is not there. `support`, `media` and `vector` each shipped that way, and every
 * host that did not was a host with a cron — `export default { async scheduled(…) }`, written for the cron,
 * making the module an ES module by accident. The four authors who satisfied the rule had a reason unrelated
 * to it, and the three who did not had no reason at all. `cli/src/ci/workflowModuleFormat.test.ts` is what
 * now asks the question of the class rather than of the author.
 *
 * ## Why it refuses rather than being empty
 *
 * `export default {}` would build. It would also say nothing: an operator who reaches this Worker in a
 * browser or with a stray `curl` gets an empty 200-shaped nothing from a Worker they were told hosts a job.
 * A Workflow host has no request surface — an app Worker starts its jobs through a cross-script Workflow
 * binding, and a host with a cron fires its own `scheduled` — so an HTTP request arriving at one is a
 * misconfiguration, and the refusal is the sentence that ends the operator's search. `core/not_found`,
 * because that is the truth: this Worker has no HTTP resources. The `action` names the path that does work
 * and is stripped before the body goes out, like every other action.
 *
 * ## The one host this is not for
 *
 * A host that *does* serve HTTP mounts `registerWorkflowDispatchRoute` (./dispatchRoute) and exports its own
 * handler. `@pithy-sh/email` is the case, and its door is the loopback dispatch `pithy dev` knocks on
 * (#410). The other hosts have not been given that door yet; when one is, its `export default` becomes the
 * Hono app and this refusal becomes that app's fallthrough. Nothing here has to change for that.
 */

/** What a refusing host exports: a `fetch`, and nothing else. Every other entry a Worker has is absent. */
export interface WorkflowHostEntry {
  /** Refuse the request. The platform passes a request, an env and a context; none is read, so none is declared. */
  fetch(): Promise<Response>;
}

/**
 * Build the default export for a Workflow host with no HTTP surface.
 *
 * Takes the capability so the refusal says which Worker answered — an operator holding a port number and a
 * 404 needs that before anything else.
 */
export function workflowHostEntry(capability: string): WorkflowHostEntry {
  return {
    async fetch(): Promise<Response> {
      const refusal = new NotFoundError({
        message: `The ${capability} workflow host serves no HTTP requests.`,
        action: `Start its Workflows through the ${capability} Workflow binding, not over HTTP.`,
        detail: "This Worker hosts Workflow classes and registers no routes.",
      });
      return new Response(JSON.stringify({ error: HttpError.encode(refusal.payload) }), {
        status: refusal.payload.status,
        headers: { "content-type": "application/json" },
      });
    },
  };
}
