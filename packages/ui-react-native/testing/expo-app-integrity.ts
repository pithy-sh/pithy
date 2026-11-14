// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { singleton } from "./singleton";

/**
 * `@expo/app-integrity`: App Attest on iOS and Play Integrity on Android, answering the way the device would.
 * `appIntegrity.supported` is iOS's `isSupported`, read when a screen's modules load. `appIntegrity.failing` makes
 * every call reject, as a device without App Attest or without Play services does. `appIntegrity.calls` records
 * each call in order, with what it was handed.
 */
export const appIntegrity = singleton("appIntegrity", () => ({
  supported: true,
  failing: null as Error | null,
  keys: 0,
  calls: [] as string[],
  reset(): void {
    this.supported = true;
    this.failing = null;
    this.keys = 0;
    this.calls = [];
  },
}));

function refuseIfFailing(): void {
  if (appIntegrity.failing) throw appIntegrity.failing;
}

/** Read once, when the module loads, as the native constant is. */
export const isSupported: boolean = appIntegrity.supported;

export async function generateKeyAsync(): Promise<string> {
  refuseIfFailing();
  appIntegrity.keys += 1;
  const keyId = `app-attest-key-${appIntegrity.keys}`;
  appIntegrity.calls.push(`generateKeyAsync -> ${keyId}`);
  return keyId;
}

export async function attestKeyAsync(keyId: string, challenge: string): Promise<string> {
  refuseIfFailing();
  appIntegrity.calls.push(`attestKeyAsync ${keyId} ${challenge}`);
  return `attestation-object-for-${keyId}`;
}

export async function generateAssertionAsync(keyId: string, challenge: string): Promise<string> {
  refuseIfFailing();
  appIntegrity.calls.push(`generateAssertionAsync ${keyId} ${challenge}`);
  return `assertion-by-${keyId}`;
}

export async function prepareIntegrityTokenProviderAsync(cloudProjectNumber: string): Promise<void> {
  refuseIfFailing();
  appIntegrity.calls.push(`prepareIntegrityTokenProviderAsync ${cloudProjectNumber}`);
}

export async function requestIntegrityCheckAsync(requestHash: string): Promise<string> {
  refuseIfFailing();
  appIntegrity.calls.push(`requestIntegrityCheckAsync ${requestHash}`);
  return `integrity-token-for-${requestHash}`;
}

export async function isHardwareAttestationSupportedAsync(): Promise<boolean> {
  refuseIfFailing();
  return false;
}

export async function generateHardwareAttestedKeyAsync(_keyAlias: string, _challenge: string): Promise<void> {
  refuseIfFailing();
}

export async function getAttestationCertificateChainAsync(_keyAlias: string): Promise<string[]> {
  refuseIfFailing();
  return [];
}
