// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { SecretInvalidValueError } from "../error/errors";
import type { SecretRegistryEntry } from "../registry";
import { validateSecretValue } from "./validate";

const textEntry: SecretRegistryEntry = { backend: "d1", scope: "environment", rotatable: false, valueType: "text" };
const jsonEntry: SecretRegistryEntry = {
  backend: "d1",
  scope: "environment",
  rotatable: false,
  valueType: "json",
  schema: z.object({ apiKey: z.string().min(4).describe("API key.") }).describe("Emailer."),
};

describe("validateSecretValue", () => {
  test("passes a text value through unchanged", () => {
    expect(validateSecretValue(textEntry, "api-token", "raw-token")).toBe("raw-token");
  });

  test("validates a json value and returns it canonically re-serialized", () => {
    expect(validateSecretValue(jsonEntry, "emailer", '{ "apiKey":  "abcdef" }')).toBe('{"apiKey":"abcdef"}');
  });

  test("rejects an invalid json value without echoing the secret material", () => {
    const error = (() => {
      try {
        validateSecretValue(jsonEntry, "emailer", JSON.stringify({ apiKey: "SEK" }));
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(SecretInvalidValueError);
    const payload = (error as SecretInvalidValueError).payload;
    expect(payload.detail).toContain("apiKey:too_small");
    expect(payload.detail).not.toContain("SEK");
  });

  test("rejects non-JSON for a json entry", () => {
    expect(() => validateSecretValue(jsonEntry, "emailer", "not json")).toThrow(SecretInvalidValueError);
  });
});
