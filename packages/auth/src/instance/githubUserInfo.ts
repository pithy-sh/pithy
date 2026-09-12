// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * How `@pithy-sh/auth` resolves a GitHub identity — **primary match links, and nothing else does.**
 *
 * **The defect this replaces.** Better Auth's stock GitHub provider keeps the primary address from
 * `/user/emails`, and falls back to `emails[0]` when the profile carried no email at all. Nothing matches
 * an existing user by any other address. So a GitHub account whose primary is not the address somebody
 * signed up with cannot reach their account — and, worse, signing in mints a *second, empty* user under
 * the personal address while the real one sits untouched (pithy-sh/pithy#554). That is the common setup,
 * not an edge case: a personal primary with the work address secondary is how most people's GitHub is.
 *
 * **And matching a verified secondary is still the wrong fix.** It looks defensible — GitHub only marks
 * an address verified after delivering a confirmation to it, so a verified secondary does prove real
 * mailbox control. *At some point.* GitHub never re-verifies. A work address from a job somebody left
 * three years ago stays verified on their personal account forever, and addresses get reassigned.
 * Linking is a decision about **present** control, and a stale verified secondary can only speak to the
 * past. The cost of refusing is one extra sign-in, once: after connecting from the profile, sign-in
 * resolves by account id and the primary stops mattering permanently.
 *
 * So this module is deliberately smaller than the prior art it is lifted from. It differs from the stock
 * provider in exactly three ways, and each is load-bearing:
 *
 * 1. **It fails closed.** A fetch that does not answer resolves `null`, which is distinguishable from an
 *    account with no verified address. Collapsing the two renders a GitHub outage as "your account does
 *    not exist", which sends somebody to fix an account that is fine.
 * 2. **It branches on the OAuth state.** See {@link defaultGithubUserInfo} — this is the whole of phase 1.
 * 3. **It never falls back to a non-primary address**, and it never asserts a verified flag it did not
 *    read from GitHub.
 *
 * **Linking is Better Auth's branch, not this one, and that is worth knowing before editing here.**
 * `getUserInfo` runs at `callback.mjs:120`, upstream of the `if (link)` at `:150`, and it is handed only
 * the tokens — 1.7.1 exports no accessor that would let it read the OAuth state, so it genuinely cannot
 * tell a `/link-social` callback from a sign-in. It does not need to: what this module contributes to
 * that path is the boundary. The only address it ever returns is one GitHub reports `verified` for, so a
 * link licensed by an address GitHub never confirmed is not reachable from either flow. Linking also
 * cannot rewrite the user's own email — `applyUpdateUserInfoOnLink` returns early unless
 * `updateUserInfoOnLink` is set, and destructures `email` out even then.
 *
 * **Linking a provider whose address *differs* from the account's is not enabled here, and that is a
 * deliberate hold.** It needs `allowDifferentEmails: true`, which widens what a session alone can do —
 * and the control that pays for it has to survive `/token/rotate`, which mints a session stamped
 * `createdAt: now`. A gate on session age is therefore reset by an ordinary rotation and by any attacker
 * holding a stolen refresh token, so it needs an `authenticatedAt` that rotation carries forward. That is
 * a session-schema change and ships on its own.
 *
 * An earlier draft carried a `link` branch here that preferred the session's own address. It was dead:
 * nothing could supply the session email, so the branch never ran. It is gone rather than left as a seam
 * nobody can reach.
 */

/** One entry of GitHub's `/user/emails` page. The `verified` flag is the only thing that may license a link. */
export const GithubEmail = z
  .object({
    email: z.string().describe("The address, as GitHub spells it. Compared case-insensitively."),
    primary: z
      .boolean()
      .describe("Whether GitHub treats this as the account's primary address. Exactly one entry is primary."),
    verified: z
      .boolean()
      .describe(
        "Whether GitHub has confirmed a delivery to this address. Never asserted by the kit — a literal `true` here is the whole attack, because Better Auth performs no independent check on what a resolver returns.",
      ),
  })
  .describe("One address on a GitHub account, with the flag that decides whether it may license a link.");
export type GithubEmail = z.infer<typeof GithubEmail>;

/** The slice of GitHub's `/user` profile the kit depends on. Everything else travels through untouched. */
export const GithubProfile = z
  .object({
    id: z
      .union([z.number(), z.string()])
      .describe(
        "GitHub's account id — the subject the provider link is keyed on. Better Auth's `accountSubject` reads it, and an absent one collapses the callback into `unable_to_get_user_info`.",
      ),
    name: z
      .string()
      .nullish()
      .describe("The display name on the GitHub profile. Often unset; `login` is the fallback."),
    login: z.string().nullish().describe("The GitHub handle. What a person is called when they set no name."),
    avatar_url: z
      .string()
      .nullish()
      .describe("The profile picture GitHub serves. Becomes the user's `image` on sign-up."),
  })
  .loose()
  .describe("A GitHub profile, narrowed to the one field the kit reads and otherwise passed through whole.");
export type GithubProfile = z.infer<typeof GithubProfile>;

/** A GitHub identity: the profile, and every address the token can see. */
export interface GithubIdentity {
  /** The `/user` profile, untouched — this is what travels back as `data`. */
  profile: GithubProfile;
  /** The `/user/emails` page. Never returned to a caller; see {@link defaultGithubUserInfo}. */
  emails: readonly GithubEmail[];
}

/**
 * Parse one `/user` + `/user/emails` pair, or `null` when either is not what GitHub promises.
 *
 * **`null` rather than a partial identity, and that is the fail-closed half.** A profile with no `id` and
 * an email payload that is not a list are both GitHub failing to answer, not a user with an unusual
 * account — and the difference decides whether the operator reads "GitHub is down" or the user reads
 * "your account does not exist".
 */
export function githubIdentityFrom(profile: unknown, emails: unknown): GithubIdentity | null {
  const parsedProfile = GithubProfile.safeParse(profile);
  if (!parsedProfile.success) return null;
  const parsedEmails = z.array(GithubEmail).safeParse(emails);
  if (!parsedEmails.success) return null;
  return { profile: parsedProfile.data, emails: parsedEmails.data };
}

/** The address a sign-in resolves to, with GitHub's own flag — or `null` when the account has no primary. */
export interface ResolvedGithubEmail {
  email: string;
  emailVerified: boolean;
}

/**
 * The settled rule, as one function: **the primary entry, and its real `verified` flag.**
 *
 * `null` when there is no primary at all. Deliberately not `emails[0]`: that fallback is the second way
 * the stock provider silently picks a non-primary address, and a rule with an exception in it is not the
 * rule this issue settled.
 */
export function resolveGithubEmail(emails: readonly GithubEmail[]): ResolvedGithubEmail | null {
  const primary = emails.find((entry) => entry.primary);
  return primary ? { email: primary.email, emailVerified: primary.verified } : null;
}

/** Fetch one JSON document with a bearer token, or `null` on any failure. Injected so tests never call out. */
export type FetchJson = (url: string, accessToken: string) => Promise<unknown>;

/** What {@link defaultGithubUserInfo} needs from the world. Both injected, so the resolver is a pure unit. */
export interface GithubUserInfoDeps {
  /** Read a GitHub API document. Defaults to the real `fetch`. */
  fetchJson?: FetchJson;
}

/** What Better Auth expects back: the user fields it will write, and the raw profile it keys the account on. */
export interface GithubUserInfoResult {
  user: { email?: string; emailVerified: boolean; name: string; image?: string } & Record<string, unknown>;
  data: GithubProfile;
}

/**
 * The display name and picture, exactly as the stock provider derived them.
 *
 * **Carried because replacing `getUserInfo` replaces it wholly.** Better Auth's GitHub provider is
 * short-circuited the moment `options.getUserInfo` exists, so anything the stock resolver used to supply
 * and this one does not is simply lost — and `callback.mjs` writes `name: userInfo.name || ""` into a
 * `notNull` column. Returning only the email would have given every GitHub sign-up a blank display name
 * and no avatar, on the sign-up path only, which is exactly the path a link-flow test never walks.
 */
function profileIdentity(profile: GithubProfile): { name: string; image?: string } {
  const name = profile.name || profile.login || "";
  return profile.avatar_url ? { name, image: profile.avatar_url } : { name };
}

/**
 * A GitHub identity resolver, in the shape Better Auth's `provider.getUserInfo` expects.
 *
 * **An adopter may replace this**, which is the extension point #554 asks for: `getUserInfo` is the only
 * hook in this flow that runs before both fetches and before `mapProfileToUser`, and the only one holding
 * the OAuth token. Somebody wanting a richer ladder — match a verified secondary, present a chooser on
 * multiple matches — builds it here rather than forking the provider block.
 *
 * **The address list never travels in `data`.** `/account-info` serializes the return value to the
 * client, so every address on somebody's GitHub would be readable by the page. Only the profile goes back.
 */
export type GithubUserInfoResolver = (token: { accessToken?: string }) => Promise<GithubUserInfoResult | null>;

/** GitHub's own API, read with the token this callback was issued. */
const defaultFetchJson: FetchJson = async (url, accessToken) => {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "pithy", Accept: "application/vnd.github+json" },
  });
  if (!response.ok) return null;
  return await response.json();
};

