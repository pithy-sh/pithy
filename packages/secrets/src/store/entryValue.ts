// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import { SecretInvalidValueError } from "../error/errors";

/**
 * A value's two crossings of the envelope — read and write — for anything that declares a value type: a
 * registry entry, or a declared table's secret (`../tables/defineSecretTable`). One copy, so a `json` value
 * is validated and re-serialized by the same rule wherever it is stored.
 */

/** What these read off a declaration: its value type, and for `json` the schema. */
export type ValueShape = { valueType: "text" } | { valueType: "json"; schema: z.ZodType };

/** Parse a raw stored string into the entry's value type: `text` passes through, `json` is validated. */
export function parseValue(entry: ValueShape, name: string, raw: string): unknown {
  if (entry.valueType === "text") return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    // Never echo the payload — it is sensitive credential material.
    throw new SecretInvalidValueError(
      { message: `Secret '${name}' is not valid JSON.`, detail: `json secret '${name}' failed to parse` },
      { cause },
    );
  }
  const result = entry.schema.safeParse(parsed);
  if (!result.success) {
    // Only path + code — never `issue.message`/`received`, which can echo the secret value.
    const summary = result.error.issues.map((i) => `${i.path.join(".") || "<root>"}:${i.code}`).join(", ");
    throw new SecretInvalidValueError({
      message: `Secret '${name}' failed validation.`,
      detail: `json secret '${name}' failed registry validation: ${summary}`,
    });
  }
  return result.data;
}

/**
 * A caller's value as the string that goes inside the envelope — the inverse of {@link parseValue},
 * and the write side of the same trust boundary.
 *
 * A `json` value is validated against the entry's own schema and re-serialized **from the parsed
 * data**, never from the object handed in: Zod strips what the schema does not declare, so a stray
 * extra property is not sealed in to come back out at a read that trusts the envelope. A `text` value
 * must actually be a string — the types say so, but the one caller this exists for is application code
 * holding a freshly minted credential, and `String(value)` on the wrong thing seals `[object Object]`
 * under a name that will be read as a key.
 *
 * The refusal carries issue paths and codes only, like the read: a Zod issue can echo the value.
 */
export function serializeValue(entry: ValueShape, name: string, value: unknown): string {
  if (entry.valueType === "text") {
    if (typeof value !== "string") {
      throw new SecretInvalidValueError({
        message: `Secret '${name}' takes a string value.`,
        detail: `text secret '${name}' was handed a ${typeof value}`,
      });
    }
    return value;
  }
  const result = entry.schema.safeParse(value);
  if (!result.success) {
    const summary = result.error.issues.map((i) => `${i.path.join(".") || "<root>"}:${i.code}`).join(", ");
    throw new SecretInvalidValueError({
      message: `Secret '${name}' failed validation.`,
      detail: `json secret '${name}' failed registry validation on write: ${summary}`,
    });
  }
  return JSON.stringify(result.data);
}
