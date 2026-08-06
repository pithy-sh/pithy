// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "../error/pithyError";
import { type BindingSpec, isProvisionedBinding } from "./bindings";

/** How a missing binding is named in both halves of the error: `kv:SESSIONS`. */
function label(binding: BindingSpec): string {
  return `${binding.type}:${binding.name}`;
}

/**
 * What to do about the bindings that are missing — and there are two answers, not one.
 *
 * A `kv` or `d1` binding is a line the adopter adds to `wrangler.jsonc`. A `secret`, `workflow`, or
 * `vectorize` binding is not: its entry carries a provisioned value, so the old single line
 * ("Add the binding(s) to wrangler.jsonc, then redeploy.") sent anyone missing a Secrets Store entry
 * to a file that entry never appears in. Each list names only its own bindings, so a mixed failure
 * says which of them is which instead of leaving the reader to sort it out.
 */
function bindingAction(missing: BindingSpec[]): string {
  const written = missing.filter((binding) => !isProvisionedBinding(binding.type)).map(label);
  const provisioned = missing.filter((binding) => isProvisionedBinding(binding.type)).map(label);
  const sentences: string[] = [];
  if (written.length > 0) sentences.push(`Add ${written.join(", ")} to wrangler.jsonc, then redeploy.`);
  if (provisioned.length > 0) {
    sentences.push(`Provision ${provisioned.join(", ")} — a provision command creates those, or .dev.vars in dev.`);
  }
  return sentences.join(" ");
}

/** Throw a typed error if any non-optional binding is absent from `env`. */
export function validateBindings(env: Record<string, unknown>, required: BindingSpec[]): void {
  const missing = required.filter((b) => !b.optional && env[b.name] == null);
  if (missing.length > 0) {
    // A missing binding is a Worker misconfiguration, not a client-facing fault. The names are
    // config keys, not secrets, so they ride in the public message; this surfaces at startup.
    throw new InternalError({
      message: `Missing required bindings: ${missing.map(label).join(", ")}`,
      action: bindingAction(missing),
    });
  }
}
