// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

// Its own module, importing nothing but zod, so a browser and a socket's frame schemas can name the error
// shape without reaching the HTTP codec or Hono. The OpenAPI and AsyncAPI documents both describe it here.

/**
 * The wire body of every error a route returns, whatever its status: `pithyErrorHandler` renders
 * `{ error: clientError(payload) }`, and a socket's error frame carries the same `error` object. The payload's own schema is a union over every kit code, which
 * would put several hundred variants into each operation, so the contract describes the envelope and
 * names the code list's home instead.
 */
export const ErrorBody = z
  .object({
    error: z
      .object({
        code: z
          .string()
          .describe(
            "Namespaced `domain/reason`, e.g. `auth/invalid_token`. Stable: a client switches on it. The full list is `pithy schema --json`'s `errorCodes`.",
          ),
        status: z.number().int().describe("The HTTP status, repeated in the body."),
        message: z
          .string()
          .describe("English, for a person. A client that translates renders its own wording for `code` instead."),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Values a translating client interpolates into its own wording for `code`."),
        issues: z
          .array(z.unknown())
          .optional()
          .describe("For `validation/invalid_input`: one entry per field that failed, with its path."),
      })
      .describe("The public error payload. Never carries the operator's remedy or internal detail."),
  })
  .describe("The body of every error response.");
export type ErrorBody = z.infer<typeof ErrorBody>;
