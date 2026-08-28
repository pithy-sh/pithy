// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { WORKER_ORIGIN_VAR } from "@pithy-sh/core/src/worker/identity";
import { describe, expect, test } from "vitest";
import { devWorkerConfig } from "./devOrigin";

describe("devWorkerConfig", () => {
  test("hands the Worker the origin pithy dev allocated this checkout", () => {
    const customize = devWorkerConfig({ [WORKER_ORIGIN_VAR]: "http://localhost:8827" });
    expect(customize({ vars: { BASE_URL: "http://localhost:8787", ENVIRONMENT: "dev" } })).toEqual({
      vars: { BASE_URL: "http://localhost:8827", ENVIRONMENT: "dev" },
    });
  });

  test("two checkouts get two origins, and neither is what the file said", () => {
    // The property a fixture naming one port cannot have. `wrangler.jsonc` states a single dev
    // `BASE_URL`, so every checkout on a machine claimed the first one's address (#462).
    const declared = { vars: { BASE_URL: "http://localhost:8787" } };
    const first = devWorkerConfig({ [WORKER_ORIGIN_VAR]: "http://localhost:8807" })(declared);
    const second = devWorkerConfig({ [WORKER_ORIGIN_VAR]: "http://localhost:8827" })(declared);

    expect(first.vars?.BASE_URL).toBe("http://localhost:8807");
    expect(second.vars?.BASE_URL).toBe("http://localhost:8827");
    expect(first.vars?.BASE_URL).not.toBe(second.vars?.BASE_URL);
  });

  test("every other var survives — this overrides one setting, not the block", () => {
    const customize = devWorkerConfig({ [WORKER_ORIGIN_VAR]: "http://localhost:8827" });
    const out = customize({ vars: { ENVIRONMENT: "dev", PROJECT: "dash", WORKER: "board" } });
    expect(out.vars).toEqual({
      ENVIRONMENT: "dev",
      PROJECT: "dash",
      WORKER: "board",
      BASE_URL: "http://localhost:8827",
    });
  });

  test("outside pithy dev it changes nothing, so a build keeps its declared origin", () => {
    // A deployed environment's `BASE_URL` is generated from `domains` by `applyDomains` and is right.
    // Inventing one here would replace a correct value with a guess.
    const declared = { vars: { BASE_URL: "https://app.pithy.sh" } };
    expect(devWorkerConfig({})(declared)).toEqual({});
  });

  test("a blank or whitespace value is nobody allocating one, never an empty BASE_URL", () => {
    // Both are non-empty enough to pass a `Boolean(value)` check. An empty `BASE_URL` fails a URL
    // parse somewhere far from here instead of being denied at the seam with the origin named.
    expect(devWorkerConfig({ [WORKER_ORIGIN_VAR]: "" })({ vars: {} })).toEqual({});
    expect(devWorkerConfig({ [WORKER_ORIGIN_VAR]: "   " })({ vars: {} })).toEqual({});
  });

  test("a config that says it is not dev is never overridden", () => {
    // The customizer runs on `build` too and beats the declared `vars`, so the only thing keeping a
    // localhost origin out of a deploy is that `pithy dev` alone sets the variable. True, and one
    // exported variable from not being true — and the failure is a deployed Worker signing every
    // control-plane token with a localhost issuer and mailing magic links nobody can reach.
    const customize = devWorkerConfig({ [WORKER_ORIGIN_VAR]: "http://localhost:8827" });
    for (const environment of ["staging", "prod"]) {
      expect(customize({ vars: { ENVIRONMENT: environment, BASE_URL: "https://app.pithy.sh" } })).toEqual({});
    }
  });

  test("it still applies when the stanza says dev", () => {
    const customize = devWorkerConfig({ [WORKER_ORIGIN_VAR]: "http://localhost:8827" });
    expect(customize({ vars: { ENVIRONMENT: "dev", BASE_URL: "http://localhost:8787" } })).toEqual({
      vars: { ENVIRONMENT: "dev", BASE_URL: "http://localhost:8827" },
    });
  });

  test("a stanza that stamps no ENVIRONMENT still gets the origin", () => {
    // Only a *positive* non-dev answer withholds it. A config that cannot say which environment it is
    // would otherwise silently lose the fix it exists for, which is the failure this issue was.
    const customize = devWorkerConfig({ [WORKER_ORIGIN_VAR]: "http://localhost:8827" });
    expect(customize({ vars: { PROJECT: "dash" } })).toEqual({
      vars: { PROJECT: "dash", BASE_URL: "http://localhost:8827" },
    });
  });

  test("a Worker with no vars at all still gets one", () => {
    expect(devWorkerConfig({ [WORKER_ORIGIN_VAR]: "http://localhost:8827" })({})).toEqual({
      vars: { BASE_URL: "http://localhost:8827" },
    });
  });
});
