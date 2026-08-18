// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { resolveWorkflowBinding } from "@pithy-sh/core/src/workflow/dispatch";
import type { SendWorkflowBinding } from "./enqueue";

/**
 * Where the send Workflow comes from — one answer, for the two call sites that need it.
 *
 * `email().enqueue` and the admin retry route both start a send, and both used to read
 * `env.EMAIL_SENDER` straight off the request env. Under `pithy dev` that binding does not exist:
 * it is a **cross-script** binding at `<project>-dev-email`, and no local script runs under that
 * name, so every immediate send was born `undispatched` and the local loop was silent
 * (pithy-sh/pithy#410). A module rather than a line in each place, because the day the two answers
 * differ is the day one of them stops sending mail and nothing says so.
 */

/**
 * What deciding the sender reads off the env, and nothing else.
 *
 * Three keys, not the whole enqueue env: `DB` and the suppression list are somebody else's question,
 * and a narrower parameter is what lets the admin routes' own env shape pass without a cast.
 */
export interface EmailSenderEnv {
  /** The bound send Workflow. Present in every deployed environment; absent under `pithy dev`. */
  EMAIL_SENDER?: SendWorkflowBinding;
  /**
   * The environment this composition was stamped for — `pithy init` writes it into every Worker's
   * `wrangler.jsonc`. Read only to refuse: a substitution happens in `dev` and nowhere else.
   */
  ENVIRONMENT?: string;
  /**
   * The local email host's address, written by `pithy dev` as a `--var`. Present only in `dev`, where
   * it is what stands in for the cross-script binding no local script can provide.
   */
  EMAIL_ORIGIN?: string;
}

/**
 * The Workflow that starts a send: the bound one, or — under `pithy dev` — a loopback dispatcher
 * addressed at the local email host.
 *
 * The rules are core's ({@link resolveWorkflowBinding}) and are stated there. The one thing decided
 * here is that email's host is the capability named `email`, which is what makes the var
 * `EMAIL_ORIGIN`.
 *
 * **Absent still means absent.** A composition with no binding and no local host enqueues the row
 * `undispatched` exactly as it did — this fills the seam, it never invents one.
 */
export function emailSenderBinding(env: EmailSenderEnv): SendWorkflowBinding | undefined {
  // An interface is not assignable to an index signature, and core's resolver reads an env by name.
  return resolveWorkflowBinding(env as unknown as Record<string, unknown>, {
    binding: "EMAIL_SENDER",
    capability: "email",
  });
}
