// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * A window bound, as ISO-8601, decoded to a `Date` by the schema rather than by the handler — the handler
 * takes typed values, so no handler parses a caller's string.
 */
const WindowBound = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));

/**
 * The widget read's window (#731). Both bounds are optional: the default is the last 30 days, ending now. A
 * window Cloudflare does not keep is refused by the handler, which is where the dataset's retention is known.
 */
export const WidgetsQuery = z
  .object({
    since: WindowBound.optional().describe(
      "The window's start, inclusive, ISO-8601. Defaults to 30 days before `until`.",
    ),
    until: WindowBound.optional().describe("The window's end, exclusive, ISO-8601. Defaults to now."),
  })
  .describe("Query parameters for the turnstile widget read.");
export type WidgetsQuery = z.output<typeof WidgetsQuery>;
