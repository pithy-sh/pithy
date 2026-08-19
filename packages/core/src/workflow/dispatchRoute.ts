// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { zValidator } from "@hono/zod-validator";
import type { Context, Hono, Next } from "hono";
import type { PithyHonoEnv } from "../capability/capability";
import { type AmbientEnv, ambientEnv, compositionEnvironment } from "../env/ambient";
import { ForbiddenError, PithyError } from "../error/pithyError";
import { validationHook } from "../http/validation";
import type { VerificationStrategy } from "../http/verification";
import { workflowBindingFor } from "./dispatch";
import {
  WORKFLOW_DISPATCH_ROUTE,
  WorkflowDispatchParams,
  WorkflowDispatchRequest,
  type WorkflowDispatchResponse,
} from "./schemas";
import type { RegisteredWorkflow, WorkflowRegistry } from "./spec";

/**
 * The host's dispatch route — the loopback door `pithy dev` starts an instance through.
 *
 * ## Why a host needs an HTTP door at all
 *
 * A deployed app Worker starts a capability's Workflow through a **cross-script** binding:
 * `{ binding: "EMAIL_SENDER", script_name: "<project>-<env>-email" }`. `pithy dev` does not run that
 * second Worker's script under that name, and CLAUDE.md rules out wrangler's cross-`wrangler dev`
 * registry, so locally the binding names nothing and the call throws (pithy-sh/pithy#410). What
 * *does* exist locally is loopback: every worker in the dev set has a pinned port and an
 * `<STEM>_ORIGIN` in every sibling's env. This route is the other end of that wire.
 *
 * The instance is started on the **host's own same-script binding** — the one with no `script_name`,
 * which `wrangler dev` implements unchanged. So the local path and the deployed path run the same
 * Workflow class, from the same registry, with the same params schema. Only the hop differs.
 *
 * ## The environment gate is the security boundary
 *
 * An HTTP door into another Worker's Workflows is not something the kit leaves open. The route is
 * served in a `dev` composition and refused in every other, by a guard that runs before anything
 * reads the request.
 *
 * **It is a mounted refusal, not an unmounted route** — deliberately the opposite of
 * `@pithy-sh/auth`'s dev-login, and the difference is what the two routes do. Dev-login mints an
 * authenticated session with no credential presented, so its existence in a production route table is
 * itself the finding, and it registers nothing outside `dev`. This route starts a job the host
 * already runs on its own cron, on a binding the caller must already have, and it starts nothing at
 * all before the guard has run. What an operator gains from mounting it is the answer: a loopback
 * dispatcher wired into `staging` by mistake gets `auth/forbidden` naming the binding as the path,
 * rather than a 404 that reads as a typo and sends them looking at the URL.
 *
 * **There is no second CI gate**, and that too is the opposite of dev-login's, on purpose. CI is
 * precisely where the local loop has to work — `pithy dev` under an integration suite is a `dev`
 * composition dispatching over loopback — and a gate that shut it there would turn the silence #410
 * repairs back on in the one place nobody is watching for it.
 *
 * ## Contract
 *
 * `public` verification and a declared request contract, with the guard ahead of both validators so
 * a refusal is never downgraded to a 400 that tells a caller which request shapes are well-formed.
 */

/**
 * How the route verifies its caller: it does not.
 *
 * Stated rather than omitted, because every route declares one (CLAUDE.md §HTTP) and `public` is the
 * honest answer — there is no credential on this wire. What stands in for one is the environment
 * gate plus the address: the route answers only in a `dev` composition, and a `dev` composition is a
 * `wrangler dev` bound to loopback on a port `pithy dev` pinned. Deployed environments reach the same
 * Workflow through the cross-script binding and never through this.
 */
export const WORKFLOW_DISPATCH_VERIFICATION: VerificationStrategy = "public";

/** The environment this route serves in. Verbatim, and the only one. */
const DISPATCH_ENVIRONMENT = "dev";

