// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The package entrypoint — the surface `pithy add consent` wires into `pithy.config.ts`. Deliberately narrow: the
 * capability factory and its config. Every other module is imported by deep path (`@pithy-sh/consent/src/...`);
 * this is the documented contract, not a barrel over the package.
 */

export {
  CONSENT_MIGRATION_ORDER,
  type ConsentCapability,
  consent,
  isConsentCapability,
} from "./capability";
export { ConsentConfig, type ConsentConfigInput } from "./config/config";
