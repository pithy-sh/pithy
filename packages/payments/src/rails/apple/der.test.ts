import { describe, expect, test } from "vitest";
import { PaymentsInvalidReceiptError } from "../../error/errors";
import {
  ASN1_BIT_STRING,
  ASN1_INTEGER,
  ASN1_SEQUENCE,
  asn1Children,
  bytesEqual,
  decodeBase64,
  decodeBase64Url,
  derSignatureToRaw,
  readAsn1,
  readOid,
} from "./der";

/** DER bytes from a hex string, so the fixtures below read as the encodings they are. */
function hex(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, "");
  return Uint8Array.from({ length: clean.length / 2 }, (_, i) => Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16));
}

describe("readAsn1", () => {
  test("reads a short-form length, and reports both the whole encoding and the contents", () => {
    // SEQUENCE (3 bytes) { INTEGER 1 }
    const { node, end } = readAsn1(hex("3003 020101"));
    expect(node.tag).toBe(ASN1_SEQUENCE);
    expect([...node.der]).toEqual([0x30, 0x03, 0x02, 0x01, 0x01]);
    expect([...node.value]).toEqual([0x02, 0x01, 0x01]);
    expect(end).toBe(5);
  });

  test("reads a long-form length", () => {
    // OCTET STRING with a 200-byte body: length 0x81 0xC8.
    const body = new Uint8Array(200).fill(0x41);
    const der = new Uint8Array([0x04, 0x81, 0xc8, ...body]);
    const { node, end } = readAsn1(der);
    expect(node.value.length).toBe(200);
    expect(end).toBe(203);
  });

  test("reads a node at an offset, leaving the preceding bytes alone", () => {
    const { node } = readAsn1(hex("020101 020102"), 3);
    expect([...node.value]).toEqual([0x02]);
  });

  test("refuses an indefinite length — DER forbids it, and BER's terminator is a parser hazard", () => {
    expect(() => readAsn1(hex("3080 020101 0000"))).toThrow(PaymentsInvalidReceiptError);
  });

  test("refuses a length whose byte count could overflow", () => {
    expect(() => readAsn1(hex("30 85 0101010101"))).toThrow(PaymentsInvalidReceiptError);
  });

  test("refuses a length that runs past the end of the buffer", () => {
    // Claims 16 contents bytes with 1 present. A parser that trusted it would read adjacent memory.
    expect(() => readAsn1(hex("3010 01"))).toThrow(PaymentsInvalidReceiptError);
  });

  test("refuses a truncated header", () => {
    expect(() => readAsn1(hex("30"))).toThrow(PaymentsInvalidReceiptError);
    expect(() => readAsn1(new Uint8Array())).toThrow(PaymentsInvalidReceiptError);
  });
});

describe("asn1Children", () => {
  test("splits a constructed node into its members, in order", () => {
    // SEQUENCE { INTEGER 1, INTEGER 2, BIT STRING }
    const children = asn1Children(readAsn1(hex("300a 020101 020102 030200ff")).node);
    expect(children.map((c) => c.tag)).toEqual([ASN1_INTEGER, ASN1_INTEGER, ASN1_BIT_STRING]);
    expect([...(children[1]?.value ?? [])]).toEqual([0x02]);
  });

  test("an empty SEQUENCE has no members", () => {
    expect(asn1Children(readAsn1(hex("3000")).node)).toEqual([]);
  });

  test("refuses a member that overruns its parent", () => {
    // A SEQUENCE whose declared length ends mid-child. Left unchecked, the child's own length would be
    // read from whatever followed the parent.
    expect(() => asn1Children(readAsn1(hex("3002 0203 0102 03")).node)).toThrow(PaymentsInvalidReceiptError);
  });
});

