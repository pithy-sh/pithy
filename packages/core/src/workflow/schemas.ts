// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The request and response contract of the host's dispatch route ({@link ./dispatchRoute.ts}).
 *
 * Declared here rather than on the route line for the reason every capability's `http/schemas.ts`
 * exists (CLAUDE.md §HTTP): the route declares *that* it validates, this declares *what*, and the
 * loopback dispatcher on the other end of the wire builds its body against the same object.
 *
 * **The path is here too, and that is deliberate.** An address is as much of the wire contract as a
 * body is, and putting it beside the route would make the dispatcher import the route module to know
 * where to POST — which is the module that imports the dispatcher to resolve a binding. One import
 * cycle, for a template string neither end owns more than the other.
 */

/** The reserved namespace the host's dispatch route lives under, beside `/__pithy/dev-login`. */
export const WORKFLOW_DISPATCH_BASE = "/__pithy/workflows";

/** The registered path pattern. `:binding` is the host's own Workflow binding name. */
export const WORKFLOW_DISPATCH_ROUTE = `${WORKFLOW_DISPATCH_BASE}/:binding`;

/** The concrete path for one binding — what the loopback dispatcher POSTs to. */
export function workflowDispatchPath(binding: string): string {
  return `${WORKFLOW_DISPATCH_BASE}/${encodeURIComponent(binding)}`;
}

/** The path segment naming which of the host's own Workflow bindings to start an instance on. */
export const WorkflowDispatchParams = z
  .object({
    binding: z
      .string()
      .min(1)
      .max(64)
      .regex(
        /^[A-Za-z_][A-Za-z0-9_]*$/,
        "A binding name is an identifier: letters, digits and underscores, not starting with a digit.",
      )
      .describe(
        "The Workflow binding on this host's own env — `EMAIL_SENDER`, not a `<capability>/<job>` key. The loopback dispatcher stands in for exactly one binding, and a binding is what it knows itself by.",
      ),
  })
  .describe("The path parameters of the host dispatch route.");
export type WorkflowDispatchParams = z.infer<typeof WorkflowDispatchParams>;

/** The body: the instance id and the payload, exactly as `create({ id, params })` takes them. */
export const WorkflowDispatchRequest = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe(
        "The instance id to start under. Optional because the platform's own `create` allows omitting it — and relayed rather than minted here, because an id a dispatcher did not choose is an instance the caller's row cannot name (pithy-sh/pithy#342). Every Pithy dispatcher passes one.",
      ),
    params: z
      .unknown()
      .describe(
        "The instance payload. Unconstrained on the wire and validated on arrival against the declaring spec's own schema, so a malformed payload fails with the field named rather than inside a running instance.",
      ),
  })
  .describe("A request to start one instance of a Workflow this host hosts.");
export type WorkflowDispatchRequest = z.infer<typeof WorkflowDispatchRequest>;

/**
 * The answer: which binding was started, under which id.
 *
 * A response object rather than an interface, for the reason every admin response is one (CLAUDE.md
 * §HTTP): the caller is across a process boundary, and a TypeScript interface is erased before it can
 * help. Nothing here carries a codec — an answer must parse back to exactly what went in.
 */
export const WorkflowDispatchResponse = z
  .object({
    binding: z.string().describe("The binding an instance was started on — the one the request named."),
    id: z.string().optional().describe("The instance id, when the request named one."),
    started: z
      .literal(true)
      .describe("Always true. The route answers 202 once Cloudflare has accepted the instance, never on completion."),
  })
  .describe("What the host answers when it has accepted a dispatch.");
export type WorkflowDispatchResponse = z.infer<typeof WorkflowDispatchResponse>;
