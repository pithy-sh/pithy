// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The package entrypoint — the surface `pithy add email` wires into `pithy.config.ts`. Deliberately
 * narrow: the capability factory plus the enqueue API and the types an app needs to send mail. Every
 * other module is imported by deep path (`@pithy-sh/email/src/...`); this is the documented contract,
 * not a barrel over the package.
 */

export { type CampaignStats, campaignStats } from "./analytics";
export { type EmailCapability, type EmailConfigInput, email, isEmailCapability } from "./capability";
export { type EnqueueInput, type EnqueueResult, enqueueEmail } from "./send/enqueue";
export { listTemplates } from "./templates/engine";
