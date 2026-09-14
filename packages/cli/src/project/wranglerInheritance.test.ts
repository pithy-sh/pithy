// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import {
  describeUnrepeatedKey,
  NOT_INHERITED_BY_ENVIRONMENTS,
  stanzaFor,
  topLevelKeysToRepeat,
  unrepeatedKeys,
} from "./wranglerInheritance";

/**
 * **The gate.** {@link NOT_INHERITED_BY_ENVIRONMENTS} is written by hand, and this holds it to wrangler's
 * own answer — so the day wrangler adds a key, or moves one across the line, the build says so.
 *
 * It matters that the list is hand-written and the comparison is against wrangler. Deriving the list from
 * wrangler at runtime would make this test compare wrangler to itself, which is the one shape that cannot
 * fail. The declaration is the claim; wrangler is the subject; this is the gate between them.
 *
 * **Why a hand-written list needed a gate at all.** #581 opened with a four-name list of non-inherited
 * keys, written from a wrangler warning read at a terminal. Two of the four names were wrong — both
 * `observability` and `triggers` *are* inherited — and the error survived a day, a commit in the kit's
 * first adopter, and an issue body. Wrangler's real list is 41 names. Nothing but this comparison would
 * have caught that, and nothing but this comparison will catch the next one.
 *
 * ## Two readers, because one could go quiet
 *
 * Both of wrangler's shipped artifacts answer this question, and they are read separately:
 *
 * - **`wrangler-dist/cli.js`** — the behavior itself. `notInheritable(diagnostics, topLevelEnv, rawConfig,
 *   rawEnv, envName, "<field>", …)` is the function that decides, at config-normalization time, that a
 *   field is taken from `env.<name>` alone. Its sixth argument is the field.
 * - **`wrangler-dist/cli.d.ts`** — the `EnvironmentNonInheritable` interface, whose own doc comment says
 *   "cannot be inherited from the top-level environment, and must be defined specifically".
 *
 * They must agree with each other and with the declaration. Reading only the bundle would leave the gate
 * blind the day wrangler minifies it — a minified `notInheritable` call site keeps its string literal but
 * loses the parameter names this parse anchors on. So each reader asserts it found a plausible list before
 * it is compared: a reader that silently returns nothing is a gate that passes on an empty set, which is
 * exactly the reach failure this repo has shipped before.
 */

const require_ = createRequire(import.meta.url);
const wranglerDist = join(dirname(require_.resolve("wrangler/package.json")), "wrangler-dist");

/**
 * Every field wrangler's own `notInheritable(…)` call sites name, read out of the shipped bundle.
 *
 * The parse is anchored on the five parameters that precede the field — `diagnostics, topLevelEnv,
 * rawConfig, rawEnv, envName` — rather than on "a string in a call to something". That is deliberate: a
 * looser pattern would match the function's own declaration and any future overload, and a pattern that
 * matches more than it means is how a gate starts reporting names nobody wrote.
 */
async function fieldsFromCallSites(): Promise<Set<string>> {
  const bundle = await readFile(join(wranglerDist, "cli.js"), "utf8");
  const identifier = String.raw`[A-Za-z_$][\w$]*`;
  const preceding = new Array(5).fill(`\\s*${identifier}\\s*,`).join("");
  const callSite = new RegExp(String.raw`notInheritable\(${preceding}\s*"([^"]+)"`, "g");
  return new Set([...bundle.matchAll(callSite)].map((match) => match[1] as string));
}

/**
 * Every field of wrangler's `EnvironmentNonInheritable` interface, read out of the shipped declarations.
 *
 * Brace-balanced rather than line-ranged: the interface is a thousand lines of nested object literals, and
 * a fixed range would silently start reading the next interface the day wrangler adds a field.
 */
async function fieldsFromTypes(): Promise<Set<string>> {
  const declarations = await readFile(join(wranglerDist, "cli.d.ts"), "utf8");
  const open = declarations.indexOf("{", declarations.indexOf("interface EnvironmentNonInheritable {"));
  expect(open, "wrangler's declarations no longer carry an EnvironmentNonInheritable interface").toBeGreaterThan(0);
  let depth = 0;
  let close = -1;
  for (let at = open; at < declarations.length; at++) {
    if (declarations[at] === "{") depth++;
    else if (declarations[at] === "}" && --depth === 0) {
      close = at;
      break;
    }
  }
  expect(close, "wrangler's EnvironmentNonInheritable interface does not close").toBeGreaterThan(open);
  const fields = new Set<string>();
  let nesting = 0;
  for (const line of declarations.slice(open + 1, close).split("\n")) {
    // Only the interface's own members — a `binding: string` inside one field's object type is not a
    // wrangler config key.
    const member = nesting === 0 ? /^\s*([a-z_0-9]+)\??\s*:/.exec(line) : null;
    if (member) fields.add(member[1] as string);
    for (const character of line) {
      if (character === "{" || character === "(" || character === "[") nesting++;
      else if (character === "}" || character === ")" || character === "]") nesting--;
    }
  }
  return fields;
}

