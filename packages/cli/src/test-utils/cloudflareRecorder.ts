// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **A Cloudflare account that answers reads and records every write (#697).**
 *
 * `--dry-run` promises that nothing is called that writes, and a promise like that is only tested by
 * something that would notice the call. This stands in for `cloudflareClients`: every manager it hands out
 * answers a read — a method whose name starts `list`, `get`, `find` or `exists`, or one of the few reads named
 * otherwise, such as `accountSubdomain` — with nothing, and records
 * any other call as a write before refusing it. A test mocks `cloudflare/clients` with {@link recorder}'s
 * `clients` and asserts `writes` is empty.
 *
 * Reads are allowed because a plan is built from them: `worker rename` asks the account whether the old
 * script is live before it plans anything, exactly as the real run does.
 */

const READ = /^(list|get|find|exists)/;
/** Reads whose names do not say so: the account's `workers.dev` subdomain is a `GET`. */
const NAMED_READS = new Set(["accountSubdomain"]);

export interface CloudflareRecorder {
  /** Every call made, as `manager.method`. */
  readonly calls: string[];
  /** The calls that were not reads. */
  readonly writes: string[];
  /** A `cloudflareClients` stand-in. */
  clients: () => Promise<unknown>;
}

export function recorder(): CloudflareRecorder {
  const calls: string[] = [];
  const writes: string[] = [];
  const manager = (name: string): unknown =>
    new Proxy(
      {},
      {
        get: (_target, method) => {
          if (typeof method !== "string" || method === "then") return undefined;
          return async () => {
            const call = `${name}.${method}`;
            calls.push(call);
            if (READ.test(method) || NAMED_READS.has(method)) return method.startsWith("list") ? [] : null;
            writes.push(call);
            throw new Error(`A dry run called ${call}, which writes.`);
          };
        },
      },
    );
  const clients = new Proxy(
    {},
    {
      get: (_target, name) => {
        if (typeof name !== "string" || name === "then") return undefined;
        return () => manager(name);
      },
    },
  );
  return { calls, writes, clients: async () => clients };
}
