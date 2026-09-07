// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { composedBindings, composedCapabilities, composedResult } from "./composed";

const CONFIG = `
import { auth } from "@pithy-sh/auth";
// a comment naming "@pithy-sh/never-composed"
import { secrets } from "@pithy-sh/secrets";
export default { capabilities: [auth(), secrets()] };
`;

const WRANGLER = `{
  // the dev stanza is the top level
  "version_metadata": { "binding": "CF_VERSION_METADATA" },
  "d1_databases": [{ "binding": "DB", "database_name": "x" }],
  "kv_namespaces": [{ "binding": "SESSIONS", "id": "y" }],
  "env": {
    "staging": { "d1_databases": [{ "binding": "DB" }] },
    "prod": { "d1_databases": [{ "binding": "DB" }], "kv_namespaces": [{ "binding": "SESSIONS" }] }
  }
}`;

describe("composedCapabilities", () => {
  it("finds every kit package the config imports", () => {
    expect(composedCapabilities(CONFIG)).toEqual(["@pithy-sh/auth", "@pithy-sh/secrets"]);
  });

  // A capability named in prose is not composed. The comment stripper is what makes the difference,
  // and without it a doc comment mentioning a package would read as a registration.
  it("does not count one named only in a comment", () => {
    expect(composedCapabilities(CONFIG)).not.toContain("@pithy-sh/never-composed");
  });

  it("is order-independent, which is the whole point", () => {
    const reordered = CONFIG.split("\n").reverse().join("\n");
    expect(composedCapabilities(reordered)).toEqual(composedCapabilities(CONFIG));
  });
});

describe("composedBindings", () => {
  it("names each binding with the environment it lands in", () => {
    expect(composedBindings(WRANGLER)).toEqual([
      "dev:CF_VERSION_METADATA",
      "dev:DB",
      "dev:SESSIONS",
      "prod:DB",
      "prod:SESSIONS",
      "staging:DB",
    ]);
  });

  // The reason the prefix exists. Both configs declare `DB` and `SESSIONS`; only one puts `SESSIONS`
  // in staging, and an unprefixed set of names cannot tell them apart.
  it("tells apart two configs that declare the same names in different environments", () => {
    const moved = WRANGLER.replace(
      '"staging": { "d1_databases": [{ "binding": "DB" }] }',
      '"staging": { "d1_databases": [{ "binding": "DB" }], "kv_namespaces": [{ "binding": "SESSIONS" }] }',
    );
    expect(composedBindings(moved)).not.toEqual(composedBindings(WRANGLER));
  });

  it("reads a jsonc with comments, which is what the CLI writes", () => {
    expect(composedBindings(`{\n  // note\n  "d1_databases": [{ "binding": "DB" }]\n}`)).toEqual(["dev:DB"]);
  });
});

describe("composedResult", () => {
  it("carries both halves", () => {
    const result = composedResult(CONFIG, WRANGLER);
    expect(result).toContain("@pithy-sh/auth");
    expect(result).toContain("dev:DB");
  });

  /**
   * **The empty answer is reachable, which is what makes a caller's non-empty floor a real check.**
   *
   * `pithy-sh/dashboard` ran this comparison with an argv slip that made both extractions empty; the
   * two empty lists compared equal and the suite reported that the property held. A probe that silently
   * reads nothing is a permanently green gate. Asserting the empty case here is what says the floor in
   * `cleanRoom.ts` is guarding against something that can actually happen.
   */
  it("answers empty for input that composes nothing, so a floor above it is not decorative", () => {
    expect(composedResult("", "{}")).toEqual([]);
    expect(composedResult("export default {};", "{}")).toEqual([]);
  });
});
