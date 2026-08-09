// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { type DashboardFetch, type DashboardRequestInit, httpDashboardClient } from "./api";
import { DEFAULT_DASHBOARD_ORIGIN } from "./contract";

/** A public key that satisfies `Ed25519PublicJwk`. */
const JWK = { kty: "OKP", crv: "Ed25519", x: "kHo4iZ3rG3Jm2m7L9pQwXyZ0aBcDeFgHiJkLmNoPqRs" } as const;

/** One recorded call, so a test can assert the method, URL, headers, and body the client sent. */
interface Recorded {
  url: string;
  init: DashboardRequestInit;
}

/** A `fetch` double that answers each call from a queue and records what it was asked. */
function stubFetch(responses: { status: number; body?: unknown; raw?: string }[]): {
  fetch: DashboardFetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let index = 0;
  const fetch: DashboardFetch = async (url, init) => {
    calls.push({ url, init });
    const response = responses[Math.min(index++, responses.length - 1)];
    if (!response) throw new Error("stubFetch ran out of responses");
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      text: async () => response.raw ?? JSON.stringify(response.body ?? {}),
    };
  };
  return { fetch, calls };
}

describe("httpDashboardClient — device authorization", () => {
  test("starts a device flow against the configured origin and parses the authorization", async () => {
    const { fetch, calls } = stubFetch([
      {
        status: 200,
        body: {
          deviceCode: "dc_1",
          userCode: "PITHY-7Q4X",
          verificationUri: "https://app.pithy.sh/cli",
          expiresInSeconds: 600,
          intervalSeconds: 5,
        },
      },
    ]);
    const client = httpDashboardClient({ origin: "https://dash.example.com", fetch });

    const authorization = await client.startDeviceAuthorization();

    expect(authorization.userCode).toBe("PITHY-7Q4X");
    expect(authorization.intervalSeconds).toBe(5);
    expect(calls[0]?.url).toBe("https://dash.example.com/api/cli/device/start");
    expect(calls[0]?.init.method).toBe("POST");
  });

  test("defaults to app.pithy.sh", async () => {
    const { fetch, calls } = stubFetch([
      {
        status: 200,
        body: {
          deviceCode: "dc_1",
          userCode: "A",
          verificationUri: "https://app.pithy.sh/cli",
          expiresInSeconds: 600,
          intervalSeconds: 5,
        },
      },
    ]);
    await httpDashboardClient({ fetch }).startDeviceAuthorization();
    expect(calls[0]?.url).toBe(`${DEFAULT_DASHBOARD_ORIGIN}/api/cli/device/start`);
  });

  test("202 is pending, not a failure — the human has not approved yet", async () => {
    const { fetch } = stubFetch([{ status: 202, body: { status: "pending" } }]);
    expect(await httpDashboardClient({ fetch }).pollForConnectToken("dc_1")).toBe("pending");
  });

  test("200 yields the connect token and sends the device code", async () => {
    const { fetch, calls } = stubFetch([{ status: 200, body: { connectToken: "ct_1", expiresInSeconds: 300 } }]);
    const result = await httpDashboardClient({ fetch }).pollForConnectToken("dc_1");
    expect(result).toEqual({ connectToken: "ct_1", expiresInSeconds: 300 });
    expect(JSON.parse(calls[0]?.init.body ?? "{}")).toEqual({ deviceCode: "dc_1" });
  });

  test("410 gives up — a PithyError telling the operator to start again", async () => {
    const { fetch } = stubFetch([{ status: 410, body: {} }]);
    const error = await httpDashboardClient({ fetch })
      .pollForConnectToken("dc_1")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.code).toBe("core/not_found");
  });
});

