// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import {
  InputRequiredError,
  PersonRequiredError,
  PreconditionFailedError,
  UpstreamError,
  ValidationError,
} from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { ErrorLine } from "./errorLine";
import { formatErrorJson } from "./output";

/**
 * **The error line `pithy schema` publishes is the one `formatErrorJson` writes (#697).** Parsed from the
 * real bytes, one of each kind, so a field the formatter adds and the schema forgets fails here — and a
 * field the schema demands that the formatter stopped writing fails too.
 */
describe("ErrorLine", () => {
  const cases = [
    ["a usage refusal", new ValidationError({ message: "Pass --env.", action: "Add --env staging." })],
    [
      "a question nobody may answer",
      new InputRequiredError({ message: "Which worker?", flag: "--worker", choices: ["api"] }),
    ],
    ["a precondition", new PreconditionFailedError({ message: "Nothing is provisioned." })],
    ["an upstream failure", new UpstreamError({ message: "Cloudflare said no." })],
    ["a person's step", new PersonRequiredError({ message: "Type the phrase." })],
  ] as const;

  test.each(cases)("parses %s as formatErrorJson writes it", (_, error) => {
    const line: unknown = JSON.parse(formatErrorJson(error.payload, "pithy provision --env staging --yes"));
    expect(ErrorLine.parse(line)).toEqual(line);
  });

  test("demands what the CLI always adds", () => {
    const line = JSON.parse(formatErrorJson(new ValidationError({ message: "No." }).payload)) as {
      error: Record<string, unknown>;
    };
    delete line.error.exit;
    expect(ErrorLine.safeParse(line).success).toBe(false);
  });

  test("an adopter's own code parses too, as the open member", () => {
    const line = {
      error: { code: "billing/card_declined", status: 402, message: "Declined.", exit: 1, retryable: false },
    };
    expect(ErrorLine.safeParse(line).success).toBe(true);
  });
});
