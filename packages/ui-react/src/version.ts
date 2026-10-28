// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * This package's own version, read from its manifest beside `src/` and `dist/` alike. A scaffold whose screens
 * import `useRead` and `<Redirect>` from here declares its range from it.
 */
export const UI_REACT_VERSION: string = (
  JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;
