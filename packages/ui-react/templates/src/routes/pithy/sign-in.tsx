import type { AuthFetch } from "@pithy-sh/auth/src/client/api";
import { sendMagicLink, startSocialSignIn } from "@pithy-sh/auth/src/client/api";
import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import type { Translator } from "@pithy-sh/core/src/i18n/translator";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { type FormEvent, type ReactNode, useCallback, useMemo, useState } from "react";
import { authConfig } from "../../pithy-config";
import { Turnstile, turnstilePending, turnstileRequest } from "../../turnstile";
// The magic link's callback URL is built from this, never from a literal of the same shape. The two are
// one statement for the reason #393 gives: renaming `callback.tsx`'s path is an edit that typechecks,
// builds, and breaks the one round trip nobody signed in can test.
import { path as callbackPath } from "./callback";
import "../../pithy-screens.css";

export const path = "/sign-in";

// The screen the router's signed-out guard sends people to. Rename `path` above and the guard follows,
// because it reads this claim rather than holding a copy of the string (#393).
export const role = "sign-in";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.
// (Guarding your home screen is one line — see `export const session` in src/routes/app/home.tsx.)

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO SLOTS. This is the part of the screen that is yours, and it ships empty.
 *
 * A sign-in page is a two-column layout: a panel that says what this product is, and the form. The
 * panel is the half no template can write for you — it is your mark, your sentence, your claims — so
 * it is a slot rather than copy you would have to find and delete. Fill it or leave it: with nothing
 * here the page is one centred column and the layout is still correct.
 *
 *   const BRAND = (
 *     <>
 *       <h2>Your data stays yours.</h2>
 *       <p>One sentence about what this is.</p>
 *     </>
 *   );
 *   const MARK = <img src="/logo.svg" alt="Acme" height={28} />;
 *
 * BRAND is the panel. MARK is the small header that appears in the form column at the widths where
 * the panel is not rendered — exactly one of the two is ever on screen, so the page carries your
 * identity at every size without saying your name twice. Both are ordinary JSX; neither is styled by
 * Pithy beyond the box it sits in.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** The panel beside the form. Yours. */
const BRAND: ReactNode = null;

/** The compact mark, for the widths the panel is not on. Yours. */
const MARK: ReactNode = null;

/**
 * This screen's English, baked in.
 *
 * **The catalog that survives being copied.** This file is written into your repository once and
 * belongs to you afterwards, so the English cannot live in a package you might never install: it lives
 * here, and a project that composes no `i18n` capability renders exactly these sentences with no
 * negotiation, no merge and no config.
 *
 * With `i18n` composed it becomes the *last* layer instead — your own catalog first, then the kit's
 * translation, then this. So a key nobody has translated still renders a sentence rather than a key.
 *
 * Edit the words here to change the English. Translate them by adding the same keys under a locale in
 * `i18n({ messages })`; the key is `<capability>/<path>` and it is the join between the two.
 */
const EN = {
  "auth/sign_in.title": "Welcome.",
  "auth/sign_in.provider.label": "Continue with {provider}",
  "auth/sign_in.provider_unconfigured": "{provider} is not configured here. Use the link instead.",
  "auth/sign_in.provider_silent": "{provider} didn't answer. Use the link instead.",
  "auth/sign_in.divider": "or",
  "auth/sign_in.email.label": "Email",
  "auth/sign_in.submit": "Email me a link",
  "auth/sign_in.signup.prompt": "No account yet?",
  "auth/sign_in.signup.answer": "Signing in creates one.",
  "auth/sign_in.signup.closed": "Existing accounts only.",
  "auth/sign_in.sent.title": "Check your inbox.",
  "auth/sign_in.sent.body": "If that address can sign in, a link is on its way. The link expires shortly.",
} satisfies MessageCatalog;

/** The auth capability's client-safe projection — the half of it this screen reads. */
export interface AuthProjection {
  /** Where the auth handler mounts, e.g. `/auth`. */
  readonly basePath: string;
  /** Which social providers are switched on in `pithy.config.ts`. Credentials never reach a browser. */
  readonly providers: Readonly<Record<string, boolean>>;
  /** Whether signing in may provision a new account. Drives one sentence of copy. */
  readonly signUpEnabled: boolean;
}

/** The humanity check, injected so this module never has to know whether one is composed. */
export interface HumanityCheck {
  /** The widget itself. Rendered inside the form, above the submit. */
  readonly widget: ReactNode;
  /** True while the check still owes a token, so the gated submit stays disabled. */
  readonly pending: boolean;
  /** Puts the token where the middleware reads it — a body field, or a header. */
  readonly attach: (body: Record<string, unknown>) => {
    body: Record<string, unknown>;
    headers: Record<string, string>;
  };
}

