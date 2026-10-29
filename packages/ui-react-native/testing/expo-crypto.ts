// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { singleton } from "./singleton";

/** `expo-crypto`, over Web Crypto: real randomness and a real SHA-256, so a verifier made here is one a Worker checks. */
export enum CryptoDigestAlgorithm {
  SHA256 = "SHA-256",
}

export const cryptoStub = singleton("cryptoStub", () => ({
  /** Every UUID handed out, in order. */
  minted: [] as string[],
  reset(): void {
    this.minted = [];
  },
}));

export function getRandomBytes(byteCount: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(byteCount));
}

export async function getRandomBytesAsync(byteCount: number): Promise<Uint8Array> {
  return getRandomBytes(byteCount);
}

export function randomUUID(): string {
  const id = crypto.randomUUID();
  cryptoStub.minted.push(id);
  return id;
}

export function digest(algorithm: CryptoDigestAlgorithm, data: BufferSource): Promise<ArrayBuffer> {
  return crypto.subtle.digest(algorithm, data);
}

export async function digestStringAsync(algorithm: CryptoDigestAlgorithm, data: string): Promise<string> {
  const hashed = new Uint8Array(await crypto.subtle.digest(algorithm, new TextEncoder().encode(data)));
  return Array.from(hashed, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
