// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { listOAuthScopes, OAUTH_SCOPES_URL } from "./catalog";

describe("listOAuthScopes", () => {
  test("reads the catalog with the token as a bearer", async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const scopes = await listOAuthScopes({
      apiToken: "tok",
      fetch: async (url, init) => {
        seen.push({ url, auth: init.headers.authorization });
        return new Response(
          JSON.stringify({
            success: true,
            result: [{ id: "d1.write", name: "D1 Write", category: "developer_platform" }],
          }),
        );
      },
    });
    expect(scopes).toEqual([{ id: "d1.write", name: "D1 Write", category: "developer_platform" }]);
    expect(seen).toEqual([{ url: OAUTH_SCOPES_URL, auth: "Bearer tok" }]);
  });

  test("an answer that is not a catalog is refused, never half-read", async () => {
    await expect(
      listOAuthScopes({ apiToken: "tok", fetch: async () => new Response(JSON.stringify({ success: false })) }),
    ).rejects.toThrow(PithyError);
  });
});
