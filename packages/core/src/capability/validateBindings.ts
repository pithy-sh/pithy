import { InternalError } from "../error/pithyError";
import type { BindingSpec } from "./bindings";

/** Throw a typed error if any non-optional binding is absent from `env`. */
export function validateBindings(env: Record<string, unknown>, required: BindingSpec[]): void {
  const missing = required.filter((b) => !b.optional && env[b.name] == null).map((b) => `${b.type}:${b.name}`);
  if (missing.length > 0) {
    // A missing binding is a Worker misconfiguration, not a client-facing fault. The names are
    // config keys, not secrets, so they ride in the public message; this surfaces at startup.
    throw new InternalError({
      message: `Missing required bindings: ${missing.join(", ")}`,
      action: "Add the binding(s) to wrangler.jsonc, then redeploy.",
    });
  }
}
