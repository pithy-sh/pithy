// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { audit } from "@pithy-sh/audit/src/index";
import { auth } from "@pithy-sh/auth/src/index";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { createBackend } from "@pithy-sh/core/src/createBackend";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { controlplane } from "@pithy-sh/core/src/index";
import { type OpenApiDocument, openApiDocument, type RouteGroup } from "@pithy-sh/core/src/openapi/document";
import { routeGroupsOf } from "@pithy-sh/core/src/openapi/routeGroups";
import { email } from "@pithy-sh/email/src/index";
import { i18n } from "@pithy-sh/i18n/src/index";
import { leaderboard } from "@pithy-sh/leaderboard/src/index";
import { ledger } from "@pithy-sh/ledger/src/index";
import { matchmaking } from "@pithy-sh/matchmaking/src/index";
import { media } from "@pithy-sh/media/src/index";
import { multiplayer } from "@pithy-sh/multiplayer/src/index";
import { defineRoles, organization } from "@pithy-sh/organization/src/index";
import { payments } from "@pithy-sh/payments/src/index";
import { rating } from "@pithy-sh/rating/src/index";
import { secrets } from "@pithy-sh/secrets/src/index";
import { storage } from "@pithy-sh/storage/src/index";
import { support } from "@pithy-sh/support/src/index";
import { testers } from "@pithy-sh/testers/src/index";
import { turnstile } from "@pithy-sh/turnstile/src/index";
import { filterable, vector } from "@pithy-sh/vector/src/index";
import { z } from "zod";
import { composeForSync } from "../project/composeFor";

/**
 * **The kit's own OpenAPI document — every route every capability ships, in one file (#719).**
 *
 * `pithy contract` writes an adopter's document, read off the Worker they compose. This is the kit's,
 * and nobody composes the kit: so it is composed here, once, from {@link KIT_COMPOSITION} — every
 * capability `pithy add` can write, each configured so that every route it can mount is mounted. The
 * document is committed at {@link KIT_CONTRACT_PATH} for a reader with no build step (the docs site, a
 * client generator), and `kitDocument.test.ts` fails while it is stale.
 *
 * **Assembled by the real `createBackend`, not a route registrar per package.** Each package's own
 * `routeContract.test.ts` proves its routes are described from its registrar; this proves the factories
 * an adopter calls mount what those registrars do, and that the whole set composes beside itself — one
 * `dependsOn`, one peer, one table collision away from a kit nobody can assemble.
 *
 * **One environment, `prod`.** The route table is one per environment: `@pithy-sh/auth` mounts its dev
 * sign-in in `dev` and nowhere else, so the table a shipped client calls is the production one, and that
 * route is in no published contract. Composed under {@link composeForSync} for the reason every assembly
 * in this CLI is: a capability reads the environment while its routes register.
 *
 * Undescribed routes are omitted rather than marked (`openApiDocument`'s default), because for the kit an
 * undescribed route is a bug: `undescribedRoutes` over {@link kitRouteGroups} is held to empty by the test.
 */

/** Where the kit's document is committed, relative to the repository root. */
export const KIT_CONTRACT_PATH = "docs/openapi.generated.json";

/** The environment the kit is composed for: the route table a shipped client calls. */
export const KIT_CONTRACT_ENVIRONMENT = "prod";

/** An example origin. Every URL below is configuration a route reads at request time, never at mount. */
const ORIGIN = "https://app.example.com";

/**
 * The organization capability refuses to be composed without the adopter's role catalog, and mounts its
 * three ownership-transfer routes only when the pair a transfer moves is named — so both are given, and
 * the catalog is the smallest one that has an owner to transfer.
 */
const ORGANIZATION_ROLES = defineRoles({
  powers: [],
  roles: {
    member: ["organization:read"],
    admin: ["organization:read", "organization:manage"],
    owner: ["organization:read", "organization:manage", "members:manage", "billing:manage", "organization:delete"],
  },
  administrativePower: "organization:manage",
  nests: ["member", "admin", "owner"],
  unassignable: ["owner"],
});

/**
 * **Every capability in the kit, and the call that composes it with its whole route surface.** One row per
 * `CATALOG` entry, `controlplane` included; `kitDocument.test.ts` fails, naming it, on a catalog entry with
 * no row here.
 *
 * Each config is the smallest that mounts every route the capability has, and says which choice that took
 * where a route is conditional. A row is a function so each composition gets fresh instances.
 */