describe("readOid", () => {
  test("decodes the ecdsa-with-SHA256 identifier", () => {
    expect(readOid(readAsn1(hex("06082a8648ce3d040302")).node)).toBe("1.2.840.10045.4.3.2");
  });

  test("decodes the P-256 curve identifier, whose last arc needs two encoded bytes", () => {
    expect(readOid(readAsn1(hex("06082a8648ce3d030107")).node)).toBe("1.2.840.10045.3.1.7");
  });

  test("decodes the P-384 curve identifier", () => {
    expect(readOid(readAsn1(hex("06052b81040022")).node)).toBe("1.3.132.0.34");
  });

  test("refuses a node that is not an OBJECT IDENTIFIER", () => {
    expect(() => readOid(readAsn1(hex("020101")).node)).toThrow(PaymentsInvalidReceiptError);
  });

  test("refuses an empty identifier", () => {
    expect(() => readOid(readAsn1(hex("0600")).node)).toThrow(PaymentsInvalidReceiptError);
  });
});

describe("derSignatureToRaw", () => {
  test("concatenates r and s, each left-padded to the coordinate size", () => {
    // SEQUENCE { INTEGER 0x01, INTEGER 0x02 } for a 32-byte curve → 64 bytes, r and s right-aligned.
    const raw = derSignatureToRaw(hex("3006 020101 020102"), 32);
    expect(raw.length).toBe(64);
    expect(raw[31]).toBe(0x01);
    expect(raw[63]).toBe(0x02);
    expect(raw.slice(0, 31).every((b) => b === 0)).toBe(true);
  });

  test("strips the leading zero DER adds to keep a high-bit integer positive", () => {
    // 0x00FF… is how DER writes an integer whose top byte has the high bit set. WebCrypto wants the
    // 32 significant bytes, so the padding byte must come off rather than shifting everything right.
    const r = `00${"ff".repeat(32)}`;
    const raw = derSignatureToRaw(hex(`3026 0221${r} 020102`), 32);
    expect(raw.length).toBe(64);
    expect(raw[0]).toBe(0xff);
    expect(raw[31]).toBe(0xff);
  });

  test("refuses a signature whose integer is wider than the curve", () => {
    const r = "ff".repeat(33);
    expect(() => derSignatureToRaw(hex(`3026 0221${r} 020102`), 32)).toThrow(PaymentsInvalidReceiptError);
  });

  test("refuses a signature that is not a two-integer SEQUENCE", () => {
    expect(() => derSignatureToRaw(hex("3003 020101"), 32)).toThrow(PaymentsInvalidReceiptError);
    expect(() => derSignatureToRaw(hex("3006 020101 030101"), 32)).toThrow(PaymentsInvalidReceiptError);
    expect(() => derSignatureToRaw(hex("020101"), 32)).toThrow(PaymentsInvalidReceiptError);
  });
});

describe("decodeBase64 / decodeBase64Url", () => {
  test("decodes standard base64 with padding — the x5c encoding", () => {
    expect([...decodeBase64("AQID")]).toEqual([1, 2, 3]);
    expect([...decodeBase64("AQI=")]).toEqual([1, 2]);
  });

  test("decodes base64url without padding — the JWS encoding", () => {
    // 0xfb 0xff 0xbf encodes as `-_-_` in the URL alphabet and `+/+/` in the standard one.
    expect([...decodeBase64Url("-_-_")]).toEqual([0xfb, 0xff, 0xbf]);
    // Two significant bytes, no `=` padding, which is what a JWS carries.
    expect([...decodeBase64Url("AQI")]).toEqual([1, 2]);
  });

  test("refuses input that is not base64 at all", () => {
    expect(() => decodeBase64("not base64!!")).toThrow(PaymentsInvalidReceiptError);
    expect(() => decodeBase64Url("....")).toThrow(PaymentsInvalidReceiptError);
  });

  test("refuses an empty encoding — a certificate or signature is never zero bytes", () => {
    expect(() => decodeBase64("")).toThrow(PaymentsInvalidReceiptError);
    expect(() => decodeBase64Url("")).toThrow(PaymentsInvalidReceiptError);
  });
});

describe("bytesEqual", () => {
  test("compares contents, not identity", () => {
    expect(bytesEqual(hex("0102"), hex("0102"))).toBe(true);
    expect(bytesEqual(hex("0102"), hex("0103"))).toBe(false);
  });

  test("different lengths are never equal", () => {
    expect(bytesEqual(hex("0102"), hex("010200"))).toBe(false);
  });
});
