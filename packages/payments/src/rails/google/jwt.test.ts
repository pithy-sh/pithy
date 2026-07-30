import { describe, expect, test } from "vitest";
import { PaymentsInvalidReceiptError, PaymentsRailNotConfiguredError } from "../../error/errors";
import { base64UrlDecode, base64UrlEncode, decodeJwtJson, pemPrivateKey, splitJwt } from "./jwt";

/**
 * The byte plumbing under Google's two JWT jobs. Small, and worth its own suite: every one of these reads a
 * string that arrived in an unauthenticated request, so each refusal below is a real boundary rather than a
 * defensive habit.
 */

const encoder = new TextEncoder();

describe("base64UrlDecode", () => {
  test("decodes an unpadded value, substituting the URL alphabet", () => {
    // "??>" in standard base64 is "Pz8+"; base64url writes the same bytes as "Pz8-".
    expect([...base64UrlDecode("Pz8-", "test")]).toEqual([0x3f, 0x3f, 0x3e]);
    expect([...base64UrlDecode("Pz8_", "test")]).toEqual([0x3f, 0x3f, 0x3f]);
  });

  test("round-trips every byte value", () => {
    const bytes = new Uint8Array(256).map((_, index) => index);
    expect([...base64UrlDecode(base64UrlEncode(bytes), "test")]).toEqual([...bytes]);
  });

  test("an empty value is refused rather than decoding to nothing", () => {
    // An empty signature segment is `alg: none` expressed structurally, so zero bytes is never a valid answer.
    expect(() => base64UrlDecode("", "signature")).toThrow(PaymentsInvalidReceiptError);
  });

  test("a value outside the alphabet is refused, and the refusal names the segment", () => {
    const thrown = catchError(() => base64UrlDecode("not base64!!", "header"));
    expect(thrown).toBeInstanceOf(PaymentsInvalidReceiptError);
    expect(thrown?.payload.detail).toContain("header");
  });
});

describe("base64UrlEncode", () => {
  test("writes the URL alphabet and drops the padding", () => {
    const encoded = base64UrlEncode(new Uint8Array([0x3f, 0x3f, 0x3e]));
    expect(encoded).toBe("Pz8-");
    expect(encoded).not.toContain("=");
  });

  test("encodes an empty input as an empty string", () => {
    // The encoder is only ever handed a header, a claim set, or a signature, and none of those is empty — but
    // it must not invent bytes for one either.
    expect(base64UrlEncode(new Uint8Array())).toBe("");
  });
});

describe("splitJwt", () => {
  test("splits a compact token into its three segments", () => {
    expect(splitJwt("aa.bb.cc")).toEqual({ head: "aa", body: "bb", mac: "cc" });
  });

  test("refuses a token that is not three segments", () => {
    for (const token of ["", "aa", "aa.bb", "aa.bb.cc.dd"]) {
      expect(() => splitJwt(token), token).toThrow(PaymentsInvalidReceiptError);
    }
  });

  test("refuses an empty segment — an unsigned token is not a token", () => {
    // `alg: none` produces exactly this: a header, a payload, and nothing after the final dot.
    for (const token of ["aa.bb.", ".bb.cc", "aa..cc"]) {
      expect(() => splitJwt(token), token).toThrow(PaymentsInvalidReceiptError);
    }
  });
});

describe("decodeJwtJson", () => {
  test("decodes a base64url JSON segment to an unknown value", () => {
    const segment = base64UrlEncode(encoder.encode(JSON.stringify({ aud: "x" })));
    expect(decodeJwtJson(segment, "claims")).toEqual({ aud: "x" });
  });

  test("a segment that is not JSON is refused, and the text never reaches the message", () => {
    const segment = base64UrlEncode(encoder.encode("not json"));
    const thrown = catchError(() => decodeJwtJson(segment, "claims"));
    expect(thrown).toBeInstanceOf(PaymentsInvalidReceiptError);
    expect(thrown?.payload.detail).toContain("claims");
    // The bytes are caller-supplied, so they belong nowhere in the payload — not even in `detail`.
    expect(JSON.stringify(thrown?.payload)).not.toContain("not json");
  });
});

describe("pemPrivateKey", () => {
  /** A PKCS#8 PEM whose body is the three bytes `0x01 0x02 0x03`, so the decode is checkable. */
  const pem = "-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----\n";

  test("strips the armour and the line breaks", () => {
    expect([...pemPrivateKey(pem)]).toEqual([1, 2, 3]);
  });

  test("accepts the escaped newlines a service-account JSON file carries", () => {
    // Google's downloaded JSON stores the key as one line with literal `\n` sequences. A credential pasted
    // through a shell or a JSON editor arrives that way often enough that refusing it would read as a bug.
    expect([...pemPrivateKey("-----BEGIN PRIVATE KEY-----\\nAQID\\n-----END PRIVATE KEY-----")]).toEqual([1, 2, 3]);
  });

  test("refuses a PKCS#1 key rather than letting WebCrypto fail later", () => {
    // `BEGIN RSA PRIVATE KEY` is PKCS#1, which `importKey("pkcs8", …)` cannot read. Google issues PKCS#8, so
    // this is a provisioning mistake, and naming it here is the difference between one clear line and an
    // opaque WebCrypto DataError.
    const thrown = catchError(() =>
      pemPrivateKey("-----BEGIN RSA PRIVATE KEY-----\nAQID\n-----END RSA PRIVATE KEY-----"),
    );
    expect(thrown).toBeInstanceOf(PaymentsRailNotConfiguredError);
    expect(thrown?.payload.detail).toContain("PKCS#8");
  });

  test("refuses a value with no PEM armour at all", () => {
    expect(() => pemPrivateKey("AQID")).toThrow(PaymentsRailNotConfiguredError);
  });

  test("no refusal carries the key material", () => {
    // The private key is the one credential in the bundle that signs on our behalf, and `detail` reaches logs.
    const thrown = catchError(() =>
      pemPrivateKey("-----BEGIN RSA PRIVATE KEY-----\nSUPERSECRET\n-----END RSA PRIVATE KEY-----"),
    );
    expect(JSON.stringify(thrown?.payload)).not.toContain("SUPERSECRET");
  });
});

/** The thrown `PithyError`, or undefined. Keeps each case a single readable line. */
function catchError(run: () => unknown): (PaymentsInvalidReceiptError | PaymentsRailNotConfiguredError) | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error as PaymentsInvalidReceiptError;
  }
}
