// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { PithyError } from "../error/pithyError";
import {
  CapabilityManifest,
  CONFIG_LINE_WIDTH,
  CONFIG_OPTION_INDENT,
  renderCapabilityImport,
  renderCapabilityRegistration,
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

  test("defaults secrets to an empty array — a capability declares nothing until it says so", () => {
    const parsed = CapabilityManifest.parse({ name: "payments", package: "@pithy-sh/payments", requiredBindings: [] });
    expect(parsed.secrets).toEqual([]);
  });

  test("carries both axes of a declared secret through to a client", () => {
    const parsed = CapabilityManifest.parse({
      name: "auth",
      package: "@pithy-sh/auth",
      requiredBindings: [],
      secrets: [
        {
          name: "auth-github-credentials",
          origin: { kind: "obtained", issuer: "github", documentation: "https://github.com/settings/developers" },
          rotation: { kind: "manual", issuer: "github", documentation: "https://github.com/settings/developers" },
        },
      ],
    });
    expect(parsed.secrets[0]).toMatchObject({ name: "auth-github-credentials", rotation: { kind: "manual" } });
  });

  test("rejects a declared secret missing an axis — half an answer reads as a whole one", () => {
    expect(() =>
      CapabilityManifest.parse({
        name: "auth",
        package: "@pithy-sh/auth",
        requiredBindings: [],
        secrets: [{ name: "auth-session-secret", origin: { kind: "minted", recipe: { kind: "encryptionConfig" } } }],
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

/**
 * The third producer of one defect.
 *
 * A manifest is third-party data, read out of `node_modules`, and its `name` reaches generated TypeScript
 * twice — the import binding and the registration call — while its `package` reaches the import
 * specifier. Both were `z.string().min(1)`, so `pithy add` wrote
 * `import { audit }) ; evil( } from "@pithy-sh/audit/src/index";` and reported `Done.` (#183). Both are
 * reproduced here as the schema now refuses them.
 */
describe("a manifest cannot state a name or a package the renderer cannot print", () => {
  /** A manifest with everything but the field under test, so a refusal can only be about that field. */
  function withName(name: unknown): unknown {
    return { name, package: "@pithy-sh/audit", requiredBindings: [] };
  }
  function withPackage(pkg: unknown): unknown {
    return { name: "audit", package: pkg, requiredBindings: [] };
  }

  test("a name that is not a bare identifier is refused, and the refusal names it", () => {
    // The first is #183's own reproduction: it closed the capabilities array and opened a call.
    for (const name of ["audit }) ; evil(", "a-b", "1x", "a b", 'a"b', "", "audit\nevil()", "./../escape"]) {
      const result = CapabilityManifest.safeParse(withName(name));
      expect(result.success, `${JSON.stringify(name)} parsed as a capability name`).toBe(false);
      expect(result.error?.issues[0]?.message).toContain(JSON.stringify(name));
      expect(result.error?.issues[0]?.message).toContain("bare identifier");
    }
  });

  test("a package that is not an npm package name is refused, and the refusal names it", () => {
    // The second hole on the same line: the specifier is quoted, so the escape closes the quote.
    for (const pkg of [
      '@pithy-sh/audit"; evil(); //',
      "@pithy-sh/audit/src/index",
      "../../elsewhere",
      "@pithy-sh/ audit",
      "_leading",
      ".leading",
      "",
      `@pithy-sh/a${"b".repeat(220)}`,
    ]) {
      const result = CapabilityManifest.safeParse(withPackage(pkg));
      expect(result.success, `${JSON.stringify(pkg)} parsed as a capability package`).toBe(false);
    }
  });

  test("every name and package this repo ships still parses", () => {
    for (const [name, pkg] of [
      ["auth", "@pithy-sh/auth"],
      ["controlplane", "@pithy-sh/core"],
      ["multiplayer", "@pithy-sh/multiplayer"],
    ] as const) {
      expect(CapabilityManifest.safeParse({ name, package: pkg, requiredBindings: [] }).success).toBe(true);
    }
    // An adopter's own capability, outside the scope and carrying npm's legacy uppercase.
    expect(CapabilityManifest.safeParse({ name: "billing", package: "MyCap-2.0", requiredBindings: [] }).success).toBe(
      true,
    );
  });

  test("a peer or optional capability is held to the same rule — it names a capability", () => {
    for (const field of ["peerCapabilities", "optionalCapabilities"]) {
      const result = CapabilityManifest.safeParse({
        name: "auth",
        package: "@pithy-sh/auth",
        requiredBindings: [],
        [field]: ["email", "}) ; evil("],
      });
      expect(result.success, `${field} accepted a name no import could bind`).toBe(false);
    }
  });
});

/**
 * The two lines #174 left without a producer.
 *
 * `renderConfigOptionLine` and `renderConfigOptionComment` made one option's two lines a single
 * function's output; the import statement and the registration call were still built inline in
 * `pithy add`, from strings nothing checked. They are functions now, total over what the schema parses,
 * so the same rule holds for `pithy upgrade`'s conversion of a one-liner into a block.
 */
describe("renderCapabilityImport and renderCapabilityRegistration", () => {
  test("renders the import line pithy add writes", () => {
    expect(renderCapabilityImport("auth", "@pithy-sh/auth/src/index")).toBe(
      'import { auth } from "@pithy-sh/auth/src/index";',
    );
  });

  test("renders the ejected import, which is composed rather than stated", () => {
    expect(renderCapabilityImport("auth", "./capabilities/auth")).toBe('import { auth } from "./capabilities/auth";');
  });

  test("renders the one-liner registration", () => {
    expect(renderCapabilityRegistration({ name: "auth", indent: "    " })).toBe("    auth(),");
  });

  test("renders the block registration from already-rendered option lines", () => {
    expect(
      renderCapabilityRegistration({
        name: "auth",
        indent: "    ",
        optionLines: ["      // Where the routes mount.", '      basePath: "/auth",'],
      }),
    ).toBe('    auth({\n      // Where the routes mount.\n      basePath: "/auth",\n    }),');
  });

  test("omits the separating comma for pithy upgrade, which splices over a call the file already punctuates", () => {
    expect(
      renderCapabilityRegistration({ name: "auth", indent: "  ", optionLines: ["    x: 1,"], trailingComma: false }),
    ).toBe("  auth({\n    x: 1,\n  })");
  });

  test("both refuse what the schema refuses — neither is reached only from a manifest", () => {
    expect(() => renderCapabilityImport("audit }) ; evil(", "@pithy-sh/audit/src/index")).toThrow(PithyError);
    expect(() => renderCapabilityRegistration({ name: "audit }) ; evil(", indent: "" })).toThrow(PithyError);
    expect(() => renderCapabilityImport("audit", '@pithy-sh/audit/src/index"; evil(); //')).toThrow(PithyError);
    expect(() => renderCapabilityImport("audit", "")).toThrow(PithyError);
    expect(() => renderCapabilityImport("audit", "@pithy-sh/a\nb")).toThrow(PithyError);
  });
});

/**
 * The gate.
 *
 * #171, #174 and #183 are one defect with three producers: a manifest field interpolated into generated
 * TypeScript that nothing narrowed. Each round fixed the field in front of it and left the rule at the
 * call site, so the next field arrived the same way. Enumerating the fields known today is precisely what
 * produced the first two misses, so this does not enumerate them.
 *
 * It states the invariant instead — **every string a manifest may state is constrained at the schema,
 * unless it is declared prose the CLI only ever prints** — and enforces it by walking the schema itself.
 * A string field added to `CapabilityManifest` with no pattern and no refinement fails this test on the
 * commit that adds it, whatever it is called and wherever it sits, and the only way past is to constrain
 * it or to say in {@link NEVER_RENDERED} why it can never reach a generated file. Deny by default: the
 * answer for a field nobody has classified is "fail", not "probably fine".
 */
describe("every manifest string that reaches generated source is constrained at the schema", () => {
  /**
   * The strings a manifest states that no generated file ever carries, each with the reason it is exempt.
   *
   * `scaffold` and `whenToEnable` are prose: the CLI prints them to a terminal and writes them nowhere.
   * The four `BindingSpec`/`DevSecret` leaves belong to composed contracts with their own rules, and they
   * reach `wrangler.jsonc` through a JSON serializer that escapes what it is given — not TypeScript
   * through interpolation. Narrowing those is `BindingSpec`'s call to make, not this schema's.
   */
  const NEVER_RENDERED = new Set([
    "scaffold[]",
    "whenToEnable",
    "requiredBindings[].name",
    "requiredBindings[].className",
    "requiredBindings[].service",
    "devSecrets[].name",
  ]);

  /** A Zod node, as much of one as the walk needs. Zod's own types do not describe a schema generically. */
  interface ZodNode {
    readonly _zod?: { readonly def?: Record<string, unknown> };
  }

  /** A string leaf found in the schema: where it sits, and the checks it carries. */
  interface StringLeaf {
    path: string;
    checks: string[];
  }

  function isNode(value: unknown): value is ZodNode {
    return typeof value === "object" && value !== null;
  }

  /**
   * Every string leaf under a schema, by path.
   *
   * Walks Zod's own definitions rather than a hand-kept list, which is the whole point: nothing here has
   * to be updated when a field is added. `seen` bounds the recursion `ConfigOptionValue` introduces —
   * that union refers to itself, and it is a leaf worth reaching, since a nested key or value is source
   * too.
   */
  function stringLeaves(schema: unknown, path = "", seen = new Set<unknown>()): StringLeaf[] {
    if (!isNode(schema) || seen.has(schema)) return [];
    seen.add(schema);
    const def = schema._zod?.def;
    if (!def) return [];
    const at = (suffix: string): string => `${path}${suffix}`;
    switch (def.type) {
      case "object": {
        const shape = def.shape as Record<string, unknown>;
        return Object.entries(shape).flatMap(([key, value]) =>
          stringLeaves(value, path === "" ? key : `${path}.${key}`, seen),
        );
      }
      case "array":
        return stringLeaves(def.element, at("[]"), seen);
      case "record":
        return [...stringLeaves(def.keyType, at("{key}"), seen), ...stringLeaves(def.valueType, at("{value}"), seen)];
      case "optional":
      case "nullable":
      case "readonly":
      case "nonoptional":
      case "prefault":
      case "default":
        return stringLeaves(def.innerType, path, seen);
      case "pipe":
        return [...stringLeaves(def.in, path, seen), ...stringLeaves(def.out, path, seen)];
      case "lazy":
        return stringLeaves((def.getter as () => unknown)(), path, seen);
      case "union":
        return (def.options as unknown[]).flatMap((option, index) => stringLeaves(option, at(`|${index}`), seen));
      case "string": {
        const checks = ((def.checks ?? []) as ZodNode[]).map((check) => String(check._zod?.def?.check ?? "unknown"));
        return [{ path: path === "" ? "<root>" : path, checks }];
      }
      default:
        return [];
    }
  }

  /**
   * Whether a check narrows the *shape* of a string rather than its length.
   *
   * `min(1)` is not a constraint for this purpose and never was: `audit }) ; evil(` is eleven characters
   * long and passed it. Only a pattern (`string_format`) or a refinement (`custom`) can say what a string
   * may contain, and both of the fields #183 closed carried neither.
   */
  function narrowsShape(check: string): boolean {
    return check === "string_format" || check === "custom";
  }

  const leaves = stringLeaves(CapabilityManifest);

  test("the walk reaches the fields three rounds of this defect were about", () => {
    // Guards against a walk that silently stops early and passes vacuously.
    const paths = leaves.map((leaf) => leaf.path);
    expect(paths).toContain("name");
    expect(paths).toContain("package");
    expect(paths).toContain("configOptions[].key");
    expect(paths).toContain("configOptions[].describe");
    expect(paths.some((path) => path.startsWith("configOptions[].default"))).toBe(true);
  });

  test("no manifest string reaches generated source unconstrained", () => {
    const unguarded = leaves
      .filter((leaf) => !NEVER_RENDERED.has(leaf.path) && !leaf.checks.some(narrowsShape))
      .map((leaf) => leaf.path);
    expect(
      unguarded,
      `${unguarded.join(", ")} can be any string a manifest cares to state, and a manifest is third-party data read from node_modules. Constrain it at the schema, or add it to NEVER_RENDERED with the reason no generated file can carry it. This is the rule #171, #174 and #183 each rediscovered one field too late.`,
    ).toEqual([]);
  });

  test("the gate bites — an exempt field would fail it if it were not exempt", () => {
    // The control. `whenToEnable` really is an unconstrained string; the test above passes because it is
    // declared prose, not because nothing is unconstrained. Drop the exemptions and the gate fires.
    const withoutExemptions = leaves.filter((leaf) => !leaf.checks.some(narrowsShape)).map((leaf) => leaf.path);
    expect(withoutExemptions.length).toBeGreaterThan(0);
    expect(withoutExemptions.every((path) => NEVER_RENDERED.has(path))).toBe(true);
  });
});
