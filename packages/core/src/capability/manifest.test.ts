// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  CapabilityManifest,
  CONFIG_LINE_WIDTH,
  CONFIG_OPTION_INDENT,
  renderConfigOptionLine,
  renderConfigValue,
} from "./manifest";

/**
 * The string `"${x}"`, escaped into a template literal rather than written as one.
 *
 * Written plainly it trips `lint/suspicious/noTemplateCurlyInString` here — which is the whole reason
 * the schema refuses it in a manifest default, so the test proving that should not emit it either.
 */
const TEMPLATE_LIKE = `\${x}`;

describe("CapabilityManifest", () => {
  test("parses a full auth manifest", () => {
    const parsed = CapabilityManifest.parse({
      name: "auth",
      package: "@pithy-sh/auth",
      requiredBindings: [
        { type: "d1", name: "DB" },
        { type: "kv", name: "SESSIONS" },
      ],
      peerCapabilities: ["email"],
      optionalCapabilities: ["turnstile"],
      migrationNamespace: "auth",
      scaffold: ["register auth() in pithy.config.ts"],
      whenToEnable: "Enable when your app needs user accounts.",
    });
    expect(parsed.name).toBe("auth");
    expect(parsed.package).toBe("@pithy-sh/auth");
    expect(parsed.peerCapabilities).toEqual(["email"]);
    expect(parsed.optionalCapabilities).toEqual(["turnstile"]);
    expect(parsed.migrationNamespace).toBe("auth");
    expect(parsed.scaffold).toEqual(["register auth() in pithy.config.ts"]);
    expect(parsed.whenToEnable).toBe("Enable when your app needs user accounts.");
  });

  test("normalizes requiredBindings through BindingSpec (optional defaults to false)", () => {
    const parsed = CapabilityManifest.parse({
      name: "auth",
      package: "@pithy-sh/auth",
      requiredBindings: [{ type: "d1", name: "DB" }],
    });
    expect(parsed.requiredBindings).toEqual([{ type: "d1", name: "DB", optional: false }]);
  });

  test("applies empty-array defaults for the optional lists", () => {
    const parsed = CapabilityManifest.parse({
      name: "turnstile",
      package: "@pithy-sh/turnstile",
      requiredBindings: [{ type: "secret", name: "TURNSTILE_SECRET" }],
    });
    expect(parsed.peerCapabilities).toEqual([]);
    expect(parsed.optionalCapabilities).toEqual([]);
    expect(parsed.scaffold).toEqual([]);
  });

  test("leaves migrationNamespace and whenToEnable undefined when omitted", () => {
    const parsed = CapabilityManifest.parse({
      name: "turnstile",
      package: "@pithy-sh/turnstile",
      requiredBindings: [],
    });
    expect(parsed.migrationNamespace).toBeUndefined();
    expect(parsed.whenToEnable).toBeUndefined();
  });

  test("rejects a manifest with no package", () => {
    expect(() => CapabilityManifest.parse({ name: "x", requiredBindings: [] })).toThrow();
  });

  test("rejects an empty name", () => {
    expect(() => CapabilityManifest.parse({ name: "", package: "@pithy-sh/x", requiredBindings: [] })).toThrow();
  });

  test("rejects an empty package", () => {
    expect(() => CapabilityManifest.parse({ name: "x", package: "", requiredBindings: [] })).toThrow();
  });

  test("accepts a registry-valid migrationNamespace", () => {
    const parsed = CapabilityManifest.parse({
      name: "auth",
      package: "@pithy-sh/auth",
      requiredBindings: [],
      migrationNamespace: "auth",
    });
    expect(parsed.migrationNamespace).toBe("auth");
  });

  test("rejects a migrationNamespace the migration registry would reject", () => {
    for (const ns of ["Auth", "auth_core", "1auth", "auth-core", ""]) {
      expect(() =>
        CapabilityManifest.parse({
          name: "x",
          package: "@pithy-sh/x",
          requiredBindings: [],
          migrationNamespace: ns,
        }),
      ).toThrow();
    }
  });

  test("rejects an invalid binding in requiredBindings", () => {
    expect(() =>
      CapabilityManifest.parse({
        name: "x",
        package: "@pithy-sh/x",
        requiredBindings: [{ type: "banana", name: "Q" }],
      }),
    ).toThrow();
  });

  test("defaults configOptions to an empty array when omitted", () => {
    const parsed = CapabilityManifest.parse({
      name: "auth",
      package: "@pithy-sh/auth",
      requiredBindings: [],
    });
    expect(parsed.configOptions).toEqual([]);
  });

  test("parses configOptions with string, number, and boolean defaults", () => {
    const parsed = CapabilityManifest.parse({
      name: "auth",
      package: "@pithy-sh/auth",
      requiredBindings: [],
      configOptions: [
        { key: "basePath", default: "/auth", describe: "Where the auth routes mount." },
        { key: "sessionDays", default: 30, describe: "Refresh-token lifetime in days." },
        { key: "cookies", default: true, describe: "Enable cookie sessions." },
      ],
    });
    expect(parsed.configOptions).toEqual([
      { key: "basePath", default: "/auth", describe: "Where the auth routes mount." },
      { key: "sessionDays", default: 30, describe: "Refresh-token lifetime in days." },
      { key: "cookies", default: true, describe: "Enable cookie sessions." },
    ]);
  });

  test("parses an object or array default — the option an adopter fills in by hand", () => {
    // `SecretsConfig.registry` is required and only the adopter can write its contents. While a default
    // could only be a scalar, the manifest could not state the option at all, so `pithy add secrets`
    // rendered a registration missing a required key and the scaffolded project failed `tsc` (#161).
    const parsed = CapabilityManifest.parse({
      name: "secrets",
      package: "@pithy-sh/secrets",
      requiredBindings: [],
      configOptions: [
        { key: "registry", default: {}, describe: "Your secrets. Declare each one here." },
        { key: "boards", default: [], describe: "Every board this app ranks." },
      ],
    });
    expect(parsed.configOptions.map((option) => option.default)).toEqual([{}, []]);
  });

  test("parses a nested default — the worked example an adopter replaces", () => {
    // #161 admitted the empty literal, which is right for a registry: an empty registry is legal. It is
    // wrong for `ledger.currencies`, `leaderboard.boards` and `multiplayer.games`, which each carry a
    // `.min(1)` refusal — an empty seed typechecks and then throws `too_small` on the first config load,
    // reported as "Could not load pithy.config.ts" (#168). So a default nests as deep as an example needs.
    const parsed = CapabilityManifest.parse({
      name: "multiplayer",
      package: "@pithy-sh/multiplayer",
      requiredBindings: [],
      configOptions: [
        {
          key: "games",
          default: [{ key: "tic-tac-toe", kind: "connect-n", rules: { rows: 3, cols: 3, connect: 3 } }],
          describe: "Every game this app runs.",
        },
      ],
    });
    expect(parsed.configOptions[0]?.default).toEqual([
      { key: "tic-tac-toe", kind: "connect-n", rules: { rows: 3, cols: 3, connect: 3 } },
    ]);
  });

  test("rejects a null buried inside a default, not just one at the top", () => {
    // The recursion is what makes this reachable at all. Before it, contents were `unknown` and a null
    // three levels down parsed fine, then rendered as `null` into someone's config file.
    expect(() =>
      CapabilityManifest.parse({
        name: "multiplayer",
        package: "@pithy-sh/multiplayer",
        requiredBindings: [],
        configOptions: [{ key: "games", default: [{ rules: { rows: null } }], describe: "Every game." }],
      }),
    ).toThrow();
  });

  test("rejects a configOption with a default no config file could carry", () => {
    // The union is JSON, so `null` and an undefined-valued key are both out: `add` renders the default
    // verbatim, and a capability that means "unset" says so by leaving the option off the manifest.
    expect(() =>
      CapabilityManifest.parse({
        name: "auth",
        package: "@pithy-sh/auth",
        requiredBindings: [],
        configOptions: [{ key: "basePath", default: null, describe: "Mount path." }],
      }),
    ).toThrow();
  });

  test("rejects a default carrying a character the renderer cannot print as Biome would", () => {
    // The type narrowed rather than the renderer growing a copy of Biome's quote heuristic. A `"` inside
    // the value makes Biome reprint the whole literal in single quotes; `${` trips
    // noTemplateCurlyInString. Both land in a file the adopter never opened, which is the #161/#168
    // defect. A manifest default is a worked example, and an example needing either is too clever.
    for (const bad of ['he said "hi"', TEMPLATE_LIKE, 'a "b" c']) {
      expect(() =>
        CapabilityManifest.parse({
          name: "auth",
          package: "@pithy-sh/auth",
          requiredBindings: [],
          configOptions: [{ key: "basePath", default: bad, describe: "Mount path." }],
        }),
      ).toThrow();
    }
  });

  test("rejects a default carrying an unprintable string however deep it is buried", () => {
    expect(() =>
      CapabilityManifest.parse({
        name: "multiplayer",
        package: "@pithy-sh/multiplayer",
        requiredBindings: [],
        configOptions: [{ key: "games", default: [{ rules: { label: 'say "go"' } }], describe: "Every game." }],
      }),
    ).toThrow();
  });

  test("rejects an object key the renderer cannot print as Biome would", () => {
    // A key that cannot be written bare is quoted, so it carries the same hazard as a value.
    expect(() =>
      CapabilityManifest.parse({
        name: "auth",
        package: "@pithy-sh/auth",
        requiredBindings: [],
        configOptions: [{ key: "headers", default: { 'a"b': "x" }, describe: "Extra headers." }],
      }),
    ).toThrow();
  });

  test("rejects a number no plain decimal spells", () => {
    // `String(1e21)` is "1e+21"; Biome prints `1e21`. Checked against Biome, not inferred.
    expect(() =>
      CapabilityManifest.parse({
        name: "auth",
        package: "@pithy-sh/auth",
        requiredBindings: [],
        configOptions: [{ key: "sessionDays", default: 1e21, describe: "Refresh-token lifetime in days." }],
      }),
    ).toThrow();
  });

  test("keeps the strings Biome leaves alone — an apostrophe, a backslash, an accent", () => {
    // The narrowing is only as wide as the mismatch. With no `"` to escape, Biome keeps double quotes,
    // and it reprints none of these.
    const parsed = CapabilityManifest.parse({
      name: "auth",
      package: "@pithy-sh/auth",
      requiredBindings: [],
      configOptions: [
        { key: "greeting", default: "it's fine", describe: "A greeting." },
        { key: "path", default: "a\\b", describe: "A path." },
        { key: "city", default: "café", describe: "A city." },
      ],
    });
    expect(parsed.configOptions.map((option) => option.default)).toEqual(["it's fine", "a\\b", "café"]);
  });

  test("rejects a configOption with an empty key", () => {
    expect(() =>
      CapabilityManifest.parse({
        name: "auth",
        package: "@pithy-sh/auth",
        requiredBindings: [],
        configOptions: [{ key: "", default: "/auth", describe: "Mount path." }],
      }),
    ).toThrow();
  });

  test("defaults devSecrets to an empty array — a capability mints nothing until it says so", () => {
    const parsed = CapabilityManifest.parse({ name: "payments", package: "@pithy-sh/payments", requiredBindings: [] });
    expect(parsed.devSecrets).toEqual([]);
  });

  test("parses a declared dev secret", () => {
    const parsed = CapabilityManifest.parse({
      name: "auth",
      package: "@pithy-sh/auth",
      requiredBindings: [],
      devSecrets: [{ name: "auth-session-secret", devValue: "random" }],
    });
    expect(parsed.devSecrets).toEqual([{ name: "auth-session-secret", devValue: "random" }]);
  });

  test("rejects a devValue the CLI has no way to mint", () => {
    expect(() =>
      CapabilityManifest.parse({
        name: "auth",
        package: "@pithy-sh/auth",
        requiredBindings: [],
        devSecrets: [{ name: "auth-session-secret", devValue: "keypair" }],
      }),
    ).toThrow();
  });

  test("rejects a dev secret with no name — there would be nothing to write it under", () => {
    expect(() =>
      CapabilityManifest.parse({
        name: "auth",
        package: "@pithy-sh/auth",
        requiredBindings: [],
        devSecrets: [{ name: "", devValue: "random" }],
      }),
    ).toThrow();
  });

  test("rejects a configOption with no describe", () => {
    expect(() =>
      CapabilityManifest.parse({
        name: "auth",
        package: "@pithy-sh/auth",
        requiredBindings: [],
        configOptions: [{ key: "basePath", default: "/auth" }],
      }),
    ).toThrow();
  });
});