/** No check at all: what the screen does when the turnstile capability is not composed. */
const NO_CHECK: HumanityCheck = { widget: null, pending: false, attach: (body) => ({ body, headers: {} }) };

export interface SignInScreenProps {
  /**
   * The translator this screen renders through.
   *
   * A prop for the reason `fetch` and `redirect` are: what a screen says in a second language is a
   * *rendered* fact no assertion about source text can reach. Absent, the screen reads the provider a
   * `TranslatorProvider` mounted, and with no provider it reads {@link EN}.
   */
  readonly t?: Translator;
  /** The auth capability's projection. */
  readonly auth: AuthProjection;
  /** The humanity check. Absent means none is composed. */
  readonly check?: HumanityCheck;
  /** The panel beside the form. Absent means one column. */
  readonly brand?: ReactNode;
  /** The compact mark, shown where the panel is not. */
  readonly mark?: ReactNode;
  /** The fetch to use. Undefined in the browser, which is the point of it being optional. */
  readonly fetch?: AuthFetch;
  /** This page's origin, which the callback URL is built against. */
  readonly origin?: string;
  /** How the browser leaves for a provider. Injected so a test never navigates. */
  readonly redirect?: (url: string) => void;
}

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROVIDER MARKS, AND THE TERMS THEY SHIP UNDER.
 *
 * These are trademarks, not icons. **Nothing in this block is covered by Pithy's MIT licence** — each
 * mark belongs to the company it names, and using it is governed by that company's brand terms rather
 * than by ours. They are shipped because a sign-in button without a mark is a worse first screen than
 * one with it, and because the alternative is every adopter reaching for the wrong asset (see the note
 * about Font Awesome below). What you are responsible for is checking your use against the terms
 * linked beside each mark before you ship.
 *
 * **The rules are opposite from one provider to the next, and that is why these are four components
 * rather than one parameterised `<Mark provider="…" />`.** A shared abstraction would have to encode
 * "unless it is Google" somewhere, and the first tidy-up would lose it. The rule lives beside the
 * asset it governs. Keep it there.
 *
 * **Never hand-draw one.** A wrong-shaped official logo on a credentials page is what a phishing page
 * looks like. Every path below is the vendor's own geometry; if you add a provider and cannot source
 * accurate path data for it, ship that button with no mark rather than an approximation — the screen
 * already renders label-only buttons correctly.
 *
 * **The trap: Font Awesome's `brands/google` is a monochrome single-path G.** It is the obvious thing
 * to reach for, it is in the package most projects already have, and it is the wrong asset for a
 * sign-in button: Google's guidelines require the four-colour mark there. The same goes for any other
 * icon set's "google" glyph. If a mark below ever becomes a `currentColor` single path, that is the
 * mistake, not a simplification.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * GitHub's Invertocat.
 *
 * `currentColor`, and permitted to be: GitHub's terms ask that the mark not be modified or recoloured
 * *into another colour*, and the monochrome Invertocat is the form they publish for exactly this. So
 * it inverts with the theme for free — ink on the light surface, parchment on the dark one — with no
 * second asset and nothing for a theme toggle to wire up.
 *
 * Terms: https://github.com/logos
 */
function GithubMark(): ReactNode {
  return (
    <svg className="auth__mark" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
      />
    </svg>
  );
}

/**
 * Google's four-colour "G", at the official path data.
 *
 * **The four `fill`s are literals and must stay literals.** Google's brand terms forbid recolouring the
 * mark, so this is the one place on this screen where a colour does not answer the theme and does not
 * come from a token. Blue, green, yellow, red, in that order, on a `0 0 48 48` grid — the proportions
 * the mark is published at, scaled by `width`/`height` rather than by editing the path.
 *
 * Google's guidelines also govern the *button*: clear space around the mark, a minimum size, and the
 * words "Sign in with Google" or "Continue with Google" rather than a bare logo. This screen's
 * `aria-label` carries the second of those; check the first two against your own styling if you change
 * `.auth__provider`.
 *
 * Terms: https://developers.google.com/identity/branding-guidelines
 */
function GoogleMark(): ReactNode {
  return (
    <svg className="auth__mark" width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </svg>
  );
}

