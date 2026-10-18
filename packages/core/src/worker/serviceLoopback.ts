// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { commandName } from "../cli/command";
import { UpstreamError } from "../error/pithyError";
import { ENVIRONMENT_VAR } from "./identity";

/**
 * **A service binding under `pithy dev`: the call reaches the local target on its pinned port (#617).**
 *
 * Deployed, `env.APP_B.fetch(request)` is a service binding: Cloudflare runs the call inside the runtime, into
 * the script the binding names. Locally there is no such script. `wrangler dev` would look for one in its own
 * cross-process registry — the one `pithy dev` never relies on — and a Worker started on its own with
 * `pithy dev --app app-a` would find nothing there at all. What does exist is the target itself, on the port its
 * feature pinned for it, and `pithy dev` knows that address before anything starts.
 *
 * So `pithy dev` publishes one var, {@link SERVICE_ORIGINS_VAR}: a JSON map from each service binding this
 * Worker declares to its target's local origin. Under `dev`, and only there, each of those bindings is replaced
 * with a stand-in whose `fetch` sends the same request to that origin. The call site is byte-identical either
 * way. A target that is not running refuses the connection, so the call fails at once as
 * `core/upstream_failed`, naming the binding and the address, rather than hanging on a registry lookup.
 *
 * **Only `dev`, and only what was published.** The var is written by `pithy dev` and by nothing else, and the
 * gate reads `ENVIRONMENT` off the request env as the Workflow loopback does (`workflow/dispatch.ts`): a
 * deployment that lost its `ENVIRONMENT` var never opens it.
 */

/** The var `pithy dev` publishes: each service binding's local target, as JSON. */
export const SERVICE_ORIGINS_VAR = "PITHY_SERVICE_ORIGINS";

/** The one environment the stand-in is made in. */
const LOCAL = "dev";

/** What the var carries: binding name to an `http(s)` origin. */
const ServiceOrigins = z
  .record(
    z.string().describe("A service binding's name in the Worker env."),
    z.url({ protocol: /^https?$/ }).describe("The local origin of the Worker it calls, as `pithy dev` pinned it."),
  )
  .describe("Each service binding's local target, published by `pithy dev`.");

/** The transport. The runtime's `fetch`, or a test's. */
export type ServiceLoopbackFetch = (request: Request) => Promise<Response>;

/** A Fetcher's one method that a plain `fetch` target uses. */
interface LocalService {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** A stand-in for one service binding: every request sent to `origin`, its path, method, headers and body kept. */
function localService(binding: string, origin: string, send: ServiceLoopbackFetch): LocalService {
  const target = new URL(origin);
  return {
    async fetch(input, init) {
      const request = new Request(input, init);
      const url = new URL(request.url);
      url.protocol = target.protocol;
      url.host = target.host;
      try {
        return await send(new Request(url, request));
      } catch (cause) {
        throw new UpstreamError(
          {
            message: `The Worker ${binding} calls is not answering.`,
            action: `Check that it is running under ${commandName("dev")} at ${target.origin}.`,
            detail: `${request.method} ${url.href} failed: ${String(cause)}`,
          },
          { cause },
        );
      }
    },
  };
}

/** Options for {@link withLocalServices}. */
export interface LocalServicesOptions {
  /** The transport. Defaults to the runtime's `fetch`. */
  fetch?: ServiceLoopbackFetch;
}

/**
 * The env a request runs with: under `pithy dev`, each published service binding replaced with its local
 * stand-in; anywhere else, the env unchanged — the same object, so nothing outside `dev` pays for this.
 */
export function withLocalServices(
  env: Record<string, unknown>,
  options: LocalServicesOptions = {},
): Record<string, unknown> {
  if (env[ENVIRONMENT_VAR] !== LOCAL) return env;
  const published = env[SERVICE_ORIGINS_VAR];
  if (typeof published !== "string") return env;
  let parsed: unknown;
  try {
    parsed = JSON.parse(published);
  } catch {
    return env;
  }
  const origins = ServiceOrigins.safeParse(parsed);
  if (!origins.success || Object.keys(origins.data).length === 0) return env;
  const send = options.fetch ?? ((request: Request) => fetch(request));
  const local: Record<string, unknown> = { ...env };
  for (const [binding, origin] of Object.entries(origins.data)) local[binding] = localService(binding, origin, send);
  return local;
}
