// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";

/**
 * A field a person types freely: a search term, a reason, a note. Nobody can know in advance that the
 * value is not somebody's address, so it never travels in a URL, which is written to every request log
 * between the client and the Worker. `addressedParameters` (`@pithy-sh/core/src/openapi/document`) fails on
 * a query or path parameter carrying this marker; in a body it documents what the field is.
 */

/** The `meta` key the marker writes, and the JSON Schema keyword `toJSONSchema` carries it as. */
export const FREE_TEXT_META_KEY = "freeText";

/** Mark a field as free text. It parses exactly as before: only its JSON Schema gains `freeText: true`. */
export function freeText<T extends z.ZodType>(schema: T): T {
  return schema.meta({ [FREE_TEXT_META_KEY]: true });
}

/**
 * Declare that a field whose name reads as free text is not: its value is machine-made, such as a signed query
 * string a server redirected with, and no person types it. It exempts the field from the name rule alone; an
 * address shape or a privacy class on it still fails the gate.
 */
export function notFreeText<T extends z.ZodType>(schema: T): T {
  return schema.meta({ [FREE_TEXT_META_KEY]: false });
}
