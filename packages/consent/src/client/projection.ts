// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * What a browser may know about this project's consent — the shape of `virtual:pithy/consent`.
 *
 * **This declaration is the contract, and the projection is checked against it.** It is written here rather than
 * inferred from the closure that builds it, so widening what every adopter's bundle carries is a decision made here,
 * on purpose. The purposes, their notices and the visitor window stay on the Worker: the screen reads the catalog
 * from `GET {basePath}/purposes` at render, so a purpose changes without a rebuild.
 *
 * **This is the only statement of the shape.** `@pithy-sh/ui-react`'s `templates/client-env.d.ts` is generated from
 * this type by `@pithy-sh/vite`'s `clientEnvDeclaration.ts`, doc comments and all, and the React Native generated
 * config carries the same value for each environment.
 */
export type ConsentClientProjection =
  | {
      /** Consent is not composed on this worker. A screen branches rather than calling routes nobody serves. */
      enabled: false;
    }
  | {
      /** Consent is composed on this worker. */
      enabled: true;
      /** The path the consent routes mount under, e.g. `/consent`. The settings screen calls under it. */
      basePath: string;
    };
