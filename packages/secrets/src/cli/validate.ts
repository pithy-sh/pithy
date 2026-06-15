import { SecretInvalidValueError } from "../error/errors";
import type { SecretRegistryEntry } from "../registry";

/**
 * The CLI's authoritative, client-side value validation (the A2 model). The worker cannot validate
 * a not-yet-deployed secret's shape, so the CLI — which runs from the user's repo with the fresh
 * registry — is the validator. A `text` value passes through; a `json` value is parsed and validated
 * against the entry's schema, then returned re-serialized (canonical form) for dispatch.
 *
 * Errors are redacted: only `path:code`, never `issue.message`/the payload, which can echo the
 * secret material. This mirrors the read seam's `parseValue` so write-time and read-time validation
 * report identically.
 */
export function validateSecretValue(entry: SecretRegistryEntry, name: string, raw: string): string {
  if (entry.valueType === "text") return raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new SecretInvalidValueError(
      { message: `Secret '${name}' is not valid JSON.`, detail: `json secret '${name}' failed to parse` },
      { cause },
    );
  }
  const result = entry.schema.safeParse(parsed);
  if (!result.success) {
    const summary = result.error.issues.map((i) => `${i.path.join(".") || "<root>"}:${i.code}`).join(", ");
    throw new SecretInvalidValueError({
      message: `Secret '${name}' failed validation.`,
      detail: `json secret '${name}' failed registry validation: ${summary}`,
    });
  }
  return JSON.stringify(result.data);
}
