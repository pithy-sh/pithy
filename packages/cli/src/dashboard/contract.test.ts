// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { CreateConnectionRequest, DEFAULT_DASHBOARD_ORIGIN, IssuedConnection } from "./contract";

/**
 * The management-client contract.
 *
 * The property this module exists for is one sentence: **the client it specifies can import it.** That
 * is a typecheck property, and `tsconfig.contract.json` is what actually enforces it — this file pins the
 * two facts that make the tsconfig meaningful (it is chained into `typecheck`, and it covers this module)
 * so the gate cannot be quietly unhooked, plus the field a request now carries.
 *
 * ## Why the source scan is no longer a list of four words
 *
 * It read `not.toMatch(/setTimeout|clearTimeout|globalThis\.fetch|from "node:/)` — three stated
 * categories, four literals. `setInterval` was not among them, nor a bare `fetch(`, nor `crypto`,
 * `process` or `Buffer`, nor `await import("node:fs")`, nor `require("node:fs")`. A rule restated as a
 * shorter forbidden list is the most common way a gate in this repository stops being able to fail.
 *
 * Both halves are stated positively now, and **neither list is written by hand from memory**:
 *
 * - the imports are held against a frozen allowlist of the three specifiers this module actually needs,
 *   which covers *nothing from node* completely — prefixed, bare, static, dynamic or `require`d;
 * - the ambient names are held against the **runtime's own global object**, so the forbidden set is
 *   every global there is rather than the four somebody thought of. `setInterval` is on it because Node
 *   puts it there, not because this file remembered.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = join(HERE, "..", "..");

/**
 * Every module specifier `contract.ts` may name. **A frozen literal**, and the whole "nothing from node"
 * rule: a specifier not on this list is reported whatever it is and however it is spelled.
 */
const ALLOWED_IMPORTS = [
  "@pithy-sh/core/src/controlPlane/data/connection",
  "@pithy-sh/core/src/controlPlane/scope/scope",
  "zod",
];

/**
 * The ambient names the contract is allowed to use.
 *
 * One entry, and it is a type: a `DashboardClient` method returns a `Promise`, which every runtime that
 * could implement this contract has. Anything else added here is a runtime dependency being taken on,
 * and it should have to be argued for in a diff.
 */
const ALLOWED_GLOBALS: ReadonlySet<string> = new Set(["Promise"]);

/**
 * `source` with every comment removed, and — unless `keepStrings` — every string literal blanked too.
 *
 * One scanner rather than two regexes, because a `//` inside a string and a quote inside a comment each
 * defeat the regex pair, and both appear in this module. Blanking the strings is required and not a
 * nicety: `contract.ts` *explains* the timer that used to be here, and every field carries a
 * `.describe()` of English prose — a scan reading either as code would fail on the explanation of the
 * bug rather than on the bug, which is how a gate gets deleted instead of fixed. The import check wants
 * the strings kept, because a specifier *is* a string.
 */
function code(source: string, keepStrings = false): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const pair = source.slice(index, index + 2);
    if (pair === "//") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (pair === "/*") {
      index += 2;
      while (index < source.length && source.slice(index, index + 2) !== "*/") index += 1;
      index += 2;
      continue;
    }
    const char = source[index] as string;
    if (char === '"' || char === "'" || char === "`") {
      const start = index;
      index += 1;
      while (index < source.length && source[index] !== char) {
        if (source[index] === "\\") index += 1;
        index += 1;
      }
      index += 1;
      out += keepStrings ? source.slice(start, index) : '""';
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** The contract module's source: comments gone, strings kept in one copy and blanked in the other. */
function contractSource(): { withStrings: string; code: string } {
  const raw = readFileSync(join(HERE, "contract.ts"), "utf8");
  return { withStrings: code(raw, true), code: code(raw) };
}

/** Every module specifier the contract names — static, dynamic, and `require`d alike. */
function importedSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)) {
    found.push(match[1] as string);
  }
  return [...new Set(found)].sort();
}

