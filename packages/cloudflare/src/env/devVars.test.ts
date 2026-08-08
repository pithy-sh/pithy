// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { parseDevVars } from "./devVars";

describe("parseDevVars", () => {
  test("parses KEY=value lines, skipping comments and blanks", () => {
    const content = [
      "# a comment",
      "",
      "CLOUDFLARE_ACCOUNT_ID=acct-1",
      "  CLOUDFLARE_API_TOKEN = tok-2 ",
      "BAD LINE",
    ].join("\n");
    expect(parseDevVars(content)).toEqual({ CLOUDFLARE_ACCOUNT_ID: "acct-1", CLOUDFLARE_API_TOKEN: "tok-2" });
  });

  test("strips one layer of surrounding quotes and keeps `=` inside values", () => {
    expect(parseDevVars(`SECRETS_STORE_ID="store=abc"`)).toEqual({ SECRETS_STORE_ID: "store=abc" });
  });
});