describe("httpDashboardClient — connections", () => {
  test("creates a connection with the bearer token and parses the issued keypair", async () => {
    const { fetch, calls } = stubFetch([
      {
        status: 201,
        body: {
          connectionId: "5f1f1c3e-6b2a-4d9f-8f2a-1c9d0e5b7a31",
          keyId: "key_1",
          publicKeyJwk: JWK,
          issuer: "https://app.pithy.sh",
          scopes: ["manifest:read"],
        },
      },
    ]);

    const issued = await httpDashboardClient({ fetch }).createConnection("ct_1", {
      project: "acme",
      environment: "prod",
      isProduction: true,
      workerUrl: "https://api.example.com",
      basePath: "/control-plane",
      scopes: ["manifest:read"],
    });

    expect(issued.keyId).toBe("key_1");
    expect(issued.publicKeyJwk).toEqual(JWK);
    expect(calls[0]?.url).toBe(`${DEFAULT_DASHBOARD_ORIGIN}/api/cli/connections`);
    expect(calls[0]?.init.headers.authorization).toBe("Bearer ct_1");
    // `isProduction` is on the wire, because the client cannot work it out: a project may call
    // production `live`, and a client guessing from the name gives it the safe-looking treatment.
    expect(JSON.parse(calls[0]?.init.body ?? "{}")).toEqual({
      project: "acme",
      environment: "prod",
      isProduction: true,
      workerUrl: "https://api.example.com",
      basePath: "/control-plane",
      scopes: ["manifest:read"],
    });
  });

  test("rotate posts to the connection's rotate route and returns only the public half", async () => {
    const { fetch, calls } = stubFetch([{ status: 201, body: { keyId: "key_2", publicKeyJwk: JWK } }]);
    const issued = await httpDashboardClient({ fetch }).rotateKey("ct_1", "conn_1");
    expect(issued).toEqual({ keyId: "key_2", publicKeyJwk: JWK });
    expect(calls[0]?.url).toBe(`${DEFAULT_DASHBOARD_ORIGIN}/api/cli/connections/conn_1/rotate`);
  });

  test("verify carries the worker URL — the address the management client must reach", async () => {
    const { fetch, calls } = stubFetch([{ status: 200, body: { status: "needs_reconnect", detail: "404" } }]);
    const health = await httpDashboardClient({ fetch }).verifyConnection("ct_1", "conn_1", "https://api.example.com");
    expect(health).toEqual({ status: "needs_reconnect", detail: "404" });
    expect(JSON.parse(calls[0]?.init.body ?? "{}")).toEqual({ workerUrl: "https://api.example.com" });
  });

  test("delete accepts 204 with no body", async () => {
    const { fetch, calls } = stubFetch([{ status: 204, raw: "" }]);
    await expect(httpDashboardClient({ fetch }).deleteConnection("ct_1", "conn_1")).resolves.toBeUndefined();
    expect(calls[0]?.init.method).toBe("DELETE");
  });
});

describe("httpDashboardClient — the network boundary", () => {
  test("a malformed response is a PithyError, never a raw ZodError", async () => {
    const { fetch } = stubFetch([{ status: 201, body: { keyId: "key_2" } }]);
    const error = await httpDashboardClient({ fetch })
      .rotateKey("ct_1", "conn_1")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.code).toBe("core/internal");
    expect((error as PithyError).name).not.toBe("ZodError");
  });

  test("a body that is not JSON at all is a PithyError", async () => {
    const { fetch } = stubFetch([{ status: 200, raw: "<html>502 Bad Gateway</html>" }]);
    await expect(httpDashboardClient({ fetch }).startDeviceAuthorization()).rejects.toBeInstanceOf(PithyError);
  });

  test("an unreachable dashboard is a PithyError with an action line, never a raw fetch error", async () => {
    const fetch: DashboardFetch = async () => {
      throw new TypeError("fetch failed");
    };
    const error = await httpDashboardClient({ fetch })
      .startDeviceAuthorization()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.action).toBeTruthy();
  });

  test("a 500 from the dashboard is a PithyError carrying the status in detail, not in the message", async () => {
    const { fetch } = stubFetch([{ status: 500, body: { error: "boom" } }]);
    const error = await httpDashboardClient({ fetch })
      .startDeviceAuthorization()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.detail).toContain("500");
  });
});

/**
 * Four failures, four answers (#217).
 *
 * `unusable` carried one action — *Check the dashboard origin with --origin* — for every way a call can
 * fail. That is right for a mistyped origin and wrong for the rest: an operator whose network is down,
 * whose token expired, or whose own management client 500s reads it, checks a correct origin, and
 * learns nothing. Worse on the timeout path, where the origin was reachable all along.
 */