describe("the contract is a program a Workers-typed consumer can compile", () => {
  test("tsconfig.contract.json covers this module, with the Workers types and no node", () => {
    const config = readFileSync(join(PACKAGE, "tsconfig.contract.json"), "utf8");
    expect(config).toContain('"src/dashboard/contract.ts"');
    expect(config).toContain('"types": ["@cloudflare/workers-types"]');
    expect(config).not.toContain('"node"');
  });

  test("`bun run typecheck` runs it — a gate nothing runs is not a gate", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts.typecheck).toContain("tsconfig.contract.json");
  });

  test("the contract imports zod and two core schemas, and nothing else — so nothing from node", () => {
    // The whole "nothing from node" rule, stated as what is allowed. `node:fs`, a bare `fs`, an
    // `await import("node:fs")` and a `require("node:fs")` are all reported by the same assertion,
    // because none of them is one of these three.
    expect(
      importedSpecifiers(contractSource().withStrings),
      "The contract is compiled alone against the Workers types so that any management client can import it. A fourth specifier is a dependency every implementer inherits.",
    ).toEqual([...ALLOWED_IMPORTS].sort());
  });

  test("the contract reaches for no timer, no fetch — for no ambient runtime API at all", () => {
    // The regression, stated as the property. `timer.unref?.()` is a `number` under the Workers types,
    // so the whole module failed to compile in every program that could implement it.
    //
    // **The forbidden set is the runtime's own, not four names somebody remembered.** Every global this
    // process has is off limits, so `setInterval` — absent from the four literals this replaced — is on
    // the list because Node puts it there. A module that is schemas and types names none of them.
    const globals = new Set(Object.getOwnPropertyNames(globalThis));
    // The derivation is only worth having if it really contains what the rule is about. Not circular:
    // this asks whether the *population* holds known members, which nothing in `contract.ts` decides.
    for (const api of ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "fetch", "process", "crypto"]) {
      expect(globals, `${api} must be in the derived global set or this check under-covers`).toContain(api);
    }

    const named = new Set<string>();
    for (const match of contractSource().code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) {
      const name = match[1] as string;
      if (globals.has(name) && !ALLOWED_GLOBALS.has(name)) named.add(name);
    }
    expect(
      [...named].sort(),
      "The contract names an ambient runtime API. It is compiled against the Workers types and implemented by clients on other runtimes, so anything ambient here is a portability bug waiting for one of them.",
    ).toEqual([]);
  });

  test("the scan reads code, and only code", () => {
    // The gate over the gate. `code()` is what both checks above see, so a form it mishandles is a
    // violation neither can report — and this module is unusually hostile to a naive stripper: it holds
    // URLs with `//` inside string literals and quotes inside its prose.
    expect(code("const a = 1; // setInterval(fn, 1)")).not.toContain("setInterval");
    expect(code('const url = "https://example.com"; setInterval(fn, 1);')).toContain("setInterval");
    expect(code('const note = "we removed setInterval here";')).not.toContain("setInterval");
    expect(code('/* import { readFile } from "node:fs"; */ const a = 1;', true)).not.toContain("node:fs");
    expect(code('const url = "https://example.com";', true)).toContain("https://example.com");
    // And it is reading the real module, not an empty string — every schema this file asserts about
    // survives the strip.
    const stripped = contractSource().code;
    expect(stripped).toContain("DEFAULT_DASHBOARD_ORIGIN");
    expect(stripped).toContain("CreateConnectionRequest");
    expect(stripped).toContain("IssuedConnection");
  });
});

describe("CreateConnectionRequest", () => {
  const request = {
    project: "acme",
    environment: "prod",
    isProduction: true,
    workerUrl: "https://api.example.com",
    basePath: "/control-plane",
    scopes: ["manifest:read"],
  };

  test("carries whether the environment holds live data", () => {
    expect(CreateConnectionRequest.parse(request).isProduction).toBe(true);
  });

  test("a request without it is refused — a client must never have to infer it from the name", () => {
    const { isProduction: _omitted, ...without } = request;
    expect(CreateConnectionRequest.safeParse(without).success).toBe(false);
  });
});

describe("the shapes a consumer is held to", () => {
  test("IssuedConnection refuses a malformed public key rather than letting it reach the row", () => {
    expect(
      IssuedConnection.safeParse({
        connectionId: "5f1f1c3e-6b2a-4d9f-8f2a-1c9d0e5b7a31",
        keyId: "key_1",
        publicKeyJwk: { kty: "EC", crv: "P-256", x: "abc", y: "def" },
        issuer: "https://app.pithy.sh",
        scopes: ["manifest:read"],
      }).success,
    ).toBe(false);
  });

  test("the hosted origin is here, so a client and the CLI cannot disagree about where it lives", () => {
    expect(DEFAULT_DASHBOARD_ORIGIN).toBe("https://app.pithy.sh");
  });
});
