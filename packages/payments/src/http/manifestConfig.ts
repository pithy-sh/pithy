// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CapabilityManifestConfig } from "@pithy-sh/core/src/controlPlane/discovery/configuration";
import { defineManifestConfig } from "@pithy-sh/core/src/controlPlane/discovery/configuration";
import { PaymentsSubjectType } from "../data/subject";

/**
 * The configured fact payments states into `GET /control-plane/manifest` (#422).
 *
 * **A management client cannot write a grant without it.** `POST {base}/entitlements/grant` names the
 * holder and never assumes it, which is right — the two kinds are different rows and different gates.
 * But `PaymentsConfig.billingSubject` is required with no default, so there is nothing a client may
 * safely assume either: guessing `user` against an organization-billed project writes a row nothing
 * reads, the call succeeds, and the person still cannot use what somebody just gave them.
 *
 * Nothing else on the wire answers it. `GET {base}/admin/catalog` returns products.
 * `PaymentsClientProjection` leaves it out deliberately and is a browser bundle besides. And
 * `GET {base}/admin/entitlements` carries a `subjectType` per *row* — evidence about who happens to hold
 * something, not a statement about what the project bills. An empty table says nothing, and a project
 * that migrated has both kinds in it.
 *
 * **Its own module rather than a block in `scopes.ts`.** That module declares nine `ControlPlaneScope`
 * constants and `tooling/browser-scopes/src/coverage.test.ts` holds every such module to type-only
 * imports, so a scope name compiles in a browser program with no Workers types. This needs
 * `defineManifestConfig` and `PaymentsSubjectType` as values, which is exactly what that gate refuses —
 * so the two live apart rather than the gate being weakened.
 */

/** The key the fact appears under. The join key a management client reads it back by. */
export const PAYMENTS_BILLING_SUBJECT = "billingSubject";

/**
 * What this project bills, stated for a client that has to name a holder.
 *
 * **Takes the resolved value rather than reading config itself**, for the same reason
 * `paymentsAdminRoutes` takes the resolved `basePath`: a declaration built from defaults describes a
 * Worker other than this one, and nothing downstream compares the two — a manifest that drifts from the
 * capability is worse than no manifest, because a client believes it.
 *
 * `choices` is read off {@link PaymentsSubjectType} rather than retyped. A third kind of holder is a
 * change to that enum, and reading it here is what makes the manifest learn about it in the same commit.
 */
export function paymentsManifestConfig(billingSubject: PaymentsSubjectType): CapabilityManifestConfig {
  return defineManifestConfig({
    keys: [
      {
        key: PAYMENTS_BILLING_SUBJECT,
        choices: [...PaymentsSubjectType.options],
        summary:
          "What kind of thing holds a purchase in this project — one person, or one organization. Every entitlement this project grants names a subject of this kind, so a client must state it rather than guess it.",
      },
    ],
    values: { [PAYMENTS_BILLING_SUBJECT]: billingSubject },
  });
}
