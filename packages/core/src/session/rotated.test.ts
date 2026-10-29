// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { Capability } from "../capability/capability";
import { announceSessionRotated, type SessionRotation } from "./rotated";

const ROTATION: SessionRotation = { previousSessionId: "s-old", sessionId: "s-new", userId: "u-1", env: {} };

function capability(name: string, sessionRotated?: Capability["sessionRotated"]): Capability {
  return { name, ...(sessionRotated ? { sessionRotated } : {}) } as Capability;
}

describe("announceSessionRotated", () => {
  test("tells every composed listener, in composition order, and skips a capability with none", async () => {
    const heard: string[] = [];
    const failures = await announceSessionRotated(
      [
        capability("organization", async (rotation) => {
          heard.push(`organization:${rotation.previousSessionId}->${rotation.sessionId}`);
        }),
        capability("media"),
        capability("app", async (rotation) => {
          heard.push(`app:${rotation.userId}`);
        }),
      ],
      ROTATION,
    );
    expect(heard).toEqual(["organization:s-old->s-new", "app:u-1"]);
    expect(failures).toEqual([]);
  });

  test("a listener that throws does not stop the others, and is answered by name", async () => {
    const heard: string[] = [];
    const failures = await announceSessionRotated(
      [
        capability("organization", async () => {
          throw new Error("d1 unavailable");
        }),
        capability("app", async () => {
          heard.push("app");
        }),
      ],
      ROTATION,
    );
    expect(heard).toEqual(["app"]);
    expect(failures.map((failure) => failure.capability)).toEqual(["organization"]);
    expect(failures[0]?.error).toBeInstanceOf(Error);
  });

  test("nothing composed, nothing told", async () => {
    expect(await announceSessionRotated([], ROTATION)).toEqual([]);
  });
});
