// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { carryActingOnRotation } from "./rotation";

const ROTATION = { previousSessionId: "s-old", sessionId: "s-new", userId: "u-1" };

describe("carryActingOnRotation", () => {
  test("refuses an env without the database bound, and names the binding to add", async () => {
    for (const env of [{}, { ORG_DB: null }, { ORG_DB: "not a binding" }]) {
      const carry = carryActingOnRotation("ORG_DB");
      const failure = await carry({ ...ROTATION, env }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure, JSON.stringify(env)).toBeInstanceOf(InternalError);
      const payload = (failure as InternalError).payload;
      expect(payload.action).toBe("Bind the ORG_DB D1 database to this Worker.");
      expect(payload.detail).toBe("session rotation found no ORG_DB binding on the env");
    }
  });
});
