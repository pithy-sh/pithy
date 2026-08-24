// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { LocaleCatalogs } from "@pithy-sh/core/src/i18n/catalog";
import { es } from "./es/index";

/**
 * The kit's own translations, keyed by locale — every locale but the one the kit is written in.
 *
 * **There is no `en` here, and that is not an omission.** English is the source: an error carries its
 * English `message` on the wire already, a kit capability contributes its English through
 * `Capability.messages`, and a copied screen carries the English it was scaffolded with. A second copy
 * of it in this map would be a second place for the same sentence to drift.
 *
 * **These ship in the package and are never copied into an adopter's repository.** If the Spanish for
 * `auth/sign_in.title` lived in their tree, a typo fix or a new locale could never reach them, and
 * every adopter would become a fork on the day they scaffolded. An adopter overrides a sentence by
 * passing one entry to `i18n({ messages })`; passing a whole locale object **is** the fork, which is
 * why no eject command is needed for this and none is offered.
 *
 * Server-side this map is imported statically — it is text, it is small, and a Worker has no second
 * round trip to spend. The browser reaches the same catalogs by dynamic import, one chunk per locale;
 * see `./browser`.
 */
export const KIT_CATALOGS: LocaleCatalogs = { es };
