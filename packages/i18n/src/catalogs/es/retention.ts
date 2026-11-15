// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT
//
// LOCALE es — an unreviewed first pass. Not American English by design.

import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";

/**
 * Why a deleted account's rows are kept, in Spanish — each capability's retained purge basis, read back to the person
 * in their export.
 *
 * The English is each capability's own `messages`, beside the contribution that states the basis. `email/` is not
 * here: `@pithy-sh/email` carries its Spanish beside its English.
 */
export const esRetention: MessageCatalog = {
  "audit/purge.retained":
    "Se conservan como registro de quién hizo qué, que es lo que se consulta en una revisión de seguridad o en una disputa.",
  "consent/purge.retained":
    "Se conservan como prueba de lo que aceptaste y de cuándo lo retiraste, algo que la ley nos pide poder demostrar.",
  "controlplane/purge.retained":
    "Se conservan como constancia de que hubo una retención legal, de cuándo se impuso y de por qué terminó.",
  "payments/purge.retained":
    "Se conservan por obligaciones fiscales y contables: la ley exige a una empresa guardarlos después de cerrar una cuenta.",
};
