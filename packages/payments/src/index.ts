/**
 * The package entrypoint — the surface `pithy add payments` wires into `pithy.config.ts`. Deliberately
 * narrow: the capability factory, its catalog types and lookups, the four table schemas, and the projection
 * writer and read path other capabilities and the Workflow host call. Every other module is reached by deep
 * path (`@pithy-sh/payments/src/...`); this is the documented contract, not a barrel over the package.
 *
 * The client modules are **not** here, and must not be. `src/client/hooks.ts` imports `react`, and
 * re-exporting it would drag React into every Worker bundle that composes payments; `src/client/api.ts` is
 * its framework-free half and belongs to the same browser surface. Both are reached by their own deep
 * path — `@pithy-sh/payments/src/client/hooks`.
 */

export { type PaymentsAuditAction, PaymentsAuditActions } from "./audit/actions";
export {
  isPaymentsCapability,
  PAYMENTS_MIGRATION_ORDER,
  type PaymentsCapability,
  type PaymentsOptions,
  payments,
} from "./capability";
export {
  entitlementsForProduct,
  PaymentsAppleProduct,
  type PaymentsCatalogEntry,
  PaymentsConfig,
  type PaymentsConfigInput,
  PaymentsGoogleProduct,
  PaymentsGrants,
  PaymentsLedgerGrant,
  PaymentsProduct,
  PaymentsProductType,
  PaymentsRailToggles,
  PaymentsStripeProduct,
  PaymentsStripeSettings,
  productForProviderSku,
  providerProductId,
  railEnabled,
  resolveProduct,
} from "./config/config";
export { PaymentsEntitlement } from "./data/entitlement";
export { minorUnitDigits, minorUnitsFromScaled } from "./data/money";
export { PaymentsProviderAccount } from "./data/providerAccount";
export { PaymentsPurchase, PurchaseEnvironment } from "./data/purchase";
export { PAYMENTS_RAILS, PaymentsRail } from "./data/rail";
export { ACCESS_GRANTING_STATUSES, grantingStatuses, PurchaseStatus, statusGrantsAccess } from "./data/status";
export {
  PAYMENTS_ENTITLEMENTS_TABLE,
  PAYMENTS_PROVIDER_ACCOUNTS_TABLE,
  PAYMENTS_PURCHASES_TABLE,
  PAYMENTS_WEBHOOK_EVENTS_TABLE,
  type PaymentsDatabase,
  paymentsDatabase,
  paymentsTables,
} from "./data/tables";
export { PaymentsWebhookEvent } from "./data/webhookEvent";
export {
  grantEntitlement,
  type ManualEntitlementInput,
  type ManualEntitlementOptions,
  revokeEntitlement,
} from "./entitlement/manual";
export {
  createPaymentsEntitlementResolver,
  installEntitlementResolver,
  PAYMENTS_ENTITLEMENT_PROVIDER,
} from "./entitlement/resolver";
export {
  type AppliedGrant,
  applyGrants,
  type FulfillmentReport,
  type FulfillPurchaseOptions,
  fulfillPurchase,
  type GrantOptions,
  grantRef,
  ledgerGrantFor,
  purchaseIsPaid,
} from "./grants/apply";
export { type ClawbackOutcome, clawbackGrants, clawbackRef } from "./grants/clawback";
export {
  type OpenPaymentsLedgerOptions,
  openPaymentsLedger,
  type PaymentsLedger,
  type PaymentsLedgerLoader,
} from "./grants/ledgerSeam";
export { PAYMENTS_RECONCILE_KEY, triggerPaymentsReconcile } from "./http/dispatch";
export {
  PAYMENTS_CONTROL_PLANE_SCOPES,
  PAYMENTS_ENTITLEMENT_GRANT_SCOPE,
  PAYMENTS_ENTITLEMENT_REVOKE_SCOPE,
  requireAuth,
} from "./http/guards";
export { type PaymentsRoutesOptions, registerPaymentsRoutes } from "./http/routes";
export {
  AppleWebhookNotification,
  CheckoutRequest,
  EntitlementGrantRequest,
  EntitlementRevokeRequest,
  GoogleWebhookNotification,
  PurchaseSubmission,
  RestoreRequest,
  StripeWebhookNotification,
} from "./http/schemas";
export { ProviderEvent, type ProviderEventInput } from "./projection/event";
export {
  type LinkProviderAccountOptions,
  linkProviderAccount,
  type OwnerHints,
  providerAccountForUser,
  resolveNotificationOwner,
} from "./projection/owner";
export { resolveEntitlements } from "./projection/resolve";
export { type ProjectPurchaseOptions, type PurchaseProjection, projectPurchase } from "./projection/writer";
export {
  type PaymentsConfigParams,
  paymentsWorkerName,
  resolvePaymentsConfig,
} from "./provision/resolvePaymentsConfig";
export { APPLE_ROOT_CERTIFICATES } from "./rails/apple/certs";
export type { AppleHttpFetch, AppleHttpRequest, AppleHttpResponse } from "./rails/apple/http";
export {
  APPLE_API_AUDIENCE,
  APPLE_API_BASES,
  AppleSubscriptionStatuses,
  appleSubscriptionStatus,
  mintAppleApiToken,
} from "./rails/apple/serverApi";
export {
  type CheckoutRail,
  type CheckoutSessionInput,
  type HostedSession,
  isCheckoutRail,
  type PaymentsRailProvider,
  type PortalSessionInput,
  type RailRequestContext,
  type UnboundProviderEvent,
  type VerifiedNotification,
  type VerifiedPurchase,
  type WebhookDelivery,
} from "./rails/contract";
export type { GoogleHttpFetch, GoogleHttpRequest, GoogleHttpResponse } from "./rails/google/http";
export { GOOGLE_JWKS_URL, GOOGLE_OIDC_ISSUERS, GoogleJwk, GoogleJwks } from "./rails/google/oidc";
export { implementedRails, type RailTrustOptions, resolveRailProvider } from "./rails/providers";
export {
  STRIPE_API_VERSION,
  type StripeHttpFetch,
  type StripeHttpRequest,
  type StripeHttpResponse,
} from "./rails/stripe/api";
export { STRIPE_METADATA_ACCOUNT_REFERENCE, STRIPE_METADATA_PRICE } from "./rails/stripe/objects";
export {
  PAYMENTS_PROVIDER_SECRET,
  PaymentsAppleCredentials,
  PaymentsGoogleCredentials,
  PaymentsProviderCredentials,
  PaymentsStripeCredentials,
  paymentsSecretsRegistry,
  railCredentials,
} from "./secret/registry";
export { paymentsExampleSeed } from "./seeds/example";
export {
  batchedRailAccess,
  type RailAccessOptions,
  type ReconcileRailAccess,
} from "./workflows/railAccess";
export {
  type ReconcileDeps,
  type ReconcileReport,
  type ReconcileStep,
  reconcilePayments,
} from "./workflows/reconcile";
export {
  DEFAULT_EXPIRING_WITHIN_SECONDS,
  DEFAULT_STALE_AFTER_SECONDS,
  PAYMENTS_CAPABILITY,
  PaymentsReconcileParams,
  paymentsWorkflowRegistry,
  paymentsWorkflows,
} from "./workflows/specs";