/**
 * The Apple logo, `currentColor` — and unlike GitHub's, that is a narrow permission rather than a free
 * one.
 *
 * Apple's terms allow the logo in **black or white only**. `--pithy-fg` is near-black on the light
 * surface and near-parchment on the dark one, so `currentColor` resolves to the two colours Apple
 * permits and nothing else. **If you declare a `--fg` that is neither**, this mark inherits it and
 * stops conforming — override `.auth__mark` for this button, do not recolour the page and hope.
 *
 * Apple additionally specifies the whole button for "Sign in with Apple": its background, corner
 * radius, minimum size, and the wording. Pithy's `.auth__provider` is a generic secondary button and
 * makes no claim to satisfy that — read the guidelines before you enable this provider in production.
 *
 * Terms: https://developer.apple.com/design/human-interface-guidelines/sign-in-with-apple
 */
function AppleMark(): ReactNode {
  return (
    <svg className="auth__mark" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"
      />
    </svg>
  );
}

/**
 * Meta's "f" badge, in Facebook Blue — fixed, like Google's, not inherited.
 *
 * Meta's terms fix the colour: the blue mark on a light field, or the white mark on a dark one, and
 * never a recolour. The published path is the badge with the "f" cut *out* of it, so a single fill
 * would let whatever is behind show through the letter — and on a dark surface that is a near-black
 * "f" on blue, which is neither of the two forms they permit. The white disc behind it is the mark's
 * own outer edge (r=12 on a `0 0 24 24` grid), so what renders is the blue-on-white form at every
 * width and in both themes. It is the mark placed on a white field, not the mark altered.
 *
 * Terms: https://about.meta.com/brand/resources/facebookapp/logo
 */
function FacebookMark(): ReactNode {
  return (
    <svg className="auth__mark" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#FFFFFF" />
      <path
        fill="#1877F2"
        d="M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z"
      />
    </svg>
  );
}

/**
 * The providers `virtual:pithy/auth` can name, in the order they render, each with its mark.
 *
 * Only the ones enabled in `pithy.config.ts` appear at all — there is no CLI flag for this and never
 * will be, because a flag would freeze the list into scaffolded code at the moment you ran the command.
 * Config is the source of truth; a redeploy is the only step.
 */
const SOCIAL: readonly { id: string; label: string; mark: ReactNode }[] = [
  { id: "google", label: "Google", mark: <GoogleMark /> },
  { id: "github", label: "GitHub", mark: <GithubMark /> },
  { id: "apple", label: "Apple", mark: <AppleMark /> },
  { id: "facebook", label: "Facebook", mark: <FacebookMark /> },
];

/** Why a provider button did not take you anywhere. Two faults, because they need two sentences. */
type Refusal = { provider: string; reason: "unconfigured" | "silent" } | null;

function refusalText(t: Translator, refusal: NonNullable<Refusal>): string {
  const key = refusal.reason === "unconfigured" ? "auth/sign_in.provider_unconfigured" : "auth/sign_in.provider_silent";
  return t.t(key, { provider: refusal.provider });
}

/**
 * The frame. One shape in every state, so nothing on screen moves when the state changes.
 *
 * `data-brand` is what lets the stylesheet lay out an empty slot correctly: with no panel there is no
 * second column to split, and the form centres on the page instead of hugging one edge of it.
 */
function Frame(props: { brand: ReactNode; mark: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="auth" data-brand={props.brand ? "set" : "none"}>
      {props.brand ? <aside className="auth__brand">{props.brand}</aside> : null}
      <section className="auth__credentials">
        <div className="auth__form">
          {/* The mark, for the widths where the panel is not rendered. CSS decides which; there is no
              JavaScript branch on width, because a second tree is a second thing to keep correct. */}
          {props.mark ? <div className="auth__form-mark">{props.mark}</div> : null}
          {props.children}
        </div>
      </section>
    </div>
  );
}

/**
 * The screen, with every seam as a prop.
 *
 * **One way in: a magic link.** This shipped with "Email me a code" beside it. Two passwordless paths
 * on one screen is two things to explain, two surfaces to rate-limit, and two inboxes' worth of mail
 * for one intent. The link is the one that needs no retyping, so it is the one that stayed — and
 * `routes/pithy/otp.tsx` is still there if you would rather have the code.
 *
 * **Social is never gated by the humanity check.** An OAuth redirect carries no token and the provider
 * runs its own bot defense, so the check disables the submit and nothing else — which is what
 * `@pithy-sh/auth` already assumes when it stacks the check on the magic-link route only.
 */
