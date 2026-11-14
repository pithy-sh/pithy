// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { base64UrlDecode, base64UrlEncode } from "@pithy-sh/core/src/controlPlane/token/base64url";
import type { PlayIntegrityServiceAccount } from "../instance/secrets";

/** A service account as Google hands it over, with an RSA key made for the test, and the key to verify with. */
export interface TestServiceAccount {
  account: PlayIntegrityServiceAccount;
  publicKey: CryptoKey;
}

function pem(der: ArrayBuffer): string {
  const body = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

/** Make a service account whose `private_key` is a fresh RSA-2048 PKCS#8 PEM. */
export async function testServiceAccount(): Promise<TestServiceAccount> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  return {
    account: {
      type: "service_account",
      project_id: "example-project",
      private_key_id: "0123456789abcdef",
      private_key: pem(der),
      client_email: "play-integrity@example-project.iam.gserviceaccount.com",
      client_id: "1234567890",
      token_uri: "https://oauth2.googleapis.com/token",
    },
    publicKey: pair.publicKey,
  };
}

/** A JWT's three parts, decoded, and whether its RS256 signature verifies with `publicKey`. */
export async function readJwt(
  jwt: string,
  publicKey: CryptoKey,
): Promise<{ header: Record<string, unknown>; claims: Record<string, unknown>; verified: boolean }> {
  const [header = "", claims = "", signature = ""] = jwt.split(".");
  const decode = (part: string) =>
    JSON.parse(new TextDecoder().decode(base64UrlDecode(part))) as Record<string, unknown>;
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    base64UrlDecode(signature) as Uint8Array<ArrayBuffer>,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  return { header: decode(header), claims: decode(claims), verified };
}

/** One request the stub saw. */
export interface SeenRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/** A recorded answer: a status and a JSON body. */
export interface StubAnswer {
  status: number;
  body: unknown;
}

/**
 * A `fetch` that answers Google's token endpoint and `decodeIntegrityToken`, from the answers it is handed, and
 * records every request. Any other URL is a test fault and throws.
 */
export function googleFetch(answers: {
  token?: StubAnswer | (() => StubAnswer | Promise<StubAnswer>);
  decode?: StubAnswer | ((request: SeenRequest) => StubAnswer | Promise<StubAnswer>);
}): { fetch: typeof fetch; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const respond = (answer: StubAnswer) =>
    new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const record: SeenRequest = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: await request.text(),
    };
    seen.push(record);
    if (record.url === "https://oauth2.googleapis.com/token") {
      const answer = answers.token ?? { status: 200, body: { access_token: "ya29.test", expires_in: 3599 } };
      return respond(typeof answer === "function" ? await answer() : answer);
    }
    if (record.url.startsWith("https://playintegrity.googleapis.com/v1/")) {
      const answer = answers.decode ?? { status: 500, body: {} };
      return respond(typeof answer === "function" ? await answer(record) : answer);
    }
    throw new Error(`googleFetch: no stub for ${record.url}`);
  };
  return { fetch: stub as typeof fetch, seen };
}

/** A `decodeIntegrityToken` answer that passes, bound to `binding`, as Google records it for a standard request. */
export function passingDecode(binding: Uint8Array, now: Date, packageName = "com.example.app"): StubAnswer {
  return passingDecodeOf(base64UrlEncode(binding), now, packageName);
}

/**
 * A `decodeIntegrityToken` answer that passes, carrying `requestHash` exactly as the app handed it to Play Integrity:
 * Google records the string it was given, so the Worker compares the client's own characters.
 */
export function passingDecodeOf(requestHash: string, now: Date, packageName = "com.example.app"): StubAnswer {
  return {
    status: 200,
    body: {
      tokenPayloadExternal: {
        requestDetails: {
          requestPackageName: packageName,
          requestHash,
          timestampMillis: String(now.getTime() - 1_500),
        },
        appIntegrity: {
          appRecognitionVerdict: "PLAY_RECOGNIZED",
          packageName,
          certificateSha256Digest: ["6a6a1474b5cbbb2b1aa57e0bc3"],
          versionCode: "42",
        },
        deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] },
        accountDetails: { appLicensingVerdict: "LICENSED" },
        environmentDetails: { playProtectVerdict: "NO_ISSUES" },
      },
    },
  };
}
