// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { artifacts } from "@pithy-sh/artifacts/src/index";
import { audit } from "@pithy-sh/audit/src/index";
import { auth, mcp } from "@pithy-sh/auth/src/index";
import { consent } from "@pithy-sh/consent/src/index";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { controlplane } from "@pithy-sh/core/src/index";
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

/**
 * **The reference Worker's composition: every capability in the kit, each with its whole route surface.**
 *
 * The startup gate measures a Worker composing all of these, so a capability that starts paying for
 * something at startup shows up in the measurement whichever capability it is. It holds the same rows as
 * the kit's OpenAPI composition (`@pithy-sh/cli/src/openapi/kitDocument.ts`), and `composition.test.ts`
 * fails on a catalog entry missing here. It imports only the factories an adopter calls, so the gate can
 * compose it over the base commit's packages as well as this tree's.
 */

/** An example origin. Every URL below is configuration a route reads at request time, never at mount. */
const ORIGIN = "https://app.example.com";

/**
 * The organization capability refuses to be composed without the adopter's role catalog, and mounts its
 * three ownership-transfer routes only when the pair a transfer moves is named — so both are given, and
 * the catalog is the smallest one that has an owner to transfer.
 */
const ORGANIZATION_ROLES = defineRoles({
  // The power the artifacts capability is configured to gate an organization's repositories on.
  powers: ["repos:manage"],
  roles: {
    member: ["organization:read"],
    admin: ["organization:read", "organization:manage"],
    owner: [
      "organization:read",
      "organization:manage",
      "members:manage",
      "billing:manage",
      "organization:delete",
      "media:manage",
      "storage:manage",
      "repos:manage",
    ],
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
export const REFERENCE_COMPOSITION: Readonly<Record<string, () => Capability>> = {
  // The admin surface every other capability's admin routes are gated by, and its own manifest routes.
  controlplane: () => controlplane(),
  secrets: () => secrets({ registry: {} }),
  email: () => email({ fromAddress: "noreply@example.com", baseUrl: ORIGIN }),
  // Its dev sign-in mounts in a `dev` composition only, so the `prod` document has no route for it. The attestation
  // routes, the challenge and the iOS key registration, mount once any environment has an attestation block.
  auth: () =>
    auth({
      baseURL: ORIGIN,
      trustedOrigins: [ORIGIN],
      attestation: { environments: { prod: { ios: [{ teamId: "ABCDE12345", bundleId: "com.example.app" }] } } },
    }),
  // Contributes middleware and a translator, and no route.
  i18n: () => i18n(),
  // Contributes a gate on other capabilities' routes, and no route of its own.
  turnstile: () => turnstile(),
  audit: () => audit(),
  consent: () => consent(),
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
        // Every built-in model, so the socket document carries each one's action and view schemas.
        { key: "connect-four", kind: "connect-n", rules: { rows: 6, cols: 7, connect: 4 } },
        {
          key: "craps-table",
          kind: "craps",
          mode: "table",
          players: 8,
          rules: { currency: "chips", minBet: 5, maxBet: 100 },
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
      entitlements: { pro: { name: "Pro" } },
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
  // A managePower, so the organization routes mount beside `organization` above.
  artifacts: () => artifacts({ managePower: "repos:manage" }),
  // Open to every signed-in user here, which mounts the same routes any floor does.
  mcp: () => mcp({ floor: "signed-in" }),
};