export function SignInScreen(props: SignInScreenProps): ReactNode {
  const { auth } = props;
  // Called unconditionally, and chosen from afterwards: `props.t ?? useTranslator(EN)` would skip the
  // hook whenever the prop is passed, which is a hook count that changes between renders.
  const baked = useTranslator(EN);
  const t = props.t ?? baked;
  const check = props.check ?? NO_CHECK;
  // Where the auth routes are, and the fetch to reach them with. Everything else about the request —
  // the base-path join, the cookie mode, the same-origin refusal, the failure directions — belongs to
  // `@pithy-sh/auth`, so it can still be fixed after this file has been copied into your repository.
  const client = { basePath: auth.basePath, fetch: props.fetch };
  const origin = props.origin ?? window.location.origin;
  const redirect =
    props.redirect ??
    ((url: string) => {
      window.location.href = url;
    });

  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal>(null);

  const offered = SOCIAL.filter((provider) => auth.providers[provider.id]);

  async function sendLink(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    await sendMagicLink({ email, callbackURL: `${origin}${callbackPath}` }, { ...client, gate: check.attach });
    setBusy(false);
    // Always the same answer, whether or not the address is registered. Telling the two apart is an
    // enumeration oracle, so neither the copy nor the timing of it confirms either way.
    setSent(true);
  }

  async function social(provider: { id: string; label: string }): Promise<void> {
    setRefusal(null);
    // No humanity check here, deliberately: the redirect carries no token and the provider runs its own
    // bot defense. `startSocialSignIn` drops one even if it is passed, so this cannot be forgotten.
    const started = await startSocialSignIn({ provider: provider.id, callbackURL: `${origin}${callbackPath}` }, client);
    if (started.kind === "authorize") {
      redirect(started.url);
      return;
    }
    // A URL we could read but could not follow means the provider is on with no credential behind it;
    // anything else means our own server did not answer. Different faults, different copy.
    setRefusal({ provider: provider.label, reason: started.kind === "unconfigured" ? "unconfigured" : "silent" });
  }

  if (sent) {
    return (
      <Frame brand={props.brand} mark={props.mark}>
        <h1>{t.t("auth/sign_in.sent.title")}</h1>
        <p className="muted">{t.t("auth/sign_in.sent.body")}</p>
      </Frame>
    );
  }

  return (
    <Frame brand={props.brand} mark={props.mark}>
      <h1>{t.t("auth/sign_in.title")}</h1>

      {/* The providers first, and the refusal line directly under them — a failure belongs beside the
          control that caused it, not at the foot of the screen where it reads as being about the form. */}
      {offered.length > 0 && (
        <>
          <div className="auth__providers">
            {offered.map((provider) => (
              <button
                key={provider.id}
                type="button"
                className="secondary auth__provider"
                aria-label={t.t("auth/sign_in.provider.label", { provider: provider.label })}
                onClick={() => void social(provider)}
              >
                {/* The mark is decorative and `aria-hidden`; the visible label is the one word. The
                    `aria-label` carries what the button *does*, because "Google" alone announces a
                    company rather than an action — and it contains the visible word, so voice control
                    still matches "click Google" (WCAG 2.5.3, Label in Name). */}
                {provider.mark}
                <span>{provider.label}</span>
              </button>
            ))}
          </div>
          {refusal && <p className="auth__failed">{refusalText(t, refusal)}</p>}
          <div className="divider">{t.t("auth/sign_in.divider")}</div>
        </>
      )}

      <form className="stack" onSubmit={(event) => void sendLink(event)}>
        <div>
          <label htmlFor="email">{t.t("auth/sign_in.email.label")}</label>
          <input
            id="email"
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>

        {/* The host that gives the widget the column's width to fill. See `.auth__check`, and note that
            the host is only half of it — `turnstile.tsx` asks for the `flexible` size. */}
        <div className="auth__check">{check.widget}</div>

        <button type="submit" disabled={busy || !email || check.pending}>
          {t.t("auth/sign_in.submit")}
        </button>
      </form>

      {/* Reassurance, not navigation. Passwordless has no sign-up screen to point at — sign-up *is*
          signing in when the capability allows it — so an anchor here would be a 404 dressed as an
          affordance. `<strong>` rather than a class: the answer is the half that carries weight, and
          emphasis is what the element means. */}
      <p className="auth__signup">
        {auth.signUpEnabled ? (
          <>
            {t.t("auth/sign_in.signup.prompt")} <strong>{t.t("auth/sign_in.signup.answer")}</strong>
          </>
        ) : (
          t.t("auth/sign_in.signup.closed")
        )}
      </p>
    </Frame>
  );
}

/** The wiring: the real projection, the real widget, and your two slots. */
export default function SignIn(): ReactNode {
  const [token, setToken] = useState<string | null>(null);
  const onToken = useCallback((value: string | null) => setToken(value), []);
  const check = useMemo<HumanityCheck>(
    () => ({
      widget: <Turnstile onToken={onToken} />,
      pending: turnstilePending(token),
      attach: (body) => turnstileRequest(body, token),
    }),
    [onToken, token],
  );
  return <SignInScreen auth={authConfig} check={check} brand={BRAND} mark={MARK} />;
}
