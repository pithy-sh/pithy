// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { d1TransientFault } from "../data/withD1Retry";
import { PithyError } from "../error/pithyError";

/**
 * **Every fault that reaches a durable step is classified — retryable or terminal — at a stated site.**
 *
 * A Workflow is chosen *because of* its retry semantics: durable execution, a journal, steps that resume,
 * backoff that survives an eviction. A step that inherits the platform default has not decided; it has
 * deferred, and the default is retry-everything. So a deterministic refusal — a name that already exists,
 * a value too large, a payload that will not parse — is answered slowly instead of immediately, the retry
 * budget burns down on an answer that cannot change, and an instant refusal looks like an outage
 * (pithy-sh/pithy#338).
 *
 * ## The three layers, and which owns what
 *
 * 1. **The capability states its own codes.** A {@link WorkflowRetryPolicy} names the `PithyError` codes
 *    that capability retries, each with the reason a second attempt can answer differently. One statement
 *    per capability, in one file, the way `@pithy-sh/email`'s `errorMapping.ts` already states the Email
 *    Service's `E_*` codes.
 * 2. **Core owns D1.** `withD1Retry` already classifies D1's fault vocabulary, so this asks it rather than
 *    growing a second copy — and that is also the no-double-retry rule: a fault the inner layer refused to
 *    retry (a constraint violation, a SQL error) is terminal here too, while a transient one stays
 *    retryable so the step re-drives it with backoff far longer than the inner loop's.
 * 3. **Everything else is terminal.** Retry is opted into, never inherited. The platform default is the
 *    opposite, and it is the wrong way round: a terminal fault wrongly called transient burns the whole
 *    budget before surfacing, while a transient one wrongly called terminal surfaces immediately with the
 *    fault written on it. One of those is a diagnosis; the other is a hang.
 *
 * ## Where the wrapping happens, and why it cannot be anywhere else
 *
 * {@link classifiedSteps} converts a terminal fault **inside** the step callback. The platform's retry loop
 * lives inside `step.do`: by the time a `step.do` promise rejects, every retry has already been spent. A
 * wrapper around the call would classify a fault the engine had already re-driven five times — correct
 * looking, and exactly as slow as doing nothing.
 */

/** Whether the platform should try a step's body again, or stop with the answer it has. */
export type WorkflowFaultDisposition = "retry" | "terminal";

/**
 * One capability's stated retry classification — the whole of what it retries, and why.
 *
 * A record rather than a set, because the value is the argument: "what would a second attempt see that
 * this one did not" is the question that decides, and writing the answer down is what keeps the next code
 * from being added to the list by reflex.
 */
export interface WorkflowRetryPolicy {
  /** The capability whose Workflows this governs — `secrets`, `payments`, `email`. Named in the fault's reason. */
  capability: string;
  /**
   * `PithyError` code → why a retry can answer differently. **Everything absent is terminal**, including
   * codes another capability retries: a 502 from a payment rail is worth re-driving, and a 502 from a
   * store that has already taken the write is not.
   */
  retryable: Readonly<Record<string, string>>;
}

/** One fault, classified: what it was, what happens next, and the stated reason for it. */
export interface WorkflowFault {
  /** Retry, or stop. */
  disposition: WorkflowFaultDisposition;
  /** The `PithyError` code, `d1/<fault>` for a D1 fault class, or `unclassified`. */
  code: string;
  /** Why — the policy's own sentence for a retry, or what made this terminal. */
  reason: string;
}

/** The `code` reported for a throw no layer recognises. */
const UNCLASSIFIED = "unclassified";

/**
 * The code a thrown value carries, or `null` when it is not a `PithyError`.
 *
 * The structural read is not belt-and-braces: `instanceof` is per module instance, and a bundler that
 * gives a host worker two copies of core would silently answer `false` for a perfectly good
 * `PithyError` — which here means classifying a stated retryable fault as terminal. The shape is
 * checked, not assumed.
 */
