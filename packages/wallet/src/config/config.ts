import { z } from "zod";

/**
 * The wallet capability's config — the thin, user-owned surface in `pithy.config.ts`. Every field is
 * `.describe()`d: the descriptions feed the self-documenting CLI (CLAUDE.md §Config).
 *
 * A wallet is a per-user balance ledger for whatever an app's economy runs on — chips, gold, gems,
 * credits, tokens. It is currency-agnostic and holds no opinion about whether those units map to money;
 * that (and any regulation around it) is the adopter's concern. **Amounts are integers in a currency's
 * minor unit** — never floats — so arithmetic is exact; a currency's `decimals` only says how to *display*
 * them. Every mutation is atomic, idempotent on a caller-supplied `ref`, and overdraft-protected by a
 * database `CHECK` constraint, because a wallet that can double-spend or go negative is not a wallet.
 */

/** A currency code is a short identifier used in URLs and keys, so it is lowercase, digits, and dashes. */
const CURRENCY_CODE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const WalletCurrency = z
  .object({
    code: z
      .string()
      .regex(CURRENCY_CODE_PATTERN, "A currency code is lowercase, digits, and dashes.")
      .describe("The currency's stable id — `chips`, `gold`, `credits`. A path segment and an account key."),
    name: z.string().min(1).describe("The human-readable name shown to players — `Casino Chips`, `Gold`."),
    decimals: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        "How many decimal places this currency displays. Balances are always stored as integers in the minor unit; `decimals: 2` means a stored `150` displays as `1.50`. Whole chips are `0`.",
      ),
  })
  .describe("One currency an app's economy runs on — a code, a display name, and a display scale.");
export type WalletCurrency = z.output<typeof WalletCurrency>;

export const WalletConfig = z
  .object({
    currencies: z
      .array(WalletCurrency)
      .min(1, "A wallet with no currencies does nothing — configure at least one.")
      .describe("Every currency this app's wallet holds. Currencies are config, not database rows."),
    adminScope: z
      .string()
      .min(1)
      .default("wallet:admin")
      .describe(
        "The AuthContext scope a session must carry to credit or debit another player's balance over HTTP. Balance-moving writes are server-authoritative — mint this scope for your trusted server's token, never a player's. Players can always read their own balance without it.",
      ),
  })
  .describe("Configuration for the wallet capability — the set of currencies an app's economy runs on.")
  .check((ctx) => {
    const codes = ctx.value.currencies.map((currency) => currency.code);
    const duplicates = [...new Set(codes.filter((code, i) => codes.indexOf(code) !== i))];
    if (duplicates.length > 0) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["currencies"],
        message: `Duplicate currency codes: ${duplicates.join(", ")}. Two currencies sharing a code would merge their balances.`,
      });
    }
  });
export type WalletConfig = z.output<typeof WalletConfig>;
export type WalletConfigInput = z.input<typeof WalletConfig>;

/** The currency with this code, or undefined. Codes come from config, so an unknown code is a 404. */
export function resolveCurrency(config: WalletConfig, code: string): WalletCurrency | undefined {
  return config.currencies.find((currency) => currency.code === code);
}
