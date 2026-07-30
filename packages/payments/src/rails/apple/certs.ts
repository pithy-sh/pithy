/**
 * Apple's root certificates, pinned as shipped assets.
 *
 * **These are not secrets.** A root certificate is a public key with a name on it; Apple publishes these
 * for exactly this purpose, and every device that has ever talked to the App Store carries them. They are
 * pinned rather than read from a trust store because the Workers runtime has no trust store to read, and
 * because pinning is what makes the check mean something: verifying a chain against "whatever roots are
 * around" would accept a notification signed by any CA, and a webhook endpoint that accepts any CA's
 * signature accepts anyone's notification.
 *
 * ## Where these came from
 *
 * `APPLE_ROOT_CA_G3` is `AppleRootCA-G3.cer`, downloaded from Apple's published certificate authority page
 * and base64-encoded from its DER form:
 *
 * ```sh
 * curl -O https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
 * openssl x509 -inform der -in AppleRootCA-G3.cer -outform pem | sed -e '1d' -e '$d' | tr -d '\n'
 * ```
 *
 * Verify a copy before trusting it. The SHA-256 fingerprint is
 * `63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79`,
 * the serial is `2DC5FC88D2C54B95`, and it is valid from 2014-04-30 to 2039-04-30:
 *
 * ```sh
 * openssl x509 -inform der -in AppleRootCA-G3.cer -noout -fingerprint -sha256 -serial -dates
 * ```
 *
 * ## How to refresh them
 *
 * This is a `readonly string[]` and not a single value because a root rotation is additive, not a swap.
 * Apple would publish a new root long before retiring G3, notifications would arrive signed under either,
 * and both must verify during the overlap. So: add the new root's base64 to the array with its fingerprint
 * recorded above, ship it, and remove the old one only once Apple has retired it. Removing first is what
 * turns a routine rotation into an outage in which every renewal notification is refused.
 *
 * G3 expires in 2039. That is a long time, and it is exactly why the refresh procedure is written down
 * here rather than remembered: nobody who ships this will be the one who has to do it.
 *
 * ## What the chain looks like
 *
 * An App Store Server Notification's JWS carries the whole chain in its `x5c` header, leaf first:
 *
 *   leaf (ECDSA P-256, signed with SHA-256)
 *     ← Apple Worldwide Developer Relations Certification Authority, OU=G6 (ECDSA P-384, SHA-384)
 *       ← Apple Root CA - G3 (ECDSA P-384, SHA-384, self-signed)
 *
 * The chain is elliptic-curve end to end, which is why the verifier accepts ECDSA and nothing else. An
 * RSA-signed chain would be refused, and that is deliberate: an algorithm the boundary never sees is
 * surface with no user. If Apple ever publishes an RSA root, it arrives through the refresh procedure
 * above alongside support for it.
 */

/** Apple Root CA - G3, DER, base64. The root every App Store Server Notification chains to. */
const APPLE_ROOT_CA_G3 =
  "MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==";

/**
 * Every Apple root a chain may terminate in, base64 DER. The last certificate in a JWS `x5c` must be
 * byte-identical to one of these — a stronger check than re-verifying a self-signature, which only proves
 * the root vouches for itself.
 */
export const APPLE_ROOT_CERTIFICATES: readonly string[] = [APPLE_ROOT_CA_G3];
