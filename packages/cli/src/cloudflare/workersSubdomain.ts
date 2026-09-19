// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { cloudflareClients } from "./clients";
import { type CloudflareAccountSelection, cloudflareCredentials } from "./config";

/**
 * **The account's `workers.dev` subdomain, as a seam** — for the commands that need a feature's address (#643).
 *
 * The lookup itself is `CloudflareWorkersManager.accountSubdomain()`, the one the capability provisioners
 * already call to check an account can host Workflows; this does not add another. What it adds is the shape a
 * command hands down: a function, memoized, so `pithy provision --feature` asks once for every Worker it
 * stamps, `pithy seed --env feature` asks only when a prepared set wants an origin, and a test replaces the
 * whole account with one line.
 *
 * `null` for an account with no subdomain, which `accountSubdomain` already answers for the not-found case.
 * Missing credentials are `cloudflareCredentials`' refusal, said the way every other command says it.
 */
export function accountWorkersSubdomain(account: CloudflareAccountSelection | null): () => Promise<string | null> {
  let pending: Promise<string | null> | undefined;
  return () => {
    pending ??= (async () => {
      const clients = await cloudflareClients(cloudflareCredentials({ account }));
      return clients.workers().accountSubdomain();
    })();
    return pending;
  };
}
