// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineConfig } from "tsdown";
import { libraryBuild } from "../../tooling/build/src/tsdown.ts";

// Repository tooling, never a deep import, kept out of the published build and, as `libraryBuild` requires,
// out of `tsconfig.build.json` and the tarball too. The kit's own OpenAPI document is built from every
// capability package, most of which the CLI holds as devDependencies only, and `bun run kit-contract` runs its
// builder and writer. The comment-history ratchet imports `typescript`, a devDependency, and runs from its
// test and `scripts/comment-history.ts`.
export default defineConfig(
  libraryBuild({
    exclude: ["src/openapi/kitDocument.ts", "src/openapi/writeKitDocument.ts", "src/ci/commentHistory.ts"],
  }),
);
