// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { EncryptionConfig } from "../crypto/envelope";
import {
  ConfigStamp,
  configStamp,
  decodeConfigStamp,
  encodeConfigStamp,
  MASTER_KEY_STAMP_KIND,
  sameConfigStamp,
} from "./configStamp";

/**
 * **The one channel in the rotation that is REST-readable, and the one that must never carry a key.**
 *
 * Cloudflare returns a Secrets Store entry's `comment` to anyone holding Secrets Store Read on the
 * account, while the value itself is bind-only. So the comment is where a pass can say something about
 * the entry it just wrote — and it is also the one field in this slice where key material could reach a
 * reader who was never meant to have it. Every test below is about one of those two halves.
 */

/** A key-shaped sentinel: base64, the length of an AES-256 key, and greppable. */
const PLANTED_KEY = "PLANTEDsk0000000000000000000000000000000000+/=";

const config: EncryptionConfig = {
  currentVersion: "2",
  versions: { "1": PLANTED_KEY, "2": `${PLANTED_KEY}2` },
  lastRotatedAt: "2026-02-01T00:00:00.000Z",
};

const pass = { rotationId: 41, at: new Date("2026-02-01T03:00:00.000Z") };

describe("configStamp", () => {
  /**
   * `#386`, at the one site in this slice that publishes anything.
   *
   * Fails if `configStamp` reads `Object.values(config.versions)` instead of `Object.keys(...)` — the
   * one-word slip this schema exists to make impossible — or if any field is ever derived from a key.
   */
  test("the encoded stamp names version keys and carries no byte of the keys they address", () => {
    const stamp = configStamp(config, pass);
    expect(stamp).not.toBeNull();
    const comment = encodeConfigStamp(stamp as ConfigStamp);

    expect(comment).not.toBeNull();
    expect(comment).not.toContain("PLANTED");
    expect(comment).not.toContain(PLANTED_KEY);
    // And the fact it *does* carry: the version keys, as keys.
    expect(JSON.parse(comment as string)).toEqual({
      kind: MASTER_KEY_STAMP_KIND,
      currentVersion: "2",
      versions: ["1", "2"],
      rotationId: 41,
      at: "2026-02-01T03:00:00.000Z",
    });
  });

  /**
   * The second layer, and the one that is a type rather than a habit. Fails if `KeyVersion` loses its
   * regex: a base64 key is 44 characters and carries `+`, `/` and `=`, none of which a version key may.
   */
  test("the schema refuses a key in a version field", () => {
    const smuggled = ConfigStamp.safeParse({
      kind: MASTER_KEY_STAMP_KIND,
      currentVersion: PLANTED_KEY,
      versions: [PLANTED_KEY],
      rotationId: 41,
      at: "2026-02-01T03:00:00.000Z",
    });
    expect(smuggled.success).toBe(false);
  });

  /**
   * The stamp's field set, stated. Fails when a sixth field lands — which is how "prove the bytes too"
   * would arrive: a digest of the key set, in a field Cloudflare hands to anyone who can list the store.
   * Proving the bytes is the binding's job, and it is the only thing that can do it.
   */
  test("the stamp has exactly these fields, so a sixth one fails here", () => {
    expect(Object.keys(ConfigStamp.shape).sort()).toEqual(["at", "currentVersion", "kind", "rotationId", "versions"]);
  });

  /** Fails if `configStamp` drops the coherence check: a config pointing at a version it does not hold. */
  test("a config pointing at a version it does not carry gets no stamp", () => {
    expect(configStamp({ ...config, currentVersion: "9" }, pass)).toBeNull();
  });

  /** Fails if `configStamp` throws rather than degrading — a comment must never veto persisting a key. */
  test("a config whose version keys are not integers gets no stamp, and no exception", () => {
    const wrong: EncryptionConfig = { ...config, currentVersion: "two", versions: { two: PLANTED_KEY } };
    expect(configStamp(wrong, pass)).toBeNull();
  });
});

describe("decodeConfigStamp", () => {
  test("an entry Cloudflare returns with an explicit null comment reads as no stamp", () => {
    // **The shape a live store actually sends (#647).** An unannotated entry comes back as
    // `comment: null`, not an absent key — every one of the ten entries in the real store this was
    // measured against reported exactly that. Narrow the parameter back to `string | undefined` and the
    // build fails; answer anything but `null` here and the stamp check refuses a rotation over an entry
    // an operator simply never annotated.
    expect(decodeConfigStamp(null)).toBeNull();
    expect(decodeConfigStamp(undefined)).toBeNull();
  });

  /** Fails if the encoder drops a field or the decoder tightens past what the encoder writes. */
  test("a stamp round-trips through the comment", () => {
    const stamp = configStamp(config, pass) as ConfigStamp;
    expect(decodeConfigStamp(encodeConfigStamp(stamp) as string)).toEqual(stamp);
  });

  /**
   * The comment is a field an operator may type into in the Cloudflare dashboard, so a human's note has
   * to read as "no stamp" rather than as a failed rotation. Fails if `decodeConfigStamp` throws on any of
   * these, or if `kind` stops being a literal — the third case is a well-formed stamp of another format.
   */
  test("anything that is not this format reads as no stamp", () => {
    expect(decodeConfigStamp(undefined)).toBeNull();
    expect(decodeConfigStamp("")).toBeNull();
    expect(decodeConfigStamp("rotated by hand, 2026-01-04 — do not touch")).toBeNull();
    expect(
      decodeConfigStamp(
        JSON.stringify({
          kind: "pithy.secrets.masterkey.v0",
          currentVersion: "2",
          versions: ["1", "2"],
          rotationId: 41,
          at: "2026-02-01T03:00:00.000Z",
        }),
      ),
    ).toBeNull();
  });
});

describe("sameConfigStamp", () => {
  /**
   * **The rotation id is what makes a stamp this pass's rather than some pass's.** A generation number is
   * not unique: a pass that staged key 2 and aborted leaves a stamp naming version 2 behind, and the next
   * pass to stage 2 would find it and call its own write confirmed. Fails if `sameConfigStamp` stops
   * comparing `rotationId`.
   */
  test("a stamp left by an earlier pass over the same key set does not match this one", () => {
    const mine = configStamp(config, pass) as ConfigStamp;
    const earlier = configStamp(config, { rotationId: 40, at: pass.at }) as ConfigStamp;
    expect(sameConfigStamp(mine, mine)).toBe(true);
    expect(sameConfigStamp(mine, earlier)).toBe(false);
  });

  /** Fails if `sameConfigStamp` compares only the pointer: the staged and promoted writes of one pass. */
  test("the staged and promoted writes of one pass are told apart", () => {
    const staged = configStamp({ ...config, currentVersion: "1" }, pass) as ConfigStamp;
    const promoted = configStamp(config, pass) as ConfigStamp;
    expect(sameConfigStamp(staged, promoted)).toBe(false);
  });
});
