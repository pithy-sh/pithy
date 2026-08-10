// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { baseURLProtocol, baseURLResolver, DEV_PROTOCOL, devBaseURL, sessionCookieName } from "./baseUrl";

/** The adopter's config: one string, the origin they deploy to. */
const CONFIGURED = "https://app.pithy.sh";

/** A request as it arrives at a Worker — the only thing that knows which port this run was assigned. */
function request(url: string): Request {
  return new Request(url);
}

/**
 * The narrow gate: **no composition running under `dev` resolves an `https:` base URL.**
 *
 * Stated as the property, not as a list of forbidden strings — the configured value, the request's own
 * scheme, and the port all vary underneath it, and the answer is `http:` every time. That is what makes
 * the `__Secure-` prefix a thing that cannot appear in dev rather than a thing we remembered not to add.
 */
describe("a dev composition never resolves an https base URL", () => {
  const dev = { ENVIRONMENT: "dev" };
  const configured = [CONFIGURED, "https://api.example.com", "http://localhost:8787", "not-a-url"];
  const arriving = [
    "http://localhost:8787/auth/get-session",
    "http://localhost:41011/auth/get-session",
    "http://127.0.0.1:9339/",
    "http://[::1]:9339/",
    "http://192.168.1.14:8787/",
    // A request that claims HTTPS gets the same answer: the scheme is fixed by policy, never copied.
    "https://app.pithy.sh/auth/get-session",
  ];

  for (const value of configured) {
    for (const url of arriving) {
      test(`${value} + ${url}`, () => {
        const resolved = baseURLResolver(value, dev)(request(url));
        expect(baseURLProtocol(resolved)).toBe(DEV_PROTOCOL);
        expect(sessionCookieName(baseURLProtocol(resolved))).toBe("better-auth.session_token");
      });
    }
  }

  test("the resolved base URL is the address the request actually arrived at, port included", () => {
    const resolved = baseURLResolver(CONFIGURED, dev)(request("http://localhost:41011/auth/get-session"));
    expect(resolved).toBe("http://localhost:41011");
  });
});

describe("every other composition resolves exactly what it was configured with", () => {
  for (const environment of ["prod", "staging", "preview", "canary"]) {
    test(environment, () => {
      const resolve = baseURLResolver(CONFIGURED, { ENVIRONMENT: environment });
      expect(resolve(request("https://app.pithy.sh/x"))).toBe(CONFIGURED);
      // Including a request that arrived somewhere else entirely — a Host header is not config.
      expect(resolve(request("http://localhost:8787/x"))).toBe(CONFIGURED);
    });
  }

  test("an unstamped composition is not dev — a lost ENVIRONMENT var must not relax anything", () => {
    expect(baseURLResolver(CONFIGURED, {})(request("http://localhost:8787/x"))).toBe(CONFIGURED);
  });

  test("a value that merely contains dev is not dev", () => {
    const resolve = baseURLResolver(CONFIGURED, { ENVIRONMENT: "development" });
    expect(resolve(request("http://localhost:8787/x"))).toBe(CONFIGURED);
  });
});

describe("the cookie name reads the scheme and nothing else", () => {
  test("https earns the __Secure- prefix", () => {
    expect(sessionCookieName("https:")).toBe("__Secure-better-auth.session_token");
  });

  test("http does not", () => {
    expect(sessionCookieName("http:")).toBe("better-auth.session_token");
  });

  test("a base URL that is not a URL gets no prefix, the way Better Auth treats it", () => {
    expect(baseURLProtocol("not-a-url")).toBe("");
    expect(sessionCookieName(baseURLProtocol("not-a-url"))).toBe("better-auth.session_token");
  });

  test("the host and port cannot reach the name", () => {
    const names = ["localhost:8787", "localhost:41011", "127.0.0.1:9339", "192.168.1.14:8787"].map((host) =>
      sessionCookieName(baseURLProtocol(devBaseURL(host))),
    );
    expect(new Set(names).size).toBe(1);
  });
});
