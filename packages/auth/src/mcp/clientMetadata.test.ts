// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CLIENT_METADATA_DISCOVERY_ID,
  clientMetadataDiscovery,
  fetchClientMetadata,
  verifiedHost,
} from "./clientMetadata";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(answer: () => Response = () => new Response("{}", { status: 200 })) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), init });
    return answer();
  });
  return calls;
}

describe("fetchClientMetadata", () => {
  test("fetches an HTTPS document on a public host, and never follows a redirect", async () => {
    const calls = stubFetch(
      () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } }),
    );
    const signal = new AbortController().signal;
    const res = await fetchClientMetadata("https://client.example.com/oauth/client.json", {
      headers: { accept: "application/json" },
      redirect: "error",
      signal,
    });
    expect(res.status).toBe(302);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://client.example.com/oauth/client.json");
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect(calls[0]?.init?.signal).toBe(signal);
    expect(new Headers(calls[0]?.init?.headers).get("accept")).toBe("application/json");
  });

  test("takes a URL or a Request as well as a string", async () => {
    const calls = stubFetch();
    await fetchClientMetadata(new URL("https://client.example.com/a.json"));
    await fetchClientMetadata(new Request("https://client.example.com/b.json"));
    expect(calls.map((call) => call.url)).toEqual([
      "https://client.example.com/a.json",
      "https://client.example.com/b.json",
    ]);
  });

  test("refuses anything but HTTPS, before any request leaves", async () => {
    const calls = stubFetch();
    await expect(fetchClientMetadata("http://client.example.com/client.json")).rejects.toThrow(/HTTPS/);
    expect(calls).toHaveLength(0);
  });

  test("refuses a private, link-local, loopback or metadata-service host, before any request leaves", async () => {
    const calls = stubFetch();
    for (const url of [
      "https://10.0.0.7/client.json",
      "https://192.168.1.1/client.json",
      "https://169.254.169.254/latest/meta-data",
      "https://[fe80::1]/client.json",
      "https://127.0.0.1/client.json",
      "https://localhost/client.json",
      "https://metadata.google.internal/client.json",
    ]) {
      await expect(fetchClientMetadata(url), url).rejects.toThrow(/public/);
    }
    expect(calls).toHaveLength(0);
  });

  test("reads and never writes", async () => {
    const calls = stubFetch();
    await expect(fetchClientMetadata("https://client.example.com/c.json", { method: "POST" })).rejects.toThrow(/GET/);
    await fetchClientMetadata("https://client.example.com/c.json", { method: "HEAD" });
    expect(calls.map((call) => call.init?.method)).toEqual(["HEAD"]);
  });
});

describe("clientMetadataDiscovery", () => {
  test("advertises Client ID Metadata Documents, and claims only an HTTPS client id", () => {
    const discovery = clientMetadataDiscovery();
    expect(discovery.id).toBe(CLIENT_METADATA_DISCOVERY_ID);
    expect(discovery.discoveryMetadata).toEqual({ client_id_metadata_document_supported: true });
    expect(discovery.matches("https://client.example.com/oauth/client.json")).toBe(true);
    expect(discovery.matches("http://client.example.com/oauth/client.json")).toBe(false);
    expect(discovery.matches("kWq3dynamicallyRegistered")).toBe(false);
  });

  test("fetches through the bounded transport", () => {
    expect(clientMetadataDiscovery().fetchClientMetadataResource).toBe(fetchClientMetadata);
  });
});

describe("verifiedHost", () => {
  test("is the client id's host when the client was resolved from its metadata document", () => {
    expect(
      verifiedHost({
        clientId: "https://client.example.com/oauth/client.json",
        clientDiscoveryId: CLIENT_METADATA_DISCOVERY_ID,
      }),
    ).toBe("client.example.com");
    expect(
      verifiedHost({
        clientId: "https://client.example.com:8443/c.json",
        clientDiscoveryId: CLIENT_METADATA_DISCOVERY_ID,
      }),
    ).toBe("client.example.com:8443");
  });

  test("is null for a dynamically registered client, which nothing has verified", () => {
    expect(verifiedHost({ clientId: "kWq3dynamicallyRegistered", clientDiscoveryId: null })).toBeNull();
    expect(verifiedHost({ clientId: "kWq3dynamicallyRegistered" })).toBeNull();
  });

  test("is null for a URL-shaped id no metadata document vouched for", () => {
    expect(verifiedHost({ clientId: "https://client.example.com/c.json", clientDiscoveryId: null })).toBeNull();
    expect(verifiedHost({ clientId: "https://client.example.com/c.json", clientDiscoveryId: "other" })).toBeNull();
  });

  test("is null when the id is not a URL at all, whatever the record says", () => {
    expect(verifiedHost({ clientId: "not a url", clientDiscoveryId: CLIENT_METADATA_DISCOVERY_ID })).toBeNull();
  });
});
