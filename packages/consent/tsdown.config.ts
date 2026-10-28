// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineConfig } from "tsdown";
import { libraryBuild } from "../../tooling/build/src/tsdown.ts";

export default defineConfig(libraryBuild());