describe("the declared list agrees with wrangler", () => {
  test("wrangler's notInheritable call sites are exactly what the kit declares", async () => {
    const fields = await fieldsFromCallSites();
    // The reach check. A bundle this parse can no longer read yields few or no fields, and an empty set
    // compared against an empty set is a gate that passes on nothing.
    expect(
      fields.size,
      "the notInheritable call sites could no longer be read out of wrangler's bundle",
    ).toBeGreaterThan(30);
    expect([...fields].sort()).toEqual([...NOT_INHERITED_BY_ENVIRONMENTS].sort());
  });

  test("wrangler's EnvironmentNonInheritable interface is exactly what the kit declares", async () => {
    const fields = await fieldsFromTypes();
    expect(
      fields.size,
      "EnvironmentNonInheritable could no longer be read out of wrangler's declarations",
    ).toBeGreaterThan(30);
    expect([...fields].sort()).toEqual([...NOT_INHERITED_BY_ENVIRONMENTS].sort());
  });

  test("the declaration holds each name once", () => {
    expect(new Set(NOT_INHERITED_BY_ENVIRONMENTS).size).toBe(NOT_INHERITED_BY_ENVIRONMENTS.length);
  });

  test("the keys #581 was wrong about are on the side wrangler puts them", () => {
    // Not a second list: these four are the issue's own claim, kept as the regression it was. `vars` and
    // `version_metadata` are not inherited; `observability` and `triggers` are, and a check that reported
    // them would be noise on every project that declares logging once at the top level.
    expect(NOT_INHERITED_BY_ENVIRONMENTS).toContain("vars");
    expect(NOT_INHERITED_BY_ENVIRONMENTS).toContain("version_metadata");
    expect(NOT_INHERITED_BY_ENVIRONMENTS).not.toContain("observability");
    expect(NOT_INHERITED_BY_ENVIRONMENTS).not.toContain("triggers");
  });
});

describe("unrepeatedKeys", () => {
  test("names the key, the environment, and what the environment goes without", () => {
    expect(
      unrepeatedKeys({
        version_metadata: { binding: "CF_VERSION_METADATA" },
        env: { staging: { vars: { ENVIRONMENT: "staging" } }, prod: { vars: {} } },
      }),
    ).toEqual([
      { env: "staging", key: "version_metadata", carries: ["CF_VERSION_METADATA"] },
      { env: "prod", key: "version_metadata", carries: ["CF_VERSION_METADATA"] },
    ]);
  });

  test("a stanza that repeats the key is clean, whatever it repeats it with", () => {
    expect(
      unrepeatedKeys({
        vars: { ENVIRONMENT: "dev" },
        env: { staging: { vars: { ENVIRONMENT: "staging" } } },
      }),
    ).toEqual([]);
  });

  test("an inherited key is never reported, however absent it is", () => {
    // The whole correction on #581. `observability` at the top level and nowhere else is correct config.
    expect(unrepeatedKeys({ observability: { enabled: true }, triggers: { crons: [] }, env: { prod: {} } })).toEqual(
      [],
    );
  });

  test("a top level that declares nothing costs an environment nothing", () => {
    // Wrangler warns on `d1_databases: []` here, and this does not. An empty collection binds nothing, so
    // there is no cost to name — and the starter ships two of them.
    expect(unrepeatedKeys({ d1_databases: [], kv_namespaces: [], vars: {}, env: { prod: {} } })).toEqual([]);
  });

  test("reads the variables an environment would go without by name", () => {
    const [found] = unrepeatedKeys({ vars: { ENVIRONMENT: "dev", PROJECT: "acme" }, env: { prod: {} } });
    expect(found).toEqual({ env: "prod", key: "vars", carries: ["ENVIRONMENT", "PROJECT"] });
    expect(describeUnrepeatedKey(found as never)).toContain("ENVIRONMENT, PROJECT");
  });

  test("reads binding names out of an array of bindings", () => {
    const [found] = unrepeatedKeys({
      kv_namespaces: [{ binding: "SESSIONS", id: "abc" }],
      env: { prod: {} },
    });
    expect(found?.carries).toEqual(["SESSIONS"]);
  });

  test("names the key and the environment even when it can name nothing inside", () => {
    const [found] = unrepeatedKeys({ queues: { producers: [{ queue: "q" }] }, env: { prod: {} } });
    expect(found?.key).toBe("queues");
    expect(describeUnrepeatedKey(found as never)).toContain("queues");
    expect(describeUnrepeatedKey(found as never)).toContain("env.prod");
  });

  test("a config with no environments has nothing to say", () => {
    expect(unrepeatedKeys({ vars: { A: "1" } })).toEqual([]);
    expect(unrepeatedKeys(null)).toEqual([]);
    expect(unrepeatedKeys("not a config")).toEqual([]);
  });
});

