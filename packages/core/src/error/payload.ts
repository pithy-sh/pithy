import { z } from "zod";

/**
 * The error object model. One Zod schema is the whole definition of every failure Pithy
 * can emit: the discriminated union `ErrorPayload` is the closed taxonomy, keyed on a
 * machine-readable `code`. The `PithyError` class (./pithyError) is only the throw/catch
 * vehicle that carries one of these payloads; the surfaces (HTTP, terminal) are encoders
 * over this schema. `.describe()` on every field feeds the generated error catalog.
 */

/** A single field-level validation failure, mirrored from a Zod issue for the wire. */
export const ValidationIssue = z
  .object({
    path: z
      .array(z.union([z.string(), z.number()]))
      .describe("Path to the offending field, e.g. ['user', 0, 'email']."),
    message: z.string().describe("Human-readable reason this field failed."),
    code: z.string().describe("Zod issue code, e.g. 'invalid_type', 'too_small'."),
  })
  .describe("A single field-level validation failure, mirrored from a ZodIssue.");
export type ValidationIssue = z.infer<typeof ValidationIssue>;

/** Fields safe to expose to clients. Present on every member, public and wire alike. */
const publicFields = {
  message: z.string().describe("Public, safe-to-expose summary. Sent to clients and shown in the terminal."),
  action: z.string().optional().describe("Remediation hint. Becomes the CLI action line."),
};

/** The internal-only field. On `ErrorPayload`, never on the public/wire shape. */
const detailField = {
  detail: z
    .string()
    .optional()
    .describe("Internal context for logs + audit. NEVER serialized to clients — the HTTP codec strips it."),
};

// One public member per code. The `code` literal is the discriminator; `status` is pinned
// to the one HTTP status that code maps to, so a mismatched pair fails validation.
const InvalidInputPublic = z
  .object({
    code: z.literal("validation/invalid_input").describe("Input failed validation at a boundary."),
    status: z.literal(400).describe("Bad Request."),
    issues: z.array(ValidationIssue).describe("Field-level validation failures."),
    ...publicFields,
  })
  .describe("Input failed validation at a boundary (400).");

const InvalidTokenPublic = z
  .object({
    code: z.literal("auth/invalid_token").describe("The bearer/session credential is missing, expired, or invalid."),
    status: z.literal(401).describe("Unauthorized."),
    ...publicFields,
  })
  .describe("The caller's credential is missing, expired, or invalid (401).");

const ForbiddenPublic = z
  .object({
    code: z.literal("auth/forbidden").describe("The caller is authenticated but not allowed to do this."),
    status: z.literal(403).describe("Forbidden."),
    ...publicFields,
  })
  .describe("The caller is authenticated but lacks permission (403).");

const NotFoundPublic = z
  .object({
    code: z.literal("core/not_found").describe("The requested resource does not exist."),
    status: z.literal(404).describe("Not Found."),
    ...publicFields,
  })
  .describe("The requested resource does not exist (404).");

const ConflictPublic = z
  .object({
    code: z.literal("core/conflict").describe("The request conflicts with current state (e.g. a duplicate)."),
    status: z.literal(409).describe("Conflict."),
    ...publicFields,
  })
  .describe("The request conflicts with current state (409).");

const RateLimitPublic = z
  .object({
    code: z.literal("rate_limit/exceeded").describe("The caller has sent too many requests."),
    status: z.literal(429).describe("Too Many Requests."),
    ...publicFields,
  })
  .describe("The caller has exceeded a rate limit (429).");

const InternalPublic = z
  .object({
    code: z.literal("core/internal").describe("An unexpected server-side failure."),
    status: z.literal(500).describe("Internal Server Error."),
    ...publicFields,
  })
  .describe("An unexpected server-side failure (500).");

// --- @pithy-sh/cloudflare: out-of-Worker CF REST client codes ---

const CloudflareNotConfiguredPublic = z
  .object({
    code: z
      .literal("cloudflare/not_configured")
      .describe("The CF REST client is missing required configuration (token, account, or a resource id)."),
    status: z.literal(500).describe("Internal Server Error — a configuration fault, not a client request."),
    ...publicFields,
  })
  .describe("The Cloudflare REST client is not fully configured (500).");

const CloudflareRequestFailedPublic = z
  .object({
    code: z.literal("cloudflare/request_failed").describe("A call to the Cloudflare REST API failed."),
    status: z.literal(502).describe("Bad Gateway — the upstream Cloudflare API returned an error."),
    ...publicFields,
  })
  .describe("A Cloudflare REST API call failed (502).");