/** What the route needs to serve: whose host this is, what it hosts, and where it is running. */
export interface WorkflowDispatchOptions {
  /** The capability that owns the host. Named in refusals, so an operator knows which Worker answered. */
  capability: string;
  /**
   * The composed registry this host runs. The route resolves `:binding` against it, so a binding the
   * host hosts no Workflow for is refused by name — and the params validate against the declaring
   * spec's own schema rather than against anything restated here.
   */
  registry: WorkflowRegistry;
  /**
   * The ambient environment the gate reads. Defaults to the process env, which in a Worker is the
   * script's own vars — where `pithy init` stamps `ENVIRONMENT`. Injectable for tests.
   */
  env?: AmbientEnv;
}

/** The job this host hosts on a given binding, or `undefined`. */
function specForBinding(registry: WorkflowRegistry, binding: string): RegisteredWorkflow | undefined {
  return Object.values(registry).find((entry) => entry.spec.binding === binding);
}

/**
 * The refusal. `auth/forbidden` (403) rather than a 404: the door exists, it is shut because of
 * *where* this Worker is running, and pretending otherwise costs the operator the sentence that ends
 * their search. `action` names the real path and is stripped before it reaches the caller, like every
 * other action.
 */
function refuseOutsideDev(capability: string, environment: string | undefined): ForbiddenError {
  return new ForbiddenError({
    message: `Workflow dispatch over HTTP is served only in the ${DISPATCH_ENVIRONMENT} environment.`,
    action: `Dispatch through the cross-script ${capability} Workflow binding, or run this host under pithy dev.`,
    detail: `The composition's ENVIRONMENT is ${environment ?? "unstamped"}.`,
  });
}

/**
 * Mount the dispatch route on a host worker's app.
 *
 * The guard is registered as middleware ahead of the validators so the order is structural rather
 * than remembered: outside `dev` nothing reads the path, the body, or the env.
 */
export function registerWorkflowDispatchRoute(app: Hono<PithyHonoEnv>, options: WorkflowDispatchOptions): void {
  const { capability, registry } = options;
  const ambient = options.env;

  // Read at call time, never captured: a module-scope snapshot freezes the answer for the life of an
  // isolate and is unstubbable in a test.
  const guard = async (_c: Context<PithyHonoEnv>, next: Next): Promise<void> => {
    const environment = compositionEnvironment(ambient ?? ambientEnv());
    if (environment !== DISPATCH_ENVIRONMENT) throw refuseOutsideDev(capability, environment);
    await next();
  };

  app.post(
    WORKFLOW_DISPATCH_ROUTE,
    guard,
    zValidator("param", WorkflowDispatchParams, validationHook),
    zValidator("json", WorkflowDispatchRequest, validationHook),
    async (c) => {
      const { binding } = c.req.valid("param");
      const { id, params } = c.req.valid("json");

      const entry = specForBinding(registry, binding);
      if (!entry) {
        const known = Object.values(registry)
          .map((registered) => registered.spec.binding)
          .sort()
          .join(", ");
        throw new PithyError({
          code: "core/unknown_workflow",
          status: 500,
          message: `No workflow on this host is bound to "${binding}".`,
          action: `Check the binding name against the ${capability} capability's declared workflows.`,
          detail: known ? `This host hosts: ${known}.` : "This host hosts no workflows at all.",
        });
      }

      // Params before the binding, exactly as `triggerWorkflow` does it: a malformed payload is the
      // caller's fault and must report the same way whether or not the binding happens to be wired.
      const parsed = entry.spec.params.safeParse(params);
      if (!parsed.success) {
        throw new PithyError({
          code: "core/invalid_workflow_params",
          status: 400,
          message: `The parameters for workflow "${entry.key}" are not valid.`,
          action: "Correct the parameters to match the workflow's schema.",
          detail: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
        });
      }

      const target = workflowBindingFor(c.env as Record<string, unknown>, binding);
      if (!target) {
        throw new PithyError({
          code: "core/missing_workflow_binding",
          status: 500,
          message: `The workflow binding "${binding}" is not available on this host.`,
          action: `Bind ${binding} in the ${capability} host's wrangler.jsonc, then restart it.`,
          detail: `Dispatching "${entry.key}" needs a same-script Workflow binding named ${binding}.`,
        });
      }

      await target.create({ id, params: parsed.data });
      // 202, not 200: Cloudflare has accepted the instance, and a Workflow is durable precisely so
      // nobody holds its progress. `satisfies` binds the body to the response schema at compile time.
      return c.json({ binding, id, started: true } satisfies WorkflowDispatchResponse, 202);
    },
  );
}