describe("topLevelKeysToRepeat", () => {
  test("is what a stanza must carry, and nothing a stanza would not want", () => {
    const repeat = topLevelKeysToRepeat({
      name: "acme-api",
      observability: { enabled: true },
      version_metadata: { binding: "CF_VERSION_METADATA" },
      vars: { ENVIRONMENT: "dev" },
      d1_databases: [],
    });
    expect(repeat).toEqual({
      version_metadata: { binding: "CF_VERSION_METADATA" },
      vars: { ENVIRONMENT: "dev" },
    });
  });

  test("hands back a copy, so one stanza's edit is not every stanza's", () => {
    const config = { version_metadata: { binding: "CF_VERSION_METADATA" } };
    const repeat = topLevelKeysToRepeat(config);
    expect(repeat.version_metadata).not.toBe(config.version_metadata);
  });

  test("every key it hands back is one an environment does not inherit", () => {
    // The reach check, stated as the invariant rather than as a list: whatever this returns for whatever
    // config, it is a subset of the declaration — so a caller repeating its output can never repeat a key
    // wrangler already inherits.
    const everything = Object.fromEntries(
      [...NOT_INHERITED_BY_ENVIRONMENTS, "observability", "triggers", "name", "main"].map((key) => [key, { a: 1 }]),
    );
    expect(Object.keys(topLevelKeysToRepeat(everything)).sort()).toEqual([...NOT_INHERITED_BY_ENVIRONMENTS].sort());
  });
});

/**
 * **The one place a stanza is created**, and what a created one starts out holding.
 *
 * #581 taught two of the kit's stanza writers to repeat what an environment does not inherit and missed
 * the third — `provision/wranglerEnv.ts`, the one every `pithy provision` and every feature deploy goes
 * through, which built its stanza as `config.env[key] ?? {}` and filled in ids. Four more modules had the
 * same three lines. `ci/envStanzaWriters.test.ts` is what keeps a seventh from being written.
 */
describe("stanzaFor", () => {
  const starter = () => ({
    name: "acme-api",
    observability: { enabled: true },
    vars: { ENVIRONMENT: "dev", PROJECT: "acme", WORKER: "api" },
    version_metadata: { binding: "CF_VERSION_METADATA" },
    d1_databases: [{ binding: "DB", database_name: "acme-dev-db", database_id: "dev-uuid" }],
    env: {} as Record<string, Record<string, unknown> | undefined>,
  });

  test("goes without nothing the top level declares", () => {
    // The invariant, read back by the check that reports violations of it — not a list of key names.
    const config = starter();
    stanzaFor(config, "staging");
    expect(unrepeatedKeys(config)).toEqual([]);
  });

  test("names its own environment rather than carrying dev's", () => {
    const config = starter();
    expect(stanzaFor(config, "staging").vars).toEqual({ ENVIRONMENT: "staging", PROJECT: "acme", WORKER: "api" });
  });

  test("invents no ENVIRONMENT where the top level stamps none", () => {
    const config = { vars: { API_BASE: "https://acme.test" } };
    expect(stanzaFor(config, "staging").vars).toEqual({ API_BASE: "https://acme.test" });
  });

  test("starts every list empty, so a stanza never binds the resource another environment writes to", () => {
    // The reason a stanza is seeded rather than copied. An absent `d1_databases` fails staging's first
    // request; a copied one points staging at the database dev writes to, and nothing ever says so.
    const config = starter();
    expect(stanzaFor(config, "staging").d1_databases).toEqual([]);
  });

  test("empties a list wrapped in an object too", () => {
    // `durable_objects.bindings`, `queues.producers` — lists by another name, and a `script_name` inside
    // one points at the Worker of the environment it was copied from.
    const config = {
      durable_objects: { bindings: [{ name: "ROOM", class_name: "Room", script_name: "acme-api" }] },
      env: {} as Record<string, Record<string, unknown> | undefined>,
    };
    expect(stanzaFor(config, "prod").durable_objects).toEqual({ bindings: [] });
  });

  test("leaves a stanza that is already there exactly as it is", () => {
    // An adopter's stanza is theirs (#142). A key they left out is a decision; `pithy doctor` reports it
    // and nothing here writes over it.
    const config = starter();
    const theirs = { name: "acme-prod-api" };
    config.env.prod = theirs;
    expect(stanzaFor(config, "prod")).toBe(theirs);
    expect(theirs).toEqual({ name: "acme-prod-api" });
  });

  test("reads a null stanza as the absence it is", () => {
    const config = { ...starter(), env: { prod: null } as unknown as Record<string, Record<string, unknown>> };
    expect(stanzaFor(config, "prod").version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
  });

  test("answers dev with the top level, because wrangler has no env.dev", () => {
    const config = starter();
    expect(stanzaFor(config, "dev")).toBe(config);
    expect(config.env).toEqual({});
  });

  test("refuses a config it cannot read rather than inventing one", () => {
    expect(() => stanzaFor(null, "staging")).toThrow(/stanza could not be read/);
    // And the throw-site context says which environment, in `detail` rather than in the message.
    try {
      stanzaFor("wrangler.jsonc", "staging");
      expect.unreachable("stanzaFor accepted a string as a config");
    } catch (error) {
      expect((error as PithyError).payload.detail).toContain("env.staging");
    }
  });
});
