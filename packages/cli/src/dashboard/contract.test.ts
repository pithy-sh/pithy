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
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = join(HERE, "..", "..");

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

  test("the contract reaches for no timer, no fetch, and nothing from node", () => {
    // Comments stripped first: this module *explains* the timer that used to be here, and a scan that
    // reads prose as code would fail on the explanation of the bug rather than on the bug.
    const code = readFileSync(join(HERE, "contract.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    // The regression, stated as the property. `timer.unref?.()` is a `number` under the Workers types,
    // so the whole module failed to compile in every program that could implement it.
    expect(code).not.toMatch(/setTimeout|clearTimeout|globalThis\.fetch|from "node:/);
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
