// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test, vi } from "vitest";
import { memoizeActing, noActingOrganization } from "./acting";

describe("the acting-organization seam", () => {
  test("with no organization capability composed, nothing is in force", async () => {
    expect(await noActingOrganization()).toBeNull();
  });

  test("a resolver is asked once per request, however many readers ask", async () => {
    const resolve = vi.fn(async () => ({ organizationId: "org-a", roleAllows: () => false }));
    const acting = memoizeActing(resolve);

    const [first, second] = await Promise.all([acting(), acting()]);
    await acting();

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(first?.organizationId).toBe("org-a");
    expect(second).toBe(first);
  });

  test("a resolver that refuses refuses every reader, and is not retried into an answer", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("unknown role");
    });
    const acting = memoizeActing(resolve);

    await expect(acting()).rejects.toThrow("unknown role");
    await expect(acting()).rejects.toThrow("unknown role");
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
