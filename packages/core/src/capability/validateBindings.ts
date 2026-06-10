import type { BindingSpec } from "./bindings";

/** Throw a clear error if any non-optional binding is absent from `env`. */
export function validateBindings(env: Record<string, unknown>, required: BindingSpec[]): void {
  const missing = required.filter((b) => !b.optional && env[b.name] == null).map((b) => `${b.type}:${b.name}`);
  if (missing.length > 0) {
    throw new Error(`Missing required bindings: ${missing.join(", ")}`);
  }
}
