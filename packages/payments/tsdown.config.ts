// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineConfig } from "tsdown";
import { libraryBuild } from "../../tooling/build/src/tsdown.ts";

// `src/client/paddlePrices.iife.ts` is the entry of the browser bundle `scripts/buildPaddlePrices.ts`
// writes, not a module anyone imports — and `tsconfig.build.json` excludes it for the same reason.
export default defineConfig(libraryBuild({ exclude: ["src/client/paddlePrices.iife.ts"] }));
