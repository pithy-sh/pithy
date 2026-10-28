// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createCimdClientDiscovery } from "@better-auth/cimd";
import { isPublicRoutableHost } from "@better-auth/core/utils/host";
import type { ClientDiscovery, ClientMetadataResourceFetch } from "@better-auth/oauth-provider";

/**
 * Client ID Metadata Documents: a client whose `client_id` is an HTTPS URL, and whose registration is the document
 * served there (`docs/AGENT-ACCESS.md` §4.0).
 *
 * **Composed, not written.** `@better-auth/cimd` fetches the document, refuses one whose `client_id` is not its own
 * URL, caps it at 5 KB and 5 seconds, caches it by its own caching headers within {@link METADATA_CACHE_CEILING}, and
 * persists the client it describes. The MCP profile requires `client_name` and `redirect_uris`. What this module adds
 * is the network boundary the plugin asks its host to own, and the one fact the consent screen may present as
 * verified.
 */

/** The longest a fetched document is trusted before it is fetched again, whatever its caching headers say. */
export const METADATA_CACHE_CEILING = "60m";

/** The discovery id the provider stores on every client a metadata document created. */
export const CLIENT_METADATA_DISCOVERY_ID = "cimd";

/** Where a request is going, whichever form it arrived in. */
function targetOf(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  return new URL(typeof input === "string" ? input : input.url);
}

/**
 * The fetch a metadata document, or a resource it names, is read over: HTTPS to a public host, a read, and never a
 * redirect followed — a 3xx comes back as itself, and the plugin refuses anything but a 200.
 *
 * The host is classified before anything leaves. A name that resolves to private space is refused by Cloudflare's
 * network at connection time, which is the resolve-and-pin guarantee a Worker cannot implement over `fetch` itself.
 */
export const fetchClientMetadata: ClientMetadataResourceFetch = async (input, init) => {
  const url = targetOf(input);
  if (url.protocol !== "https:") throw new TypeError(`A client metadata document is fetched over HTTPS only: ${url}`);
  if (!isPublicRoutableHost(url.hostname)) {
    throw new TypeError(`A client metadata document is fetched from a public host only: ${url.hostname}`);
  }
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    throw new TypeError(`A client metadata document is read with GET or HEAD only, not ${method}`);
  }
  return fetch(url, {
    method,
    redirect: "manual",
    ...(init?.headers === undefined ? {} : { headers: init.headers }),
    ...(init?.signal == null ? {} : { signal: init.signal }),
  });
};

/**
 * The provider's discovery for metadata-document clients. Built once per composed `mcp()`, so its cache and its
 * fetch budget outlive the per-request auth instance.
 */
export function clientMetadataDiscovery(): ClientDiscovery {
  return createCimdClientDiscovery({
    fetchClientMetadataResource: fetchClientMetadata,
    metadataProfile: "mcp-2026-07-28",
    metadataRevalidationInterval: METADATA_CACHE_CEILING,
  });
}

/**
 * The host a client's identity was proven by, or `null` when nothing was. A metadata-document client is whoever
 * serves the document at its id, so its id's host is verified; a dynamically registered client named itself, and
 * nothing about it is.
 */
export function verifiedHost(client: {
  readonly clientId: string;
  readonly clientDiscoveryId?: string | null;
}): string | null {
  if (client.clientDiscoveryId !== CLIENT_METADATA_DISCOVERY_ID) return null;
  if (!URL.canParse(client.clientId)) return null;
  const url = new URL(client.clientId);
  return url.protocol === "https:" ? url.host : null;
}
