// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { CLOUDFLARE_ENV_KEYS, parseDevVars, visibleCredentialKeys } from "./devVars";

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

/**
 * The predicate the repository-root `vitest.workers.setup.ts` throws on, unit-tested here because it
 * cannot be asserted where it runs.
 *
 * That guard sits above every `node_modules/` holding vitest, so it can import no bare specifier and has
 * no `expect` to reach for — it throws instead. A throw is not an assertion, and #437 is not going to
 * trade one uncovered claim for another. So the whole of the decision lives in this pure function, where
 * it is a normal test, and the guard is the one line that calls it.
 */
describe("visibleCredentialKeys", () => {
  test("reports a credential and ignores the keys beside it", () => {
    expect(visibleCredentialKeys({ CLOUDFLARE_API_TOKEN: "leaked", DB: "x" })).toEqual(["CLOUDFLARE_API_TOKEN"]);
  });

  test("a declared test value is not a credential", () => {
    // #437's third acceptance criterion in unit form. Five workers configs declare
    // `SECRETS_ENCRYPTION_KEYS: devEncryptionKeys()` — a key computed for the test, from no environment.
    // The rule is about a Cloudflare credential reaching workerd, never about a value a config chose.
    expect(visibleCredentialKeys({ SECRETS_ENCRYPTION_KEYS: "dev-key" })).toEqual([]);
  });

  test("blank is unset, exactly as the overlay already reads it", () => {
    // `NO_ACCOUNT` in `vitest.shared.ts` pins all four keys to `""`, and the `process.env` overlay in
    // the CLI's `cloudflare/config` treats a blank as absent. Presence is the wrong question here.
    expect(visibleCredentialKeys({ CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_TOKEN: undefined })).toEqual([]);
  });

  test("every key in the list, derived rather than written out", () => {
    // So a fifth credential is covered by the commit that declares it, which is the same reason
    // `NO_ACCOUNT` derives its blanks from this constant rather than restating today's four names.
    const all = Object.fromEntries(CLOUDFLARE_ENV_KEYS.map((key) => [key, "set"]));
    expect(visibleCredentialKeys(all)).toEqual([...CLOUDFLARE_ENV_KEYS]);
  });
});