const CloudflareInvalidResponsePublic = z
  .object({
    code: z
      .literal("cloudflare/invalid_response")
      .describe("A Cloudflare REST API response failed validation against its expected shape."),
    status: z.literal(502).describe("Bad Gateway — the upstream Cloudflare API returned an unexpected shape."),
    ...publicFields,
  })
  .describe("A Cloudflare REST API response did not match its expected shape (502).");

// --- @pithy-sh/secrets: encrypted secret store + CLI codes ---

const SecretNotFoundPublic = z
  .object({
    code: z.literal("secrets/not_found").describe("A requested secret is not present in the store."),
    status: z.literal(404).describe("Not Found."),
    ...publicFields,
  })
  .describe("A requested secret does not exist in the store (404).");

const SecretAlreadyExistsPublic = z
  .object({
    code: z
      .literal("secrets/already_exists")
      .describe("A secret with this name already exists; `create` refuses to overwrite it."),
    status: z.literal(409).describe("Conflict."),
    ...publicFields,
  })
  .describe("A secret with this name already exists (409).");

const SecretInvalidValuePublic = z
  .object({
    code: z.literal("secrets/invalid_value").describe("A secret value failed validation against its registry schema."),
    status: z.literal(400).describe("Bad Request."),
    ...publicFields,
  })
  .describe("A secret value failed validation against its registry schema (400).");

const SecretCryptoFailedPublic = z
  .object({
    code: z
      .literal("secrets/crypto_failed")
      .describe("Encrypting or decrypting a secret failed (a missing key version, or unreadable ciphertext)."),
    status: z.literal(500).describe("Internal Server Error — a crypto or key-configuration fault."),
    ...publicFields,
  })
  .describe("Encrypting or decrypting a secret failed (500).");

// --- @pithy-sh/email: job-table email platform codes ---

const EmailTemplateNotFoundPublic = z
  .object({
    code: z.literal("email/template_not_found").describe("The requested email template id is not registered."),
    status: z.literal(404).describe("Not Found."),
    ...publicFields,
  })
  .describe("The requested email template does not exist (404).");

const EmailInvalidPayloadPublic = z
  .object({
    code: z
      .literal("email/invalid_payload")
      .describe("A template's input variables failed validation against its payload schema."),
    status: z.literal(400).describe("Bad Request."),
    ...publicFields,
  })
  .describe("Email template payload failed validation against its schema (400).");

const EmailInvalidTokenPublic = z
  .object({
    code: z
      .literal("email/invalid_token")
      .describe(
        "A callback token (click/open/unsubscribe) is malformed, expired, forged, or signed by an unknown key.",
      ),
    status: z.literal(400).describe("Bad Request — the signed token did not verify."),
    ...publicFields,
  })
  .describe("An email callback token failed verification (400).");

const EmailSuppressedPublic = z
  .object({
    code: z
      .literal("email/suppressed")
      .describe("The recipient address is on the suppression list and cannot be sent to."),
    status: z.literal(409).describe("Conflict — the address is suppressed."),
    ...publicFields,
  })
  .describe("The recipient is suppressed and was not sent to (409).");

const EmailRateLimitedPublic = z
  .object({
    code: z
      .literal("email/rate_limited")
      .describe("The Email Service rejected the send for a rate or daily-quota limit; the send is retryable."),
    status: z.literal(429).describe("Too Many Requests."),
    ...publicFields,
  })
  .describe("The Email Service rate or daily limit was hit (429).");

const EmailSendFailedPublic = z
  .object({
    code: z
      .literal("email/send_failed")
      .describe(
        "A send through the Email Service binding failed for a non-retryable reason (validation, sender, content).",
      ),
    status: z.literal(502).describe("Bad Gateway — the upstream Email Service returned a terminal error."),
    ...publicFields,
  })
  .describe("A send through the Email Service failed terminally (502).");

/**
 * The public projection of every error: the wire shape clients receive. No `detail`. Parsing
 * strips any stray `detail` (Zod drops unknown keys), so this schema is itself a guard against
 * internal context leaking outward.
 */