/**
 * The renderer is the other half of the widening. A default that parses but prints as something Biome
 * would have printed differently fails the scaffold's own `lint` gate on a project the adopter has not
 * touched — the exact class of defect #161 and #168 are about, moved one gate along.
 */
describe("renderConfigValue", () => {
  test("prints scalars as a config file carries them", () => {
    expect(renderConfigValue("live")).toBe('"live"');
    expect(renderConfigValue(30)).toBe("30");
    expect(renderConfigValue(true)).toBe("true");
  });

  test("keeps the empty literals #161 relies on", () => {
    expect(renderConfigValue({})).toBe("{}");
    expect(renderConfigValue([])).toBe("[]");
  });

  test("prints object keys bare, because Biome's formatter would", () => {
    // `JSON.stringify` writes `{"code":"chips"}`; Biome rewrites that to `{ code: "chips" }` and exits
    // non-zero on the difference. The generated file has to already be in the shape Biome prints.
    expect(renderConfigValue([{ code: "chips", name: "Chips" }])).toBe('[{ code: "chips", name: "Chips" }]');
  });

  test("nests, on one line", () => {
    expect(renderConfigValue([{ key: "tic-tac-toe", rules: { rows: 3, cols: 3, connect: 3 } }])).toBe(
      '[{ key: "tic-tac-toe", rules: { rows: 3, cols: 3, connect: 3 } }]',
    );
  });

  test("quotes a key that cannot be written bare", () => {
    expect(renderConfigValue({ "content-type": "application/json" })).toBe('{ "content-type": "application/json" }');
  });

  test("escapes a backslash, which Biome leaves escaped", () => {
    expect(renderConfigValue("a \\ value")).toBe('"a \\\\ value"');
  });

  test("keeps double quotes around a string carrying an apostrophe", () => {
    // Biome only switches to single quotes to avoid escaping a `"`. With none to escape it keeps ours.
    expect(renderConfigValue("it's fine")).toBe('"it\'s fine"');
  });

  test("refuses a value it cannot print as Biome would, rather than printing something Biome reprints", () => {
    // The schema keeps these out of a manifest. This is the other door: `pithy add --set` hands a string
    // straight through, and a refusal at the command is better than a config file that fails the
    // scaffold's own lint gate. The old test pinned `"he said \"hi\""` as correct; Biome prints
    // `'he said "hi"'`, so what it pinned was a violation of this function's own contract (#171).
    expect(() => renderConfigValue('he said "hi"')).toThrow(/double quote/);
    expect(() => renderConfigValue(TEMPLATE_LIKE)).toThrow();
    expect(() => renderConfigValue({ 'a"b': 1 })).toThrow();
    expect(() => renderConfigValue([{ nested: 'a "b"' }])).toThrow();
  });

  test("refuses a number no plain decimal spells", () => {
    expect(() => renderConfigValue(1e21)).toThrow(/plain decimal/);
    expect(() => renderConfigValue(1e-7)).toThrow();
    expect(renderConfigValue(0.5)).toBe("0.5");
    expect(renderConfigValue(-3)).toBe("-3");
  });
});

/**
 * The line, not just the value. Both writers put an option on one line at one indent, and Biome only
 * breaks a literal that exceeds its configured width — so the rule that keeps a scaffold lint-clean is
 * about the whole line, and it belongs where the renderer is.
 */
describe("renderConfigOptionLine", () => {
  test("renders the line pithy add and pithy upgrade both write", () => {
    expect(renderConfigOptionLine("currencies", [{ code: "chips", name: "Chips" }], CONFIG_OPTION_INDENT)).toBe(
      '      currencies: [{ code: "chips", name: "Chips" }],',
    );
  });

  test("takes its indent from the caller, because both writers take theirs from the file", () => {
    expect(renderConfigOptionLine("basePath", "/auth", " ")).toBe(' basePath: "/auth",');
  });

  test("the scaffold's indent is the marker's four columns plus two", () => {
    expect(CONFIG_OPTION_INDENT).toBe("      ");
    expect(CONFIG_LINE_WIDTH).toBe(120);
  });
});