describe("httpDashboardClient — refusals name the failure they had", () => {
  function failingFetch(error: unknown): DashboardFetch {
    return async () => {
      throw error;
    };
  }

  test("a timeout is not an origin problem", async () => {
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    const client = httpDashboardClient({ fetch: failingFetch(abort) });

    await expect(client.startDeviceAuthorization()).rejects.toSatisfy((error: PithyError) => {
      expect(error.payload.action).not.toMatch(/--origin/);
      expect(error.payload.action).toMatch(/timed out|retry/i);
      return true;
    });
  });

  test("a DNS failure names the origin, because that one is the origin", async () => {
    const dns = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND nope.example"), { code: "ENOTFOUND" }),
    });
    const client = httpDashboardClient({ fetch: failingFetch(dns) });

    await expect(client.startDeviceAuthorization()).rejects.toSatisfy((error: PithyError) => {
      expect(error.payload.action).toMatch(/--origin/);
      return true;
    });
  });

  test("a refused connection is not a mistyped origin", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }),
    });
    const client = httpDashboardClient({ fetch: failingFetch(refused) });

    await expect(client.startDeviceAuthorization()).rejects.toSatisfy((error: PithyError) => {
      expect(error.payload.action).toMatch(/listening|reachable/i);
      return true;
    });
  });

  test("an unrecognised transport failure gets no single remedy", async () => {
    const client = httpDashboardClient({ fetch: failingFetch({ weird: true }) });

    await expect(client.startDeviceAuthorization()).rejects.toSatisfy((error: PithyError) => {
      expect(error.payload.action).not.toMatch(/^Check the dashboard origin with --origin/);
      return true;
    });
  });

  // **Found by running Bun's own fetch, not by a node fixture.** Bun does not wrap in a `TypeError` and
  // does not use node's errnos: a dead host, a bogus TLD and a refused port all arrive as one
  // `code: "ConnectionRefused"` on a plain `Error`. Bun cannot tell them apart, so neither may this —
  // one sentence that covers both, which is the hedge the convention asks for. Verified on Bun 1.3.14.
  test("Bun's ConnectionRefused covers DNS and a refused port, so the action covers both", () => {
    const cause = Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
      code: "ConnectionRefused",
    });
    const client = httpDashboardClient({ origin: "https://nope.example", fetch: failingFetch(cause) });

    return expect(client.startDeviceAuthorization()).rejects.toSatisfy((error: PithyError) => {
      expect(error.payload.action).toMatch(/listening/i);
      expect(error.payload.action).toMatch(/--origin/);
      // And never the bare errno-hedge, which would say nothing an operator can act on.
      expect(error.payload.action).not.toMatch(/Check network access/);
      return true;
    });
  });

  test("Bun reports TLS with node's own codes, so the certificate sentence still fires", () => {
    const cause = Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" });
    const client = httpDashboardClient({ fetch: failingFetch(cause) });

    return expect(client.startDeviceAuthorization()).rejects.toSatisfy((error: PithyError) => {
      expect(error.payload.action).toMatch(/certificate/i);
      expect(error.payload.action).not.toMatch(/--origin/);
      return true;
    });
  });

  test("a 401 is about the credential, not the origin", async () => {
    const { fetch } = stubFetch([{ status: 401, raw: "no" }]);
    const client = httpDashboardClient({ fetch });

    await expect(client.startDeviceAuthorization()).rejects.toSatisfy((error: PithyError) => {
      expect(error.payload.action).not.toMatch(/--origin/);
      expect(error.payload.action).toMatch(/sign in|token|credential/i);
      return true;
    });
  });

  test("a 500 from a reachable client is not an origin problem either", async () => {
    const { fetch } = stubFetch([{ status: 500, raw: "boom" }]);
    const client = httpDashboardClient({ fetch });

    await expect(client.startDeviceAuthorization()).rejects.toSatisfy((error: PithyError) => {
      expect(error.payload.action).not.toMatch(/--origin/);
      expect(error.payload.action).toMatch(/retry/i);
      return true;
    });
  });

  test("a body that is not JSON does point at the origin — that answer is earned", async () => {
    const { fetch } = stubFetch([{ status: 200, raw: "<html>hello</html>" }]);
    const client = httpDashboardClient({ fetch });

    await expect(client.startDeviceAuthorization()).rejects.toSatisfy((error: PithyError) => {
      expect(error.payload.action).toMatch(/--origin/);
      return true;
    });
  });
});