export const KIT_COMPOSITION: Readonly<Record<string, () => Capability>> = {
  // The admin surface every other capability's admin routes are gated by, and its own manifest routes.
  controlplane: () => controlplane(),
  secrets: () => secrets({ registry: {} }),
  email: () => email({ fromAddress: "noreply@example.com", baseUrl: ORIGIN }),
  // Its dev sign-in mounts in a `dev` composition only, so the `prod` document has no route for it.
  auth: () => auth({ baseURL: ORIGIN, trustedOrigins: [ORIGIN] }),
  // Contributes middleware and a translator, and no route.
  i18n: () => i18n(),
  // Contributes a gate on other capabilities' routes, and no route of its own.
  turnstile: () => turnstile(),
  audit: () => audit(),
  // The share-link route mounts at its own path (`/s` by default) beside the object routes.
  storage: () => storage(),
  media: () => media(),
  leaderboard: () => leaderboard({ boards: [{ key: "high-score", direction: "desc" }] }),
  multiplayer: () =>
    multiplayer({
      games: [
        {
          key: "battle",
          kind: "battle",
          rules: {
            offense: {
              pick: 1,
              moves: [
                { name: "fire", power: 10 },
                { name: "ice", power: 8 },
              ],
            },
            defense: {
              pick: 1,
              moves: [
                { name: "guard-fire", blocks: "fire" },
                { name: "guard-ice", blocks: "ice" },
              ],
            },
          },
        },
      ],
    }),
  rating: () =>
    rating({
      games: [
        {
          key: "duel",
          algorithm: "elo",
          xp: { win: 20, draw: 10, loss: 5 },
          levels: [
            { key: "rookie", from: 0 },
            { key: "pro", from: 15 },
          ],
        },
      ],
    }),
  matchmaking: () => matchmaking({ games: [{ key: "duel", players: 2, snapshot: { kind: "connect-n", rules: {} } }] }),
  ledger: () => ledger({ currencies: [{ code: "chips", name: "Chips" }] }),
  vector: () =>
    vector({
      indexes: {
        docs: {
          model: "@cf/baai/bge-base-en-v1.5",
          dimensions: 768,
          metadata: z
            .object({
              ownerId: filterable(z.string().describe("The document's owner.")),
              title: z.string().describe("The document's title."),
            })
            .describe("What each document carries beside its vector."),
        },
      },
    }),
  // Every rail's webhook mounts whatever the catalog sells; three rails on so the catalog is a real one.
  payments: () =>
    payments({
      billingSubject: "user",
      rails: { apple: true, google: true, stripe: true },
      stripe: {
        successUrl: `${ORIGIN}/thanks?session={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${ORIGIN}/pricing`,
        portalReturnUrl: `${ORIGIN}/account`,
      },
      products: {
        pro_monthly: {
          type: "subscription",
          name: "Pro",
          entitlements: ["pro"],
          apple: { productId: "com.example.pro.monthly" },
          google: { productId: "pro_monthly" },
          stripe: { priceId: "price_example" },
        },
      },
    }),
  // The customer-facing submission route mounts while `submission.enabled` is on, which is its default.
  support: () => support({ inboundAddresses: ["support@example.com"] }),
  testers: () => testers({ baseUrl: ORIGIN }),
  // The ownership pair is what mounts the three transfer routes.
  organization: () =>
    organization({ baseUrl: ORIGIN, roles: ORGANIZATION_ROLES, ownership: { confers: "owner", demotesTo: "admin" } }),
};

/** `@pithy-sh/cli`'s own version, read the way `main.ts` reads it: the document is published with the CLI. */
export function kitVersion(): string {
  const { version } = z
    .object({ version: z.string().describe("The package's version.") })
    .describe("The one field read from the CLI's package.json.")
    .parse(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")));
  return version;
}

/** The whole kit, assembled by `createBackend` for {@link KIT_CONTRACT_ENVIRONMENT}, as its route groups. */
export function kitRouteGroups(): readonly RouteGroup[] {
  return composeForSync(KIT_CONTRACT_ENVIRONMENT, () => {
    const app = createBackend({ capabilities: Object.values(KIT_COMPOSITION).map((compose) => compose()) });
    const groups = routeGroupsOf(app);
    if (groups === undefined) {
      throw new InternalError({ detail: "createBackend assembled an app without recording its route groups." });
    }
    return groups;
  });
}

/** The kit's OpenAPI document, built from {@link kitRouteGroups}. */
export function kitDocument(groups: readonly RouteGroup[] = kitRouteGroups()): OpenApiDocument {
  return openApiDocument(
    {
      title: "Pithy",
      version: kitVersion(),
      description: `Every HTTP route the Pithy kit ships, each tagged with the capability that mounts it, as composed for \`${KIT_CONTRACT_ENVIRONMENT}\`. A Worker serves the routes of the capabilities it composes; \`pithy contract\` writes that Worker's own document. Generated by packages/cli/src/openapi/writeKitDocument.ts. Do not edit by hand; run \`bun run kit-contract\`.`,
    },
    groups,
  );
}
