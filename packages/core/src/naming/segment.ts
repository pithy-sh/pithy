// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * What a single segment of a composed name may look like — one pattern, one home.
 *
 * `<project>-<env>-<thing>` is built out of segments, and every one of them answers to the same
 * shape: a project, an environment, a capability, a job. The pattern lived in three modules,
 * character for character, which is the arrangement where a rule stops being one rule — an edit to
 * the environment copy would silently leave the Workflow copy behind, and the two would disagree
 * about a name the other had already accepted.
 *
 * A capability that genuinely needs a different rule should declare its own pattern beside this one
 * with a comment saying what it allows that this does not, and why. Divergence is a decision, not a
 * stale copy. `scaffoldProject`'s `WORKER_NAME` is the standing example: a Worker *directory* under
 * `apps/` may lead with a digit, because it is a package name rather than a Cloudflare name.
 */

/**
 * A lowercase letter, then letters, digits, and single inner hyphens — no leading digit, no
 * doubled or trailing hyphen, no underscore, no uppercase.
 *
 * This is the **strictest** rule of any namespace a name reaches, and therefore the rule for all of
 * them. Cloudflare Worker script names, Workflow names, and Vectorize indexes must start with a
 * letter; D1, KV, and R2 would take `1password-clone-dev-db` happily. The loose namespaces are the
 * ones a project touches first, so holding everything to the strict rule is what keeps a name that
 * provisions from being a name that cannot deploy.
 *
 * Not `/g`: `.test()` on a global regex advances `lastIndex`, and one shared instance would answer
 * differently on alternate calls. `segment.test.ts` pins that.
 */
export const NAME_SEGMENT = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
