// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test, vi } from "vitest";
import { fetchPackument, fetchTarball, packumentUrl, type RegistryFetch, type RegistryResponse } from "./registry";

/** A response carrying `body` as JSON. */
function jsonResponse(body: unknown, status = 200): RegistryResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer,
  };
}

/** A response carrying raw bytes. */
function bytesResponse(bytes: Uint8Array, status = 200): RegistryResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError("not JSON");
    },
    arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
  };
}

const packument = {
  name: "@pithy-sh/ui-react",
  "dist-tags": { latest: "0.3.1" },
  versions: {
    "0.2.0": {
      name: "@pithy-sh/ui-react",
      version: "0.2.0",
      dist: { tarball: "https://registry.npmjs.org/@pithy-sh/ui-react/-/ui-react-0.2.0.tgz", integrity: "sha512-AA==" },
    },
    "0.3.1": {
      name: "@pithy-sh/ui-react",
      version: "0.3.1",
      deprecated: "Use 0.3.2.",
      dependencies: { "@pithy-sh/core": "^0.7.2" },
      dist: { tarball: "https://registry.npmjs.org/@pithy-sh/ui-react/-/ui-react-0.3.1.tgz", integrity: "sha512-AB==" },
    },
  },
};

describe("fetchPackument", () => {
  test("asks for the abbreviated document, scoped name escaped", async () => {
    const fetch = vi.fn<RegistryFetch>(async () => jsonResponse(packument));
    const read = await fetchPackument("@pithy-sh/ui-react", { fetch });
    expect(fetch).toHaveBeenCalledWith("https://registry.npmjs.org/@pithy-sh%2Fui-react", {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
      signal: expect.any(AbortSignal),
    });
    expect(packumentUrl("@pithy-sh/auth")).toBe("https://registry.npmjs.org/@pithy-sh%2Fauth");
    expect(read?.["dist-tags"].latest).toBe("0.3.1");
    expect(read?.versions["0.3.1"]?.deprecated).toBe("Use 0.3.2.");
    expect(read?.versions["0.3.1"]?.dependencies).toEqual({ "@pithy-sh/core": "^0.7.2" });
  });

  test("a non-200 is null, never an empty version list", async () => {
    expect(await fetchPackument("@pithy-sh/auth", { fetch: async () => jsonResponse({}, 404) })).toBeNull();
  });

  test.each([
    ["no dist-tags", { name: "x", versions: {} }],
    ["no versions", { name: "x", "dist-tags": { latest: "1.0.0" } }],
    ["a version with no tarball", { ...packument, versions: { "0.2.0": { version: "0.2.0", dist: {} } } }],
    ["a string", "hello"],
    ["null", null],
  ])("a malformed packument (%s) is null", async (_label, body) => {
    expect(await fetchPackument("@pithy-sh/auth", { fetch: async () => jsonResponse(body) })).toBeNull();
  });

  test("a rejected fetch or a body that will not parse is null", async () => {
    expect(
      await fetchPackument("@pithy-sh/auth", {
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    ).toBeNull();
    expect(
      await fetchPackument("@pithy-sh/auth", { fetch: async () => bytesResponse(new Uint8Array([1])) }),
    ).toBeNull();
  });

  test("a hung registry is abandoned at the timeout", async () => {
    const fetch: RegistryFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    expect(await fetchPackument("@pithy-sh/auth", { fetch, timeoutMs: 10 })).toBeNull();
  });
});

describe("fetchTarball", () => {
  const url = "https://registry.npmjs.org/@pithy-sh/ui-react/-/ui-react-0.3.1.tgz";

  test("returns the bytes", async () => {
    const bytes = await fetchTarball(url, { fetch: async () => bytesResponse(new Uint8Array([1, 2, 3])) });
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("a URL that is not https is refused without a request", async () => {
    const fetch = vi.fn<RegistryFetch>(async () => bytesResponse(new Uint8Array([1])));
    expect(await fetchTarball("http://registry.npmjs.org/x.tgz", { fetch })).toBeNull();
    expect(await fetchTarball("file:///etc/passwd", { fetch })).toBeNull();
    expect(await fetchTarball("not a url", { fetch })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("a non-200, a throw, or an oversize body is null", async () => {
    expect(await fetchTarball(url, { fetch: async () => bytesResponse(new Uint8Array([1]), 500) })).toBeNull();
    expect(
      await fetchTarball(url, {
        fetch: async () => {
          throw new Error("reset");
        },
      }),
    ).toBeNull();
    expect(await fetchTarball(url, { fetch: async () => bytesResponse(new Uint8Array(16)), maxBytes: 8 })).toBeNull();
  });
});
