// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/**
 * Decode base64 as Apple's APIs hand it over (standard alphabet, padded) or as a client may re-encode it
 * (url alphabet, unpadded). Answers `undefined` for anything else, never a best guess.
 */
export function decodeBase64(value: string): Uint8Array | undefined {
  let standard: string;
  if (BASE64.test(value)) {
    if (value.includes("=") && value.length % 4 !== 0) return undefined;
    standard = value.replace(/=+$/, "");
  } else if (BASE64URL.test(value)) {
    standard = value.replace(/-/g, "+").replace(/_/g, "/");
  } else {
    return undefined;
  }
  if (standard.length % 4 === 1) return undefined;
  let binary: string;
  try {
    binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
  } catch {
    return undefined;
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