/** The kit's resolver. See {@link GithubUserInfoResolver} and this module's own docblock for the rule. */
export function defaultGithubUserInfo(deps: GithubUserInfoDeps = {}): GithubUserInfoResolver {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  return async (token) => {
    const accessToken = token.accessToken;
    if (!accessToken) return null;
    // A single page of 100. An account with more addresses than that has a primary inside the first page
    // in every case that matters: GitHub returns the primary regardless of ordering.
    const [profile, emails] = await Promise.all([
      fetchJson("https://api.github.com/user", accessToken).catch(() => null),
      fetchJson("https://api.github.com/user/emails?per_page=100", accessToken).catch(() => null),
    ]);
    const identity = githubIdentityFrom(profile, emails);
    if (!identity) return null;

    const resolved = resolveGithubEmail(identity.emails);

    // An unverified primary resolves to *no* email rather than to an unverified match. Better Auth turns a
    // missing email into `email_not_found`, which is the safe refusal — where an unverified address would
    // be a link licensed by something GitHub never confirmed.
    const identityFields = profileIdentity(identity.profile);
    if (!resolved?.emailVerified) {
      return { user: { ...identityFields, emailVerified: false }, data: identity.profile };
    }
    return { user: { ...identityFields, email: resolved.email, emailVerified: true }, data: identity.profile };
  };
}
