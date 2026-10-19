// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { NAMESPACE_LIMITS } from "@pithy-sh/core/src/naming/limits";
import { ArtifactsInvalidNameError } from "../error/errors";

/**
 * A repository's **physical name** — the one in the namespace and in the clone URL — and the rule it answers to.
 *
 * Cloudflare's charset: a letter or digit, then letters, digits, `.`, `_` and `-`. There is no `/`, so a namespace
 * is flat, and that is why the default is a UUID rather than anything a person picked: one tenant's `docs` cannot
 * collide with another's, and a name nobody can guess is a name nobody can probe for.
 */
export const REPO_NAME_CHARSET = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A fresh physical name: `crypto.randomUUID()`, 36 characters, opening on a hex digit, only `-` beside them. */
export function generatedRepoName(): string {
  return crypto.randomUUID();
}

/**
 * Refuse a supplied physical name that breaks the rule, naming which rule. **Never truncated, never rewritten**: a
 * name somebody chose is in every clone URL, and a silently different one is a repository nobody can find.
 */
export function assertRepoName(name: string): string {
  const { minLength, maxLength } = NAMESPACE_LIMITS.artifactsRepo;
  if (name.length < minLength || name.length > maxLength) {
    throw new ArtifactsInvalidNameError({
      message: `A repository name is ${minLength} to ${maxLength} characters. "${name.slice(0, maxLength)}" is ${name.length}.`,
      params: { minLength, maxLength },
    });
  }
  if (!REPO_NAME_CHARSET.test(name)) {
    throw new ArtifactsInvalidNameError({
      message: "A repository name starts with a letter or digit, then letters, digits, `.`, `_` and `-`.",
    });
  }
  return name;
}
