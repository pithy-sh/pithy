// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PublicErrorPayload } from "@pithy-sh/core/src/error/payload";
import { z } from "zod";

/**
 * **The `--json` error line, as a schema (#697).** One line on stderr, the same for every command:
 * `{ "error": … }`, written by `formatErrorJson` in `output.ts`.
 *
 * Core's public payload — the union of every kit code's wire shape, plus the open member an adopter's
 * code parses as — with the four fields the CLI adds beside it for its operator: `action`, the remedy in
 * words; `exit` and `retryable`, read off `exitClass.ts`; and `fix`, the command that rights a failure
 * whose cause the throw site knew. `pithy schema` publishes its JSON Schema once, and every command
 * points at it, because it is about 160 KB and identical for all of them. `errorLine.test.ts` parses
 * what `formatErrorJson` really writes against it.
 */
export const OperatorFields = z
  .object({
    action: z.string().optional().describe("The remedy, in words, for whoever runs the command."),
    exit: z.number().int().describe("The code the process exits with: 2 to 5 by kind, 1 when unclassified."),
    retryable: z.boolean().describe("Whether running the same command again, unchanged, can succeed."),
    fix: z
      .string()
      .optional()
      .describe("A pithy command that rights this failure, when the cause is known. Never on exit 5."),
  })
  .describe("What the CLI adds to the public payload for the operator.");
export type OperatorFields = z.infer<typeof OperatorFields>;

export const ErrorLine = z
  .object({
    error: z
      .intersection(PublicErrorPayload, OperatorFields)
      .describe("The failure: its code, status, message and params, plus what to do about it."),
  })
  .describe("The one line a failed --json run writes to stderr.");
export type ErrorLine = z.infer<typeof ErrorLine>;
