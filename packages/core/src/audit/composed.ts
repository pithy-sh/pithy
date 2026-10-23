// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "../capability/capability";
import { type AuditEmit, noopEmit } from "./recorder";

/**
 * The audit recorder for code with no request — a Workflow step (#622).
 *
 * A route records through `c.var.emit`. A Workflow has no `c`: the runtime constructs it with `env` and nothing
 * else. So it finds the composed capability that declares {@link Capability.auditRecorder} — `@pithy-sh/audit`
 * — and records through that, built over this run's env. With none composed it is {@link noopEmit}, exactly as
 * `c.var.emit` is in a Worker that composes no audit, so a step can always record without asking first.
 *
 * **Non-fatal, whatever the recorder does.** The contract says a recorder never throws; this holds a recorder
 * to it rather than trusting it, because what a step records has already happened and a throw here would turn
 * it into a retried step.
 */
export function composedAuditEmit(capabilities: readonly Capability[], env: Record<string, unknown>): AuditEmit {
  const provider = capabilities.find((capability) => capability.auditRecorder !== undefined);
  if (!provider?.auditRecorder) return noopEmit;
  const record = provider.auditRecorder(env);
  return async (event) => {
    try {
      await record(event);
    } catch {
      // The recorder broke its own contract. The event is lost, and the step it recorded stands.
    }
  };
}
