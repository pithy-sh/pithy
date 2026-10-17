// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { MediaUnsupportedError } from "../error/errors";

/**
 * Signed delivery: the short-lived URLs a caller who may read a private record is handed for its bytes.
 *
 * A non-public Cloudflare Images or Stream asset is uploaded with `requireSignedURLs`, so its plain URL
 * answers nobody. These mint the URL that does — with WebCrypto alone, inside the Worker, from keys read
 * through `@pithy-sh/secrets`. Nothing here decides who may have one; the route does that first.
 *
 * **Images** signs the delivery path and an expiry with the account's URL-signing key: HMAC-SHA256 over
 * `/<hash>/<id>/<variant>?exp=<unix>`, hex, appended as `sig`.
 *
 * **Stream** signs a token: an RS256 JWT naming the video uid as `sub`, the signing key as `kid`, and an
 * expiry, with the private half of a Stream signing key. The token takes the uid's place in the playback
 * URL.
 */

/** The Images URL-signing key, as `media-images-signing-key` holds it. */
export interface ImagesSigningKey {
  readonly key: string;
}

/** The Stream signing key, as `media-stream-signing-key` holds it: the key id and base64 of its JWK. */
export interface StreamSigningKey {
  readonly keyId: string;
  readonly jwk: string;
}

/** Mints signed delivery for whichever keys a Worker holds. */
export interface DeliverySigner {
  /** Sign an `imagedelivery.net` URL to expire at `expiresAt`. */
  signImageUrl(url: string, expiresAt: Date): Promise<string>;
  /** A signed playback token for one Stream video, expiring at `expiresAt`. */
  streamToken(uid: string, expiresAt: Date): Promise<string>;
}

const encoder = new TextEncoder();

/** Whole seconds since the epoch — the unit both signing schemes take. */
function unixSeconds(at: Date): number {
  return Math.floor(at.getTime() / 1000);
}

/** Lowercase hex of a buffer. */
function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Base64url of bytes, unpadded — the JWT encoding. */
function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Refuse a signing request the Worker holds no key for, naming the command that provisions one. */
function missingKey(product: "Images" | "Stream"): MediaUnsupportedError {
  return new MediaUnsupportedError({
    message: "A signed delivery URL cannot be made for this media right now.",
    action: `Provision media again for this environment to store the Cloudflare ${product} signing key.`,
    detail: `no ${product} signing key was supplied to the delivery signer`,
  });
}

/**
 * Build a signer from the keys a Worker holds. A key that is absent refuses at the call that needs it —
 * a Worker serving only public media never needs either.
 */
export function deliverySigner(keys: { images?: ImagesSigningKey; stream?: StreamSigningKey }): DeliverySigner {
  let hmac: Promise<CryptoKey> | undefined;
  let rsa: Promise<CryptoKey> | undefined;

  return {
    async signImageUrl(url, expiresAt) {
      const images = keys.images;
      if (!images) throw missingKey("Images");
      hmac ??= crypto.subtle.importKey("raw", encoder.encode(images.key), { name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
      ]);
      const signed = new URL(url);
      signed.searchParams.set("exp", String(unixSeconds(expiresAt)));
      const message = `${signed.pathname}?${signed.searchParams.toString()}`;
      const mac = await crypto.subtle.sign("HMAC", await hmac, encoder.encode(message));
      signed.searchParams.set("sig", hex(mac));
      return signed.toString();
    },

    async streamToken(uid, expiresAt) {
      const stream = keys.stream;
      if (!stream) throw missingKey("Stream");
      rsa ??= crypto.subtle.importKey(
        "jwk",
        JSON.parse(atob(stream.jwk)) as JsonWebKey,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const header = base64url(encoder.encode(JSON.stringify({ alg: "RS256", kid: stream.keyId })));
      const payload = base64url(
        encoder.encode(JSON.stringify({ sub: uid, kid: stream.keyId, exp: unixSeconds(expiresAt) })),
      );
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        await rsa,
        encoder.encode(`${header}.${payload}`),
      );
      return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
    },
  };
}
