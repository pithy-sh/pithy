// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The quantity a store stated, or null — never a default.
 *
 * Every rail but one parses a quantity that is sometimes absent: a metered Stripe price carries none, a Paddle
 * line on an old shape carries none, a Play one-time purchase of one omits it. Writing `1` for absent would
 * invent a fact the store did not state, and a seat count read off it would be a number nobody reported.
 * So a positive whole number crosses and anything else is null.
 */
export function statedQuantity(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}
