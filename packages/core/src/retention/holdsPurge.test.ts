// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { isRetained } from "../capability/purge";
import { controlplane } from "../controlPlane/capability";
import { HOLDS_RETENTION_BASIS, holdsUserPurge } from "./holdsPurge";

describe("holdsUserPurge", () => {
  test("retains the holds placed on a user, with its basis, and exports them", () => {
    const contribution = holdsUserPurge();
    expect(contribution.subject).toBe("user");
    expect(isRetained(contribution)).toBe(true);
    expect(contribution.retain.basis).toBe(HOLDS_RETENTION_BASIS);
    expect(typeof contribution.export).toBe("function");
  });

  test("is the control plane's one user contribution", () => {
    expect(controlplane().purge?.map((each) => each.subject)).toEqual(["user"]);
  });
});
