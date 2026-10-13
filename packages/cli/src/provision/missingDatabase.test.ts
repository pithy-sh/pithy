// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { exitCodeOf, fixOf } from "../terminal/exitClass";
import { secretsDatabaseMissing, suppressionDatabaseMissing } from "./missingDatabase";

/**
 * **A database another command creates, found missing (#697).**
 *
 * `payments`, `email`, `media` and `storage` provision against the environment's secrets database, and
 * `testers` against the project's email-suppression database. Each refuses when the account was asked
 * and the database is not there, so the cause is classified: the call is right, the account is not ready,
 * and one command readies it. That command rides as `fix`, for an agent to run as written.
 */
describe("secretsDatabaseMissing", () => {
  // The provision that creates it runs against every environment, production included: a person's decision, never
  // the fix for one environment's database (#711).
  test("is a precondition whose remedy is the secrets provision, said as a person's decision, with no fix", () => {
    const error = secretsDatabaseMissing(
      "staging",
      "acme-staging-secrets",
      "the media worker reads its credentials from it.",
    );

    expect(error.payload.code).toBe("core/precondition_failed");
    expect(exitCodeOf(error.payload)).toBe(3);
    expect(error.payload.message).toBe("The staging secrets database (acme-staging-secrets) does not exist.");
    expect(error.payload.action).toBe(
      "`pithy secrets provision` runs against every environment, production included. That is a person's decision, not a fix. It creates this database — the media worker reads its credentials from it.",
    );
    expect(fixOf(error)).toBeUndefined();
  });
});

describe("suppressionDatabaseMissing", () => {
  test("is a precondition whose fix is pithy email provision, naming the Worker the caller resolved", () => {
    const error = suppressionDatabaseMissing(
      "acme-global-email-suppression",
      "the daily pass reads it to reconcile bounced addresses.",
      "/repo/apps/api",
    );

    expect(error.payload.code).toBe("core/precondition_failed");
    expect(exitCodeOf(error.payload)).toBe(3);
    expect(error.payload.message).toBe(
      "This project's email-suppression database (acme-global-email-suppression) does not exist.",
    );
    expect(error.payload.action).toBe(
      "Run `pithy email provision --worker api` first — the daily pass reads it to reconcile bounced addresses.",
    );
    expect(fixOf(error)).toBe("pithy email provision --worker api");
  });
});
