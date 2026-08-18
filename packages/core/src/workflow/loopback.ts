// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { UpstreamError, UpstreamTimeoutError } from "../error/pithyError";
import { type WorkflowDispatchRequest, workflowDispatchPath } from "./schemas";
import type { WorkflowBinding } from "./spec";

/**
 * The loopback dispatcher: the one-method dispatch seam, carried over a sibling's origin instead of
 * a cross-script binding.
 *
 * `pithy dev` composes this in place of `env.EMAIL_SENDER` (and its eight siblings). Nothing at the
 * call site changes — `enqueueEmail` takes a `create({ id, params })` and does not care what is
 * behind it — which is the whole reason the seam was one method to begin with. The address comes
 * from `<STEM>_ORIGIN`, which the dev orchestrator exports for every member of the dev set, pinned
 * at feature-create and stable for the life of the feature.
 *
 * ## Failures are the sibling's, and they say so
 *
 * A worker that is not up, a port nothing is listening on, a host that refuses the dispatch: every
 * one of those is a hop into something this process does not control, so it is
 * `core/upstream_failed` (502) or `core/upstream_timeout` (504) — never `core/internal`, which would
 * send an operator to read *our* logs about *their* Worker (CLAUDE.md §Errors). The `action` names
 * the capability and the origin, because "is the email host running?" is the next question and the
 * terminal already knows the answer.
 *
 * The timeout is not decoration. `enqueue` awaits this call on a request path, and a sibling that
 * accepts a connection and never answers would otherwise hold a sign-in open until the platform
 * killed it. A timed-out dispatch is reported as one — separately from a failed one — because the
 * instance may have started regardless, and the scheduler's re-drive asks that question of the
 * batch id rather than assuming an answer.
 */

/** How the dispatcher reaches the sibling. Structural, so a test hands over a plain function. */
export type LoopbackFetch = (url: string, init: RequestInit) => Promise<Response>;

/** What the dispatcher needs to stand in for one cross-script Workflow binding. */
export interface LoopbackWorkflowOptions {
  /**
   * The sibling worker's origin — `http://localhost:8797`, as `<STEM>_ORIGIN` carries it. A trailing
   * slash is tolerated; nothing else about it is rewritten.
   */
  origin: string;
  /** The Workflow binding to start on, named exactly as the host's own env binds it. */
  binding: string;
  /** The capability that owns the host. Named in the action line, so a failure says which worker. */
  capability?: string;
  /** The transport. Defaults to the runtime's `fetch`; injectable for tests. */
  fetch?: LoopbackFetch;
  /** How long to wait for the sibling. Defaults to 10 s — a local hop, so anything slower is stuck. */
  timeoutMs?: number;
}

/** 10 seconds. A loopback dispatch either lands immediately or is not going to. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** How much of a failing answer's body is worth carrying into a log line. */
const BODY_SNIPPET = 300;

/** Whether a rejection is the deadline rather than the connection. */
function isTimeout(cause: unknown): boolean {
  const name = (cause as { name?: unknown } | null | undefined)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/** A short, safe rendering of a failing answer's body. Never thrown from — a failure is already in hand. */
async function bodySnippet(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, BODY_SNIPPET);
  } catch {
    return "<unreadable>";
  }
}

/**
 * Build a {@link WorkflowBinding} that dispatches over loopback to a sibling worker's dispatch route.
 *
 * Returns the plain seam, so it drops into any env slot a cross-script binding occupied — including
 * `@pithy-sh/email`'s narrower `SendWorkflowBinding`, which is a subtype of this one.
 */
export function loopbackWorkflowBinding(options: LoopbackWorkflowOptions): WorkflowBinding {
  const origin = options.origin.replace(/\/+$/, "");
  const url = `${origin}${workflowDispatchPath(options.binding)}`;
  const owner = options.capability ?? options.binding;
  const send = options.fetch ?? ((target: string, init: RequestInit) => fetch(target, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const running = `Check that the ${owner} host is running under pithy dev at ${origin}.`;

  return {
    async create(instance?: { id?: string; params?: unknown }): Promise<unknown> {
      // The body is the route's own request schema, built as that type rather than as a literal, so a
      // change to the contract is a compile error on both ends of the wire at once.
      const body: WorkflowDispatchRequest = { id: instance?.id, params: instance?.params };

      let response: Response;
      try {
        response = await send(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        if (isTimeout(cause)) {
          throw new UpstreamTimeoutError(
            {
              message: "The workflow host did not answer in time.",
              action: running,
              detail: `POST ${url} exceeded ${timeoutMs} ms.`,
            },
            { cause },
          );
        }
        throw new UpstreamError(
          {
            message: "The workflow host could not be reached.",
            action: running,
            detail: `POST ${url} failed: ${String(cause)}`,
          },
          { cause },
        );
      }

      if (!response.ok) {
        throw new UpstreamError({
          message: "The workflow host refused the dispatch.",
          action: running,
          detail: `POST ${url} answered ${response.status}. ${await bodySnippet(response)}`,
        });
      }

      // The host answers `WorkflowDispatchResponse`; it is relayed rather than parsed, because the
      // seam's own return type is `unknown` and no caller reads it. A body that is not JSON is still
      // the sibling's fault, so it reports as one.
      try {
        return await response.json();
      } catch (cause) {
        throw new UpstreamError(
          {
            message: "The workflow host answered something that is not a dispatch result.",
            action: running,
            detail: `POST ${url} answered ${response.status} with an unreadable body.`,
          },
          { cause },
        );
      }
    },
  };
}
