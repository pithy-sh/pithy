// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * How mail leaves the email host worker when that worker is running on a developer's machine.
 *
 * The point of the local loop is a magic link that **arrives** (pithy-sh/pithy#410). Until now it
 * could not: `pithy dev` never ran the email host at all, so a sign-in wrote a row that said
 * `pending` and a screen that said "check your inbox". With the host in the dev set, one flag decides
 * what its `send_email` binding does — and the default is the one that ends the loop.
 *
 * Both settings run the Worker locally. Neither is a transport of ours: `wrangler dev` implements the
 * binding either way, and there is no REST or SMTP sender in this kit (that stays out of scope until
 * a context with no binding at all needs one).
 */

/** What the host's `send_email` binding does under `pithy dev`. */
export const DevMailDelivery = z
  .enum(["remote", "simulator"])
  .describe(
    "How email is delivered when the host worker runs under `pithy dev`. **`remote` is the default, and it sends real mail from the developer's machine** — `remote: true` on the `send_email` binding runs the Worker locally and delivers through Cloudflare Email Service, so the message lands in a real inbox with the same DKIM and the same delivery logs as production. It needs a Cloudflare login `wrangler dev` can use and a sending domain already onboarded onto Email Service. `simulator` sends nothing: `wrangler dev` logs the sender, recipient and subject and writes the rendered HTML and text bodies to disk, which is what an offline machine and CI want. Choose `simulator` deliberately — the cost of `remote` is that a test sign-in really does reach whatever address it was given.",
  );
export type DevMailDelivery = z.infer<typeof DevMailDelivery>;

/** The local environment. The only one this flag governs; every other one deploys and delivers for real. */
const DEV_ENVIRONMENT = "dev";

/** The `send_email` binding name the committed host template declares. */
const SEND_BINDING = "EMAIL";

/**
 * Which bindings the resolved host config must mark `remote: true`, for one environment.
 *
 * The committed template no longer hardcodes the flag, because a hardcoded `true` cannot be turned
 * off: `resolveWorkflowHost` only ever *adds* `remote`, so a template that already carried it left no
 * way to select the simulator. The decision moved here, where the capability's config can reach it.
 *
 * Outside `dev` the answer is always `remote: true`. A deployed Worker ignores the flag entirely —
 * it is a `wrangler dev` instruction — so the resolved config for `staging` and `prod` is byte-
 * identical whatever an adopter chose for their laptop.
 */
export function emailRemoteBindings(env: string, delivery: DevMailDelivery): readonly string[] {
  if (env === DEV_ENVIRONMENT && delivery === "simulator") return [];
  return [SEND_BINDING];
}
