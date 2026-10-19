// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { resignCredentials, signCredential, verifyCredential } from "./credentialResign";

const OLD = "old-session-secret-000000000000000000000000";
const NEW = "new-session-secret-000000000000000000000000";
const COOKIE = "better-auth.session_token";

describe("signCredential / verifyCredential — Better Auth's signed-cookie format", () => {
  test("signs as `value.signature` with a 44-character base64 HMAC-SHA256, the shape better-call verifies", async () => {
    const signed = await signCredential("token-abc", NEW);
    const [value, signature] = [signed.slice(0, signed.lastIndexOf(".")), signed.slice(signed.lastIndexOf(".") + 1)];
    expect(value).toBe("token-abc");
    expect(signature).toHaveLength(44);
    expect(signature.endsWith("=")).toBe(true);
  });

  test("names which of the keys it verifies under, and refuses one signed under none", async () => {
    const signed = await signCredential("token-abc", OLD);
    expect(await verifyCredential(signed, [NEW, OLD])).toEqual({ value: "token-abc", key: 1 });
    expect(await verifyCredential(signed, [NEW])).toBeNull();
    expect(await verifyCredential("token-abc", [OLD])).toBeNull();
    expect(await verifyCredential("token-abc.not-a-signature", [OLD])).toBeNull();
  });
});

describe("resignCredentials — a credential signed before a rotation, carried across it (#602)", () => {
  test("a session cookie signed under a retained version is re-signed under the current one", async () => {
    const old = encodeURIComponent(await signCredential("token-abc", OLD));
    const headers = new Headers({ cookie: `theme=dark; ${COOKIE}=${old}` });
    const result = await resignCredentials(headers, { current: NEW, prior: [OLD] }, [COOKIE]);

    const fresh = await signCredential("token-abc", NEW);
    expect(result?.cookies).toEqual([{ name: COOKIE, value: fresh }]);
    // The request now carries the re-signed cookie, and nothing else about it changed.
    expect(result?.headers.get("cookie")).toBe(`theme=dark; ${COOKIE}=${encodeURIComponent(fresh)}`);
  });

  test("a bearer credential signed under a retained version is re-signed too, so a mobile client is not signed out", async () => {
    const old = await signCredential("token-abc", OLD);
    const headers = new Headers({ authorization: `Bearer ${encodeURIComponent(old)}` });
    const result = await resignCredentials(headers, { current: NEW, prior: [OLD] }, [COOKIE]);

    const fresh = await signCredential("token-abc", NEW);
    expect(result?.bearer).toBe(fresh);
    expect(result?.headers.get("authorization")).toBe(`Bearer ${fresh}`);
  });

  test("a credential already under the current version, or under none, is left exactly as it came", async () => {
    const current = encodeURIComponent(await signCredential("token-abc", NEW));
    expect(
      await resignCredentials(new Headers({ cookie: `${COOKIE}=${current}` }), { current: NEW, prior: [OLD] }, [
        COOKIE,
      ]),
    ).toBeNull();
    const forged = encodeURIComponent(await signCredential("token-abc", "nobody-holds-this-0000000000000000000000"));
    expect(
      await resignCredentials(new Headers({ cookie: `${COOKIE}=${forged}` }), { current: NEW, prior: [OLD] }, [COOKIE]),
    ).toBeNull();
    // A raw bearer token carries no signature: Better Auth signs it itself, under whatever is current.
    expect(
      await resignCredentials(new Headers({ authorization: "Bearer token-abc" }), { current: NEW, prior: [OLD] }, [
        COOKIE,
      ]),
    ).toBeNull();
  });

  test("with no prior version there is nothing to carry across, and nothing is parsed", async () => {
    const old = encodeURIComponent(await signCredential("token-abc", OLD));
    expect(
      await resignCredentials(new Headers({ cookie: `${COOKIE}=${old}` }), { current: NEW, prior: [] }, [COOKIE]),
    ).toBeNull();
  });

  test("a cookie this does not own is never touched, whatever it is signed with", async () => {
    const old = encodeURIComponent(await signCredential("token-abc", OLD));
    expect(
      await resignCredentials(new Headers({ cookie: `someone-else=${old}` }), { current: NEW, prior: [OLD] }, [COOKIE]),
    ).toBeNull();
  });
});
