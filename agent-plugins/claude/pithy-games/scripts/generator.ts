// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The one pinned `openapi-generator` the Unity client is generated with, as a container image.
 *
 * `openapi-generator`'s `unityWebRequest` library is marked experimental, so the version is pinned and
 * moved on purpose, never in passing. 7.10.0 crashed on the kit's OpenAPI 3.1 document; 7.26.0 generates the
 * full client. The `client-unity` agent and the README name this exact string, and
 * `packages/cli/src/ci/claudePlugin.test.ts` holds all three to it, as CI's generation job does.
 */
export const UNITY_OPENAPI_GENERATOR = "openapitools/openapi-generator-cli:v7.26.0";
