// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mintControlPlaneToken } from "@pithy-sh/core/src/controlPlane/token/mint";
import {
  CONTROL_PLANE_HEADER,
  CONTROL_PLANE_OIDC_HEADER,
  CONTROL_PLANE_SCOPE_HEADER,
  CONTROL_PLANE_TRUST_HEADER,
} from "@pithy-sh/core/src/controlPlane/wire";
import { UpstreamError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { WorkloadTokens } from "./workload";

/**
 * The control-plane client the MCP server is a front end on (#723, `docs/AGENT-ACCESS.md` §3).
 *
 * **A second transport over the client the CLI already is.** Every call names exactly one scope — the scope of the
 * route it calls, never the connection's grant — and presents exactly one credential, the way the seam requires
 * it: a compact JWS on `pithy-control-plane`, minted per call and bound to the body's digest, or a workload token on
 * `pithy-control-plane-oidc` beside the trust it claims and the scope it exercises. The Worker verifies and audits
 * the call as it does any other, so nothing here decides what an agent may do.
 */

/** One call's credential headers, given the scope it names and the bytes it sends. */
export interface Credential {
  headers(scope: string, body: Uint8Array): Promise<Record<string, string>>;
}

/** What a key credential signs with. */
export interface KeyCredentialOptions {
  /** The agent's signing key, imported for `Ed25519` signing. */
  readonly privateKey: CryptoKey;
  /** The key id the connection registered it under. */
  readonly keyId: string;
  /** The `iss` the connection stores for this key. */
  readonly issuer: string;
  /** The connection the token addresses — its `aud`. */
  readonly connectionId: string;
  /** Who is acting, as the audit row's actor id records it. */
  readonly subject: string;
}

/** A registered key: one token per call, naming the call's scope and bound to its body. */
export function keyCredential(options: KeyCredentialOptions): Credential {
  return {
    async headers(scope, body) {
      const token = await mintControlPlaneToken({ ...options, scope, body });
      return { [CONTROL_PLANE_HEADER]: token };
    },
  };
}

/** An OIDC trust: the workload's own token, the trust it claims, and the call's scope, named out loud. */
export function trustCredential(options: { readonly trustId: string; readonly tokens: WorkloadTokens }): Credential {
  return {
    async headers(scope) {
      return {
        [CONTROL_PLANE_OIDC_HEADER]: await options.tokens.current(),
        [CONTROL_PLANE_TRUST_HEADER]: options.trustId,
        [CONTROL_PLANE_SCOPE_HEADER]: scope,
      };
    },
  };
}

/** One admin route, as the call needs it. */
export interface CallableRoute {
  readonly method: string;
  readonly path: string;
  /** The scope the call names. */
  readonly scope: string;
}

/** A call's arguments, split the way the manifest's `input` splits them. */
export interface CallArguments {
  readonly path?: Record<string, unknown>;
  readonly query?: Record<string, unknown>;
  readonly body?: unknown;
}

/** What the Worker answered. */
export interface CallResult {
  readonly status: number;
  /** The parsed JSON body, or the text when it was not JSON. */
  readonly body: unknown;
}

/** Hono's `:name` and `:name{regex}` path parameters. */
const PARAM = /:([A-Za-z0-9_]+)(\{[^}]*\})?\??/g;

/** The route's path with its parameters filled, each one encoded so it stays one segment. */
export function fillPath(path: string, params: Record<string, unknown> = {}): string {
  return path.replace(PARAM, (_whole, name: string) => {
    const value = params[name];
    if (typeof value !== "string" && typeof value !== "number") {
      throw new ValidationError({
        message: `The call needs path.${name}.`,
        action: `Pass path.${name} as a string.`,
        detail: `no value for :${name} in ${path}`,
      });
    }
    return encodeURIComponent(String(value));
  });
}

/** A query object as a search string. Arrays repeat their key; `undefined` and `null` are left out. */
export function queryString(query: Record<string, unknown> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === undefined || item === null) continue;
      search.append(key, typeof item === "string" ? item : JSON.stringify(item));
    }
  }
  const text = search.toString();
  return text.length > 0 ? `?${text}` : "";
}

/** A client for one connection's Worker. */
export interface ControlPlaneCaller {
  call(route: CallableRoute, args?: CallArguments): Promise<CallResult>;
}

/** Options for {@link controlPlaneCaller}. */
export interface ControlPlaneCallerOptions {
  /** The Worker's origin. */
  readonly workerUrl: string;
  /** How each call proves itself. */
  readonly credential: Credential;
  /** The fetch calls go through. */
  readonly fetch?: typeof fetch;
}

/** Build the caller. */
export function controlPlaneCaller(options: ControlPlaneCallerOptions): ControlPlaneCaller {
  const send = options.fetch ?? fetch;
  return {
    async call(route, args = {}) {
      // Joined, not resolved: a Worker behind a proxy may answer under a path prefix, which `new URL(path, base)` drops.
      const url = `${options.workerUrl.replace(/\/+$/, "")}${fillPath(route.path, args.path)}${queryString(args.query)}`;
      const body = args.body === undefined ? new Uint8Array(0) : new TextEncoder().encode(JSON.stringify(args.body));
      const headers: Record<string, string> = {
        accept: "application/json",
        ...(body.byteLength > 0 ? { "content-type": "application/json" } : {}),
        ...(await options.credential.headers(route.scope, body)),
      };
      let response: Response;
      try {
        response = await send(url, {
          method: route.method,
          headers,
          ...(body.byteLength > 0 ? { body } : {}),
        });
      } catch (cause) {
        throw new UpstreamError({
          message: `${options.workerUrl} did not answer.`,
          action: "Check the Worker is deployed and reachable, then call again.",
          detail: `${route.method} ${route.path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
      }
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        // Not JSON: the text is the answer.
      }
      return { status: response.status, body: parsed };
    },
  };
}
