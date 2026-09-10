// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SecretInvalidValueError } from "../error/errors";
import type { SecretRegistryEntry } from "../registry";

/**
 * The CLI's authoritative, client-side value validation (the A2 model). The worker cannot validate
 * a not-yet-deployed secret's shape, so the CLI — which runs from the user's repo with the fresh
 * registry — is the validator. A `text` value passes through; a `json` value is parsed and validated
 * against the entry's schema, then returned re-serialized (canonical form) for dispatch.
 *
 * Errors are redacted: only `path:code`, never `issue.message`/the payload, which can echo the
 * secret material.
 *
 * **And the redacted half is on `message`, where an operator can read it.** It was on `detail` alone,
 * which is the throw site's field: `renderTerminal` prints `message` and `action`, `operatorError`
 * parses `detail` off for the `--json` line, and `clientError` strips it at the wire — so "the failure
 * names the field" was true of nothing anyone sees. That matters most for exactly the path #516 added:
 * six masked prompts, one of them left empty, and a refusal that named the secret but not which
 * question to answer again. A field **name** is the schema's own documentation and is safe to print; a
 * field **value** is the thing this function exists to keep out of a terminal, and neither the name nor
 * the code carries one. `detail` keeps the same summary for the log.
 *
 * The read seam's `parseValue` deliberately does not follow. It runs inside the Worker, where `message`
 * crosses to a client on a `secrets/invalid_value`, and which field of a customer's credential bundle is
 * malformed is not a caller's business. Same rule, two audiences, and the audience is what differs.
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
    const fields = [...new Set(result.error.issues.map((i) => i.path.join(".") || "<root>"))].join(", ");
    throw new SecretInvalidValueError({
      // The field, by the same dotted path the prompt asked under — and no `action`, because the remedy
      // is to answer that field again and the message has just said which one it is.
      message: `Secret '${name}' failed validation: ${fields}.`,
      detail: `json secret '${name}' failed registry validation: ${summary}`,
    });
  }
  return JSON.stringify(result.data);
}
