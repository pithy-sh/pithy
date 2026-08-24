// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT
//
// LOCALE es — an unreviewed first pass. Not American English by design.

import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { esErrors } from "./errors";
import { esScreens } from "./screens";

/**
 * The kit's Spanish, in one catalog.
 *
 * Two files rather than one because they answer to different gates: the error keys are pinned to
 * `KitErrorCode` and the screen keys to what the templates render. Split, a failure names which of
 * the two drifted.
 *
 * **The email copy is not here, and that is deliberate (#442).** `@pithy-sh/email` carries its own
 * `email/` translations beside its English, because the send Worker has to be *built* with them —
 * anything it does not bundle is stamped into it as configuration, every provision run, against a
 * 5 KB per-variable ceiling. A capability owning its own domain in every language is also what the
 * domain rule already says; this package holds what no capability can, which is the error taxonomy
 * and the copied screens.
 *
 * **This copy is a marked first pass and no native-speaker review blocks it.** Every file in this
 * directory says so in its head, in the marker `docs/I18N.md` publishes. The brand voice is
 * load-bearing in English and a literal translation does not carry it; saying so in the file is
 * honest, and holding the machinery hostage to a reviewer who does not yet exist is not. Corrections
 * arrive by contribution.
 */
export const es: MessageCatalog = { ...esErrors, ...esScreens };
