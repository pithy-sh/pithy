import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import type { z } from "zod";
import { PaymentsEntitlement } from "./entitlement";
import { PaymentsProviderAccount } from "./providerAccount";
import { PaymentsPurchase } from "./purchase";
import { PaymentsWebhookEvent } from "./webhookEvent";

/** The projection of provider truth. `CamelCasePlugin` snake-cases it to `pithy_payments_purchases`. */
export const PAYMENTS_PURCHASES_TABLE = "pithyPaymentsPurchases";
/** The materialized read model `requireEntitlement()` hits. → `pithy_payments_entitlements`. */
export const PAYMENTS_ENTITLEMENTS_TABLE = "pithyPaymentsEntitlements";
/** Provider identity → Pithy user. → `pithy_payments_provider_accounts`. */
export const PAYMENTS_PROVIDER_ACCOUNTS_TABLE = "pithyPaymentsProviderAccounts";
/** Raw received notifications, the replay source. → `pithy_payments_webhook_events`. */
export const PAYMENTS_WEBHOOK_EVENTS_TABLE = "pithyPaymentsWebhookEvents";

/** The payments tables map. All four are always present — none is behind a config flag. */
export function paymentsTables(): Record<string, z.ZodObject> {
  return {
    [PAYMENTS_PURCHASES_TABLE]: PaymentsPurchase,
    [PAYMENTS_ENTITLEMENTS_TABLE]: PaymentsEntitlement,
    [PAYMENTS_PROVIDER_ACCOUNTS_TABLE]: PaymentsProviderAccount,
    [PAYMENTS_WEBHOOK_EVENTS_TABLE]: PaymentsWebhookEvent,
  };
}

/** The typed Kysely database over the payments tables. */
export type PaymentsTables = {
  [PAYMENTS_PURCHASES_TABLE]: typeof PaymentsPurchase;
  [PAYMENTS_ENTITLEMENTS_TABLE]: typeof PaymentsEntitlement;
  [PAYMENTS_PROVIDER_ACCOUNTS_TABLE]: typeof PaymentsProviderAccount;
  [PAYMENTS_WEBHOOK_EVENTS_TABLE]: typeof PaymentsWebhookEvent;
};
export type PaymentsDatabase = Kysely<DatabaseSchema<PaymentsTables>>;

/** Build the payments database from the `DB` binding (CamelCasePlugin installed). */
export function paymentsDatabase(d1: D1Database): PaymentsDatabase {
  return createDatabase(d1, {
    [PAYMENTS_PURCHASES_TABLE]: PaymentsPurchase,
    [PAYMENTS_ENTITLEMENTS_TABLE]: PaymentsEntitlement,
    [PAYMENTS_PROVIDER_ACCOUNTS_TABLE]: PaymentsProviderAccount,
    [PAYMENTS_WEBHOOK_EVENTS_TABLE]: PaymentsWebhookEvent,
  }) as unknown as PaymentsDatabase;
}
