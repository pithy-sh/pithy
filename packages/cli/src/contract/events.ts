// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { FlagGroup } from "./commandContract";

/**
 * **`--events`: a long `--json` run, said as it goes (#697).** `deploy` and `provision` take it. Under it the one
 * document becomes a stream — a record per step, then the document as the last line — framed as `pithy dev`'s.
 * The flag, its rule and its record schema are declared here once, so the two commands say the same thing.
 */

/** `--events`, declared once. */
export const EVENTS_ARG = {
  type: "boolean",
  default: false,
  description: "With --json, stream a progress record per step before the result",
} as const;

/** The rule `bin.ts` enforces (`refuseEventsFlag`), published as a flag group. */
export const EVENTS_NEED_JSON: FlagGroup = {
  kind: "requires",
  flag: "--events",
  needs: ["--json"],
  any: false,
  rule: "--events needs --json.",
};

/**
 * What `withErrorReporting` is handed: the command's name to stream under, or nothing when it was not asked.
 *
 * **Read off the parse, both flags of it.** `bin.ts` refuses `--events` without `--json`, but the parse is what
 * the run obeys: `--json --no-json --events` parses to `json: false`, and a stream installed then would write
 * records into the prose a person reads.
 */
export function eventsOption(command: string, args: { json: boolean; events: boolean }): { events?: string } {
  return args.json && args.events ? { events: command } : {};
}

/**
 * **One `--events` progress record, as a command publishes it.**
 *
 * `terminal/progress.ts`'s `progressRecord` writes two shapes — a step starting and a step settling — and
 * each producer may add the structured row behind its step. This is the schema of that, for one command:
 * the two shapes, `command` fixed to its name, and the extras its producers add, every one optional because
 * a step raised by a shared producer (a migration, a seed set) carries none. The framing is spread last, as
 * the record writes it, so an extra named like it cannot replace it here either. `pithy schema` publishes it, at
 * the command's `schemaVersion`, as the command's `events`.
 */
export function eventsRecord(
  command: string,
  extras: { start?: z.ZodRawShape; settled?: z.ZodRawShape } = {},
): z.ZodType {
  const name = z.literal(command).describe(`\`"${command}"\`, as on the document that closes the stream.`);
  const optional = (shape: z.ZodRawShape = {}) =>
    Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, (value as z.ZodType).optional()]));
  return z
    .union([
      z
        .object({
          ...optional(extras.start),
          command: name,
          event: z.literal("start").describe("`start`: a unit of work is beginning."),
          what: z.string().describe("What is being worked on: a Worker, a resource, a migration."),
        })
        .describe("A unit of work starting."),
      z
        .object({
          ...optional(extras.settled),
          command: name,
          event: z.literal("settled").describe("`settled`: that unit is done, failed or skipped."),
          line: z.string().describe("The line a person would have read for it, without color."),
        })
        .describe("A unit of work settling."),
    ])
    .describe(
      `One \`pithy ${command} --json --events\` progress record. The last line of the stream is the document instead.`,
    );
}
