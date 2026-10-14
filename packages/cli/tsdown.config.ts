// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineConfig } from "tsdown";
import { libraryBuild } from "../../tooling/build/src/tsdown.ts";

// The kit's own OpenAPI document is built from every capability package, most of which the CLI holds as
// devDependencies only. Its builder and writer are repository tooling run by `bun run kit-contract`, never
// a deep import, so they are kept out of the published build — and, as `libraryBuild` requires, out of
// `tsconfig.build.json` and the tarball too (#719).
export default defineConfig(
  libraryBuild({ exclude: ["src/openapi/kitDocument.ts", "src/openapi/writeKitDocument.ts"] }),
);
