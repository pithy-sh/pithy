// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";

/**
 * Bundle the quote core into one classic script a static site can load.
 *
 * **IIFE, not ESM, and that is the requirement rather than a preference.** The consumer is a hand-written
 * marketing page with no bundler and no import map; `<script src>` is the whole of what it can do. So the
 * artifact resolves nothing at load time and declares nothing on the page but `window.pithyPaddlePrices`.
 *
 * `@paddle/paddle-js` is bundled in rather than left external — it is 20 kB of loader whose entire job is
 * to fetch `cdn.paddle.com/paddle/v2/paddle.js` once and hand back `window.PaddleBillingV1`. Inlining it
 * is what makes "no dependency beyond Paddle's own script" true: one file from this project, one file
 * from Paddle, and nothing else on the page.
 */

/** The one file a site loads. */
export const PADDLE_PRICES_BUNDLE = "paddle-prices.iife.js";

/** What it is built from. Resolved against this file so the build does not depend on the caller's cwd. */
const ENTRY = fileURLToPath(new URL("../src/client/paddlePrices.iife.ts", import.meta.url));

/** Build the bundle into `outDir`, and answer with the path it was written to. */
export async function buildPaddlePricesBundle(outDir: string): Promise<string> {
  const file = join(outDir, PADDLE_PRICES_BUNDLE);
  await build({
    input: ENTRY,
    output: { format: "iife", file, minify: true, sourcemap: false },
    write: true,
  });
  return file;
}
