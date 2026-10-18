// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { PithyError } from "../error/pithyError";
import { SERVICE_ORIGINS_VAR, withLocalServices } from "./serviceLoopback";

/** A transport that records each request and answers it, or refuses as a port nothing listens on does. */
function transport(answer: "ok" | "refused" = "ok") {
  const seen: Request[] = [];
  const fetch = async (request: Request): Promise<Response> => {
    seen.push(request);
    if (answer === "refused") throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:8790");
    return new Response(`from ${new URL(request.url).host}`);
  };
  return { seen, fetch };
}

const ORIGINS = JSON.stringify({ APP_B: "http://localhost:8790" });

describe("withLocalServices", () => {
  test("in dev, a published origin stands in for the binding, path and method and body kept", async () => {
    const { seen, fetch } = transport();
    const env = withLocalServices({ ENVIRONMENT: "dev", [SERVICE_ORIGINS_VAR]: ORIGINS, APP_B: {} }, { fetch });
    const service = env.APP_B as { fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response> };
    const response = await service.fetch("https://app-b.internal/things?x=1", { method: "POST", body: "hi" });
    expect(await response.text()).toBe("from localhost:8790");
    expect(seen[0]?.url).toBe("http://localhost:8790/things?x=1");
    expect(seen[0]?.method).toBe("POST");
    expect(await seen[0]?.text()).toBe("hi");
  });

  test("a Request object is carried whole", async () => {
    const { seen, fetch } = transport();
    const env = withLocalServices({ ENVIRONMENT: "dev", [SERVICE_ORIGINS_VAR]: ORIGINS }, { fetch });
    const service = env.APP_B as { fetch: (input: Request) => Promise<Response> };
    await service.fetch(new Request("https://x/a", { headers: { "x-test": "1" } }));
    expect(seen[0]?.headers.get("x-test")).toBe("1");
  });

  test("a target that is not running fails at once, naming the binding and the address", async () => {
    const { fetch } = transport("refused");
    const env = withLocalServices({ ENVIRONMENT: "dev", [SERVICE_ORIGINS_VAR]: ORIGINS }, { fetch });
    const service = env.APP_B as { fetch: (input: string) => Promise<Response> };
    const error = await service.fetch("https://x/").catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.code).toBe("core/upstream_failed");
    expect((error as PithyError).payload.message).toBe("The Worker APP_B calls is not answering.");
    expect((error as PithyError).payload.action).toContain("http://localhost:8790");
  });

  test("outside dev, and with nothing published, the env is the env", () => {
    const deployed = { ENVIRONMENT: "prod", [SERVICE_ORIGINS_VAR]: ORIGINS, APP_B: { real: true } };
    expect(withLocalServices(deployed)).toBe(deployed);
    const unstamped = { [SERVICE_ORIGINS_VAR]: ORIGINS, APP_B: { real: true } };
    expect(withLocalServices(unstamped)).toBe(unstamped);
    const quiet = { ENVIRONMENT: "dev", APP_B: { real: true } };
    expect(withLocalServices(quiet)).toBe(quiet);
  });

  test("a published value that is not a map of addresses is ignored, never half-applied", () => {
    for (const value of ["not json", '{"APP_B": 3}', '{"APP_B": "ftp://x"}', "[]"]) {
      const env = { ENVIRONMENT: "dev", [SERVICE_ORIGINS_VAR]: value, APP_B: { real: true } };
      expect(withLocalServices(env)).toBe(env);
    }
  });
});
