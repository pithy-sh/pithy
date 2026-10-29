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
 * The widget read's window. Both bounds are optional: the default is the last 30 days, ending now. A
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

/**
 * The widget page's query. Both values land on the page as attributes, so each is held to a closed shape
 * here rather than escaped and hoped for.
 */
export const WidgetPageQuery = z
  .object({
    theme: z
      .enum(["auto", "light", "dark"])
      .default("auto")
      .describe("The widget's color scheme. `auto` follows the device. Defaults to `auto`."),
    language: z
      .string()
      .regex(/^(auto|[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?)$/)
      .default("auto")
      .describe(
        "The widget's language, as a language tag like `es` or `pt-br`. `auto` follows the device. Defaults to `auto`.",
      ),
  })
  .describe("Query parameters for the turnstile widget page.");
export type WidgetPageQuery = z.output<typeof WidgetPageQuery>;