export const PublicErrorPayload = z
  .discriminatedUnion("code", [
    InvalidInputPublic,
    InvalidTokenPublic,
    ForbiddenPublic,
    NotFoundPublic,
    ConflictPublic,
    RateLimitPublic,
    InternalPublic,
    CloudflareNotConfiguredPublic,
    CloudflareRequestFailedPublic,
    CloudflareInvalidResponsePublic,
    SecretNotFoundPublic,
    SecretAlreadyExistsPublic,
    SecretInvalidValuePublic,
    SecretCryptoFailedPublic,
    EmailTemplateNotFoundPublic,
    EmailInvalidPayloadPublic,
    EmailInvalidTokenPublic,
    EmailSuppressedPublic,
    EmailRateLimitedPublic,
    EmailSendFailedPublic,
  ])
  .describe("The public shape of every error Pithy emits — the closed set, safe for the wire.");
export type PublicErrorPayload = z.infer<typeof PublicErrorPayload>;

// The full members: each public member plus the internal `detail`. Built as explicit consts
// (not mapped) so the `code`-literal discriminated-union types survive for `Extract` narrowing.
const InvalidInput = InvalidInputPublic.extend(detailField).describe(InvalidInputPublic.description ?? "");
const InvalidToken = InvalidTokenPublic.extend(detailField).describe(InvalidTokenPublic.description ?? "");
const Forbidden = ForbiddenPublic.extend(detailField).describe(ForbiddenPublic.description ?? "");
const NotFound = NotFoundPublic.extend(detailField).describe(NotFoundPublic.description ?? "");
const Conflict = ConflictPublic.extend(detailField).describe(ConflictPublic.description ?? "");
const RateLimit = RateLimitPublic.extend(detailField).describe(RateLimitPublic.description ?? "");
const Internal = InternalPublic.extend(detailField).describe(InternalPublic.description ?? "");
const CloudflareNotConfigured = CloudflareNotConfiguredPublic.extend(detailField).describe(
  CloudflareNotConfiguredPublic.description ?? "",
);
const CloudflareRequestFailed = CloudflareRequestFailedPublic.extend(detailField).describe(
  CloudflareRequestFailedPublic.description ?? "",
);
const CloudflareInvalidResponse = CloudflareInvalidResponsePublic.extend(detailField).describe(
  CloudflareInvalidResponsePublic.description ?? "",
);
const SecretNotFound = SecretNotFoundPublic.extend(detailField).describe(SecretNotFoundPublic.description ?? "");
const SecretAlreadyExists = SecretAlreadyExistsPublic.extend(detailField).describe(
  SecretAlreadyExistsPublic.description ?? "",
);
const SecretInvalidValue = SecretInvalidValuePublic.extend(detailField).describe(
  SecretInvalidValuePublic.description ?? "",
);
const SecretCryptoFailed = SecretCryptoFailedPublic.extend(detailField).describe(
  SecretCryptoFailedPublic.description ?? "",
);
const EmailTemplateNotFound = EmailTemplateNotFoundPublic.extend(detailField).describe(
  EmailTemplateNotFoundPublic.description ?? "",
);
const EmailInvalidPayload = EmailInvalidPayloadPublic.extend(detailField).describe(
  EmailInvalidPayloadPublic.description ?? "",
);
const EmailInvalidToken = EmailInvalidTokenPublic.extend(detailField).describe(
  EmailInvalidTokenPublic.description ?? "",
);
const EmailSuppressed = EmailSuppressedPublic.extend(detailField).describe(EmailSuppressedPublic.description ?? "");
const EmailRateLimited = EmailRateLimitedPublic.extend(detailField).describe(EmailRateLimitedPublic.description ?? "");
const EmailSendFailed = EmailSendFailedPublic.extend(detailField).describe(EmailSendFailedPublic.description ?? "");

/**
 * Every error Pithy can emit, in full: the public fields plus the internal `detail`. This is
 * what a `PithyError` carries in memory; the HTTP codec encodes it down to `PublicErrorPayload`.
 */
export const ErrorPayload = z
  .discriminatedUnion("code", [
    InvalidInput,
    InvalidToken,
    Forbidden,
    NotFound,
    Conflict,
    RateLimit,
    Internal,
    CloudflareNotConfigured,
    CloudflareRequestFailed,
    CloudflareInvalidResponse,
    SecretNotFound,
    SecretAlreadyExists,
    SecretInvalidValue,
    SecretCryptoFailed,
    EmailTemplateNotFound,
    EmailInvalidPayload,
    EmailInvalidToken,
    EmailSuppressed,
    EmailRateLimited,
    EmailSendFailed,
  ])
  .describe("Every error Pithy can emit, with internal detail. The in-memory shape a PithyError carries.");
export type ErrorPayload = z.infer<typeof ErrorPayload>;

/** The closed set of machine-readable error codes. */
export type ErrorCode = ErrorPayload["code"];
