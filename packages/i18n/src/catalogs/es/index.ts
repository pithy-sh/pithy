// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT
//
// LOCALE es — an unreviewed first pass. Not American English by design.

import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { esEmail } from "./email";
import { esErrors } from "./errors";
import { esScreens } from "./screens";

/**
 * The kit's Spanish, in one catalog.
 *
 * Three files rather than one because they answer to three different gates: the error keys are pinned
 * to `KitErrorCode`, the screen keys to what the templates render, and the email keys to what the
 * template registry composes. Split, a failure names which of the three drifted.
 *
 * **This copy is a marked first pass and no native-speaker review blocks it.** Every file in this
 * directory says so in its head, in the marker `docs/I18N.md` publishes. The brand voice is
 * load-bearing in English and a literal translation does not carry it; saying so in the file is
 * honest, and holding the machinery hostage to a reviewer who does not yet exist is not. Corrections
 * arrive by contribution.
 */
export const es: MessageCatalog = { ...esErrors, ...esScreens, ...esEmail };
