// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Write `dist/paddle-prices.iife.js`, the browser build a static site loads.
 *
 * Run by `bun run build`, after `tsc`. The logic is `./pricesBundle`, which is where the tests are; this
 * is the wiring, and it is a separate file so importing the builder does not write anything.
 */
import { fileURLToPath } from "node:url";
import { buildPaddlePricesBundle } from "./paddlePricesBundle";

const written = await buildPaddlePricesBundle(fileURLToPath(new URL("../dist", import.meta.url)));

console.log(`Wrote ${written}`);
