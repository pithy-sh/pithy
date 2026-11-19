// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createEntrypoint } from "@pithy-sh/core/src/createEntrypoint";
import { REFERENCE_COMPOSITION } from "./composition";

/** The reference Worker: every capability composed, exactly as an adopter's `src/index.ts` composes theirs. */
export default createEntrypoint({ capabilities: Object.values(REFERENCE_COMPOSITION).map((compose) => compose()) });