function pithyCodeOf(error: unknown): string | null {
  if (error instanceof PithyError) return error.payload.code;
  if (error && typeof error === "object" && "payload" in error) {
    const payload = (error as { payload: unknown }).payload;
    if (payload && typeof payload === "object" && "code" in payload) {
      const code = (payload as { code: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  return null;
}

/** The public message of a thrown value, for the terminal error's own text. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classify one fault against a capability's policy. Pure, so a capability's classification is a unit
 * test rather than a claim — and so the same function decides in a test, in Miniflare, and in production.
 */
export function classifyWorkflowFault(error: unknown, policy: WorkflowRetryPolicy): WorkflowFault {
  const code = pithyCodeOf(error);
  if (code !== null) {
    const reason = policy.retryable[code];
    if (reason !== undefined) return { disposition: "retry", code, reason };
    return {
      disposition: "terminal",
      code,
      reason: `${policy.capability} does not retry ${code}: a second attempt reaches the same answer.`,
    };
  }

  const d1 = d1TransientFault(error);
  if (d1 !== null) {
    return {
      disposition: "retry",
      code: `d1/${d1}`,
      reason: `D1 reported a transient ${d1} fault; withD1Retry classifies it retryable.`,
    };
  }

  return {
    disposition: "terminal",
    code: UNCLASSIFIED,
    reason: `Nothing classifies this fault, and ${policy.capability} retries only what it states.`,
  };
}

/** The half of a Workflow step this kit uses: run a named body, or serve its journalled result. */
export interface WorkflowStepLike {
  /** Run a named step, or return its journalled result if this instance already completed it. */
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * The platform's terminal-error class — `NonRetryableError` from `cloudflare:workflows`, taken as a
 * parameter.
 *
 * Injected rather than imported because `@pithy-sh/core` is bundled into every adopter's Worker *and*
 * imported by the CLI under node, so it may not import a `cloudflare:` module. The Workflow class is
 * already inside workerd and already imports one; handing the class in costs it a word and keeps the
 * classification itself testable anywhere.
 *
 * **One argument, deliberately.** `NonRetryableError`'s constructor also takes a `name`, and the engine
 * recognises the error *by* that name: measured against a real Workflow in `wrangler dev`, passing any
 * name but the default turned an instance that failed in 0.7s back into one that retried for 32s and
 * then failed. The signature is narrowed so nobody can reintroduce that by being helpful.
 */
export interface TerminalErrorConstructor {
  new (message: string): Error;
}

/**
 * Wrap a Workflow's step runner so every fault it raises is classified against `policy`, and a terminal
 * one is re-thrown as the platform's terminal error — **inside the step**, before the retry loop reads it.
 *
 * The result is structurally a step runner, so a body that already takes one (`reconcilePayments`,
 * `runSendBatch`, `runAtRestKeyRotation`) takes this instead with no change: the classification is
 * declared once, at the entrypoint, and every step below it inherits the decision.
 */
export function classifiedSteps(
  step: WorkflowStepLike,
  policy: WorkflowRetryPolicy,
  terminalError: TerminalErrorConstructor,
): WorkflowStepLike {
  return {
    do<T>(name: string, fn: () => Promise<T>): Promise<T> {
      return step.do(name, async () => {
        try {
          return await fn();
        } catch (error) {
          const fault = classifyWorkflowFault(error, policy);
          if (fault.disposition === "retry") throw error;
          // The one sanctioned non-`PithyError` throw in the kit: a platform contract, at the durable
          // boundary, carrying the `PithyError` it replaced as its `cause` so nothing is lost. The
          // message is the public one plus its code, because a Workflow's error text is read by an
          // operator — though the engine currently reports its own sentence on the instance instead of
          // this one, which is pithy-sh/pithy#349.
          const terminal = new terminalError(`${fault.code}: ${messageOf(error)}`);
          terminal.cause = error;
          throw terminal;
        }
      });
    },
  };
}
