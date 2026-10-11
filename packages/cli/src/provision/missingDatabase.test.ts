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
  test("is a precondition whose fix is pithy secrets provision", () => {
    const error = secretsDatabaseMissing(
      "staging",
      "acme-staging-secrets",
      "the media worker reads its credentials from it.",
    );

    expect(error.payload.code).toBe("core/precondition_failed");
    expect(exitCodeOf(error.payload)).toBe(3);
    expect(error.payload.message).toBe("The staging secrets database (acme-staging-secrets) does not exist.");
    expect(error.payload.action).toBe(
      "Run `pithy secrets provision` first — the media worker reads its credentials from it.",
    );
    expect(fixOf(error)).toBe("pithy secrets provision");
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

  /** With several Workers a bare `pithy email provision` is refused, so with no Worker to name there is no `fix` (#697). */
  test("with no Worker known, the action says what to run and there is no fix", () => {
    const error = suppressionDatabaseMissing("acme-global-email-suppression", "why.");
    expect(error.payload.action).toBe("Run `pithy email provision` first — why.");
    expect(fixOf(error)).toBeUndefined();
  });
});
