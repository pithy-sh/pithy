import { sendMagicLink, sendOtp, startSocialSignIn } from "@pithy-sh/auth/src/client/api";
import { handoffCode, nativeSignInStartURL } from "@pithy-sh/auth/src/client/handoff";
// The one code a refused provider sign-in comes back with. Imported rather than spelled: a literal here and a
// literal there is a pair that can drift, and the drift would show as this block silently never rendering again.
import { NEUTRAL_PROVIDER_REFUSAL } from "@pithy-sh/auth/src/http/providerRefusal";
import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import type { Translator } from "@pithy-sh/core/src/i18n/translator";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { useRead } from "@pithy-sh/ui-core/src/read";
import { screenPath } from "@pithy-sh/ui-core/src/routes";
import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from "@react-native-google-signin/google-signin";
import * as AppleAuthentication from "expo-apple-authentication";
import { CryptoDigestAlgorithm, digestStringAsync, getRandomBytes } from "expo-crypto";
import * as WebBrowser from "expo-web-browser";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { Platform, Pressable, Text, TextInput, useWindowDimensions, View } from "react-native";
import { authConfig, googleClientIds, origin, universalLinkOrigin } from "../../pithy-config";
import { appLink, onDevice, parseLink, parseQuery, queryString } from "../../platform";
import { Redirect, routeTable, useGo, useSearch, useSearchParam } from "../../router";
import {
  abandonHandoff,
  afterSignIn,
  beginHandoff,
  completeHandoff,
  type IdTokenUser,
  leaveInPlace,
  refusedAccountScreen,
  resumeQuery,
  returnLink,
  type SignInOutcome,
  signInWithIdToken,
} from "../../session";
import { type Theme, useTheme } from "../../theme";
import { transport } from "../../transport";
import { Turnstile, turnstilePending, turnstileRequest } from "../../turnstile";
// Every link that returns to the app is built from this, never from a literal of the same shape: renaming
// `callback.tsx`'s path is an edit that typechecks, builds, and would break the one round trip nobody signed in
// can test.
import { path as callbackPath } from "./callback";
import { path as otpPath } from "./otp";

export const path = "/sign-in";

// The screen the router's signed-out guard sends people to. Rename `path` above and the guard follows, because it
// reads this claim rather than holding a copy of the string.
export const role = "sign-in";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.
// (Guarding your home screen is one line: see `export const session` in src/routes/app/home.tsx.)

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO SLOTS. This is the part of the screen that is yours, and it ships empty.
 *
 * On a wide screen, a tablet or a desktop browser, sign-in is two columns: a panel that says what this product
 * is, and the form. The panel is your mark, your sentence, your claims, so it is a slot rather than copy you
 * would have to find and delete. Fill it or leave it: with nothing here the screen is one column.
 *
 *   const BRAND = (
 *     <>
 *       <Text>Your data stays yours.</Text>
 *       <Text>One sentence about what this is.</Text>
 *     </>
 *   );
 *   const MARK = <Image source={require("../../../assets/logo.png")} style={{ height: 28 }} />;
 *
 * BRAND is the panel. MARK is the small header above the form on a narrow screen, where the panel is not drawn,
 * so exactly one of the two is on screen at any width.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** The panel beside the form. Yours. */
const BRAND: ReactNode = null;

/** The compact mark, for the widths the panel is not on. Yours. */
const MARK: ReactNode = null;

/** The width from which the panel is drawn beside the form. */
const TWO_COLUMNS = 768;

/**
 * This screen's English, baked in.
 *
 * This file is written into your repository once and belongs to you afterwards, so the English lives here, and a
 * project that composes no `i18n` capability renders exactly these sentences. With `i18n` composed it becomes the
 * last layer instead: your own catalog first, then the kit's translation, then this.
 */
const EN = {
  "auth/sign_in.title": "Welcome.",
  "auth/sign_in.provider.label": "Continue with {provider}",
  "auth/sign_in.provider_unconfigured": "{provider} is not configured here. Use the link instead.",
  "auth/sign_in.provider_silent": "{provider} didn't answer. Use the link instead.",
  // The three-point refusal, and the order is the point: say what the provider told us, say that a secondary
  // address is refused on purpose, then say the remedy. Not one word about whether the account exists: the
  // Worker sends one code for "no account" and "not attached", and every sentence below is true of both.
  "auth/sign_in.refused.title": "{provider} didn't sign you in.",
  "auth/sign_in.refused.primary":
    "{provider} gives us one address: the primary on your account. That one did not get you in here.",
  "auth/sign_in.refused.secondary":
    "A secondary address will not do it. Sign-in never looks past the primary, deliberately.",
  "auth/sign_in.refused.remedy":
    "Sign in with your email, then connect {provider} from your profile. After that, this works whatever your primary is.",
  "auth/sign_in.divider": "or",
  "auth/sign_in.email.label": "Email",
  "auth/sign_in.submit": "Email me a link",
  "auth/sign_in.signup.prompt": "No account yet?",
  "auth/sign_in.signup.answer": "Signing in creates one.",
  "auth/sign_in.signup.closed": "Existing accounts only.",
  // Said instead of `signup.answer` when a provider on this screen may sign people in but not create an account.
  "auth/sign_in.signup.email_only":
    "Emailing you a link creates one. The buttons above sign in existing accounts only.",
  "auth/sign_in.sent.title": "Check your inbox.",
  "auth/sign_in.sent.body": "If that address can sign in, a link is on its way. The link expires shortly.",
  // On a phone with no universal link the email path is a one-time code, so the copy that names the link names the
  // code instead. Keyed under the code screen's domain: on the sign-in screen's own keys, a code is never offered.
  "auth/otp.ask.submit": "Email me a code",
  "auth/otp.ask.provider_unconfigured": "{provider} is not configured here. Use a code instead.",
  "auth/otp.ask.provider_silent": "{provider} didn't answer. Use a code instead.",
  "auth/otp.ask.signup_email_only":
    "Emailing you a code creates one. The buttons above sign in existing accounts only.",
} satisfies MessageCatalog;

/** The auth capability's client-safe projection: the half of it this screen reads. */
export interface AuthProjection {
  /** Which social providers are switched on in `pithy.config.ts`. Credentials never reach the app. */
  readonly providers: Readonly<Record<string, boolean>>;
  /** Which of those may **create** an account, from each provider's `allowSignUp`. Absent means none refuses. */
  readonly providerSignUp?: Readonly<Record<string, boolean>>;
  /** Whether signing in may provision a new account. Drives one sentence of copy. */
  readonly signUpEnabled: boolean;
}

/** The humanity check, injected so this module never has to know whether one is composed. */
export interface HumanityCheck {
  /** The widget itself. Rendered inside the form, above the submit. */
  readonly widget: ReactNode;
  /** True while the check still owes a token, so the gated submit stays disabled. */
  readonly pending: boolean;
  /** Puts the token where the middleware reads it: a body field, or a header. */
  readonly attach: (body: Record<string, unknown>) => {
    body: Record<string, unknown>;
    headers: Record<string, string>;
  };
}

/** No check at all: what the screen does when the turnstile capability is not composed. */
const NO_CHECK: HumanityCheck = { widget: null, pending: false, attach: (body) => ({ body, headers: {} }) };

export interface SignInScreenProps {
  /** The translator this screen renders through. Absent, the screen reads the mounted provider, or {@link EN}. */
  readonly t?: Translator;
  /** The auth capability's projection. */
  readonly auth: AuthProjection;
  /** The humanity check. Absent means none is composed. */
  readonly check?: HumanityCheck;
  /** The panel beside the form. Absent means one column. */
  readonly brand?: ReactNode;
  /** The compact mark, shown where the panel is not. */
  readonly mark?: ReactNode;
}

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROVIDER BUTTONS CARRY NO MARK, except Apple's on iOS.
 *
 * Provider logos are trademarks, each under its owner's brand terms, and React Native draws no SVG without
 * `react-native-svg`. A hand-drawn approximation of a logo on a credentials screen is what a phishing page looks
 * like, so the buttons ship as words. If you add a mark, use the owner's published asset and check your use
 * against their terms: Google's (https://developers.google.com/identity/branding-guidelines) require the
 * four-color "G", never a single-color glyph.
 *
 * On iOS, Apple is Apple's own `AppleAuthenticationButton`, which draws the mark, the words and the shape its
 * guidelines require.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** The providers the auth projection can name, in the order they render. */
const SOCIAL: readonly { id: string; label: string }[] = [
  { id: "google", label: "Google" },
  { id: "github", label: "GitHub" },
  { id: "apple", label: "Apple" },
  { id: "facebook", label: "Facebook" },
  { id: "microsoft", label: "Microsoft" },
];

/**
 * Why a provider button did not sign you in. `unconfigured` and `silent` are learned on this screen; `refused`
 * is the provider's answer, from the link the sign-in came back on or from the Worker's answer to a native token.
 * **`refused` and not `no_account`**: the Worker deliberately does not say whether the account exists.
 */
type Refusal = { provider: string; reason: "unconfigured" | "silent" | "refused" } | null;

function refusalText(t: Translator, refusal: NonNullable<Refusal>, byCode: boolean): string {
  const key =
    refusal.reason === "unconfigured"
      ? byCode
        ? "auth/otp.ask.provider_unconfigured"
        : "auth/sign_in.provider_unconfigured"
      : byCode
        ? "auth/otp.ask.provider_silent"
        : "auth/sign_in.provider_silent";
  return t.t(key, { provider: refusal.provider });
}

/**
 * Whether email signs in with a one-time code rather than a magic link: on a phone with no universal link. A magic
 * link returns to the link it was asked for, and whoever asks for it is not who opens it. A custom scheme is one
 * any app can claim, so the Worker hands a magic link off only to an https universal link (iOS) or app link
 * (Android), which the system opens only in the app that owns the domain. Set `universalLinkOrigin` and the link is
 * back.
 */
function emailByCode(): boolean {
  return onDevice() && universalLinkOrigin === null;
}

/**
 * The refusal the Worker sent back on the link, read off it. The provider half is this screen's own: it wrote the
 * id into `errorCallbackURL` before it left, since nothing on screen survives the round trip. The id is resolved
 * through {@link SOCIAL} and never rendered, because anyone can hand somebody a `/sign-in?provider=…&error=…`
 * link, and an id nobody offers renders nothing.
 */
function linkRefusal(error: string | null, providerId: string | null): Refusal {
  if (error !== NEUTRAL_PROVIDER_REFUSAL) return null;
  const known = SOCIAL.find((candidate) => candidate.id === providerId);
  return known ? { provider: known.label, reason: "refused" } : null;
}

/** How a provider signs in here: its own SDK's id token on a phone where it has one, the redirect otherwise. */
type Way = "apple" | "google" | "redirect";

function wayFor(id: string, appleNative: boolean): Way {
  if (id === "apple" && appleNative) return "apple";
  // Google's SDK asks for an id token whose audience is the web client id, the one the Worker checks.
  if (id === "google" && onDevice() && googleClientIds.webClientId) return "google";
  return "redirect";
}

/** How a provider attempt ended: signed in or refused, or `null` when the reader backed out and nothing is said. */
type Attempt = SignInOutcome | null;

/** A provider's own SDK answered with no token: the provider is switched on with no credential behind it. */
const UNCONFIGURED = "client/provider_unconfigured";

/** Anything that is not a sign-in and not a reason this screen knows: the provider did not answer. */
const SILENT = "client/provider_silent";

/** 32 random bytes as hex: a nonce Apple's identity token is bound to. */
function rawNonce(): string {
  return Array.from(getRandomBytes(32), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The name and address Apple handed over, as the Worker takes them, or `undefined` when it handed over neither.
 * Apple sends them on an account's first sign-in only, and never inside the identity token.
 */
function appleUser(credential: AppleAuthentication.AppleAuthenticationCredential): IdTokenUser | undefined {
  const { givenName, familyName } = credential.fullName ?? {};
  const name = {
    ...(givenName ? { firstName: givenName } : {}),
    ...(familyName ? { lastName: familyName } : {}),
  };
  const user: IdTokenUser = {
    ...(givenName || familyName ? { name } : {}),
    ...(credential.email ? { email: credential.email } : {}),
  };
  return user.name || user.email ? user : undefined;
}

/**
 * Sign in with Apple on iOS. Apple is handed the SHA-256 of a fresh nonce and puts it in the identity token; the
 * Worker is sent the raw one and checks that it hashes to the token's. Apple's own sheet is the whole flow.
 */
async function appleSignIn(): Promise<Attempt> {
  const nonce = rawNonce();
  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: await digestStringAsync(CryptoDigestAlgorithm.SHA256, nonce),
    });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ERR_REQUEST_CANCELED") return null;
    return { ok: false, code: SILENT };
  }
  if (!credential.identityToken) return { ok: false, code: SILENT };
  const user = appleUser(credential);
  return signInWithIdToken("apple", { token: credential.identityToken, nonce, ...(user ? { user } : {}) });
}

/** Sign in with Google's SDK on a phone, for an id token the Worker checks against the web client id. */
async function googleSignIn(): Promise<Attempt> {
  try {
    GoogleSignin.configure({
      webClientId: googleClientIds.webClientId ?? undefined,
      ...(googleClientIds.iosClientId ? { iosClientId: googleClientIds.iosClientId } : {}),
    });
    if (Platform.OS === "android") await GoogleSignin.hasPlayServices();
    const response = await GoogleSignin.signIn();
    if (!isSuccessResponse(response)) return null;
    const token = response.data.idToken;
    if (!token) return { ok: false, code: UNCONFIGURED };
    return signInWithIdToken("google", { token });
  } catch (error) {
    if (
      isErrorWithCode(error) &&
      (error.code === statusCodes.SIGN_IN_CANCELLED || error.code === statusCodes.IN_PROGRESS)
    ) {
      return null;
    }
    return { ok: false, code: SILENT };
  }
}

function Button(props: {
  label: string;
  accessibleName?: string;
  onPress: () => void;
  disabled: boolean;
  primary?: boolean;
  theme: Theme;
}): ReactNode {
  const { theme } = props;
  return (
    <Pressable
      role="button"
      aria-label={props.accessibleName}
      disabled={props.disabled}
      onPress={props.onPress}
      style={{
        borderWidth: 1,
        borderColor: props.primary ? theme.colors.accent : theme.colors.border,
        backgroundColor: props.primary ? theme.colors.accent : theme.colors.surface,
        borderRadius: theme.radius,
        paddingVertical: theme.spacing.sm,
        paddingHorizontal: theme.spacing.md,
        minHeight: 44,
        alignItems: "center",
        justifyContent: "center",
        opacity: props.disabled ? 0.5 : 1,
      }}
    >
      <Text style={[theme.type.button, { color: props.primary ? theme.colors.onAccent : theme.colors.text }]}>
        {props.label}
      </Text>
    </Pressable>
  );
}

/** The frame. One shape in every state, so nothing on screen moves when the state changes. */
function Frame(props: { brand: ReactNode; mark: ReactNode; theme: Theme; children: ReactNode }): ReactNode {
  const { theme } = props;
  const wide = useWindowDimensions().width >= TWO_COLUMNS;
  const panel = wide && props.brand;
  return (
    <View style={{ flex: 1, flexDirection: panel ? "row" : "column", backgroundColor: theme.colors.background }}>
      {panel ? (
        <View style={{ flex: 1, padding: theme.spacing.xl, backgroundColor: theme.colors.surface }}>{props.brand}</View>
      ) : null}
      <View style={{ flex: 1, padding: theme.spacing.lg, justifyContent: "center" }}>
        <View style={{ width: "100%", maxWidth: 400, alignSelf: "center", gap: theme.spacing.md }}>
          {!panel && props.mark ? <View>{props.mark}</View> : null}
          {props.children}
        </View>
      </View>
    </View>
  );
}

/**
 * The screen, with every seam as a prop.
 *
 * **One passwordless path: the magic link.** On a phone with no universal link it is a one-time code instead, on
 * `routes/pithy/otp.tsx`, because the Worker refuses a magic link to a scheme any app can claim.
 *
 * **On a phone nothing comes back as a cookie.** The magic link and every redirect sign-in return to this app's
 * own link with a one-time code, which `callback.tsx` or this screen trades for the session; Apple on iOS and
 * Google with a web client id sign in through their own SDKs and post the id token. On the web, everything is
 * the page's cookie, exactly as the React screens hold it.
 *
 * **Social is never gated by the humanity check.** The check disables the email submit and nothing else.
 */
export function SignInScreen(props: SignInScreenProps): ReactNode {
  const { auth } = props;
  // Called unconditionally, and chosen from afterwards, so the hook count never changes between renders.
  const baked = useTranslator(EN);
  const t = props.t ?? baked;
  const theme = useTheme();
  const check = props.check ?? NO_CHECK;
  const go = useGo();
  const search = useSearch();

  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal>(null);
  const error = useSearchParam("error");
  const returned = linkRefusal(error, useSearchParam("provider"));
  // A sign-in refused for the account's standing, suspended or deleted, goes on to the screen for that state.
  const refusedAccount = refusedAccountScreen(error);

  const offered = SOCIAL.filter((provider) => auth.providers[provider.id]);
  const providerRefuses = offered.some((provider) => auth.providerSignUp?.[provider.id] === false);
  const asksApple = Platform.OS === "ios" && auth.providers.apple === true;
  const appleNative = useRead("apple-available", () => AppleAuthentication.isAvailableAsync(), {
    skip: !asksApple,
  }).value;

  // Where a sign-in returns: this app's link on a phone, carrying a verifier's challenge; this origin on the web.
  const callbackTo = `${callbackPath}${resumeQuery(search)}`;

  const byCode = emailByCode();

  async function sendLink(): Promise<void> {
    if (byCode) return sendCode();
    setBusy(true);
    const callbackURL = onDevice() ? await beginHandoff(callbackTo) : callbackTo;
    await sendMagicLink({ email, callbackURL }, { ...transport.auth, gate: check.attach });
    setBusy(false);
    // Always the same answer, whether or not the address is registered: telling the two apart is an enumeration
    // oracle.
    setSent(true);
  }

  /** Mail a one-time code and go on to the screen that takes it, with the address and whatever it should resume. */
  async function sendCode(): Promise<void> {
    setBusy(true);
    // Whatever the answer, the code screen: telling a registered address from another is an enumeration oracle.
    await sendOtp({ email, type: "sign-in" }, { ...transport.auth, gate: check.attach });
    setBusy(false);
    const resume = resumeQuery(search);
    go(`${otpPath}${queryString({ email })}${resume ? `&${resume.slice(1)}` : ""}`);
  }

  /** Where a sign-in goes when it took: the screen or the request it should resume, or home. */
  async function signedIn(): Promise<void> {
    const next = await afterSignIn(search);
    if (next !== null) go(next);
  }

  async function settle(provider: { label: string }, attempt: Attempt): Promise<void> {
    if (attempt === null) return;
    if (attempt.ok) return signedIn();
    const refused = refusedAccountScreen(attempt.code);
    if (refused) return go(screenPath(await routeTable(), refused));
    if (attempt.code === NEUTRAL_PROVIDER_REFUSAL) return setRefusal({ provider: provider.label, reason: "refused" });
    setRefusal({ provider: provider.label, reason: attempt.code === UNCONFIGURED ? "unconfigured" : "silent" });
  }

  /**
   * The redirect, on a phone. The sheet opens on the Worker's start route, which starts the sign-in there and sends
   * the sheet on to the authorization page: the provider's state cookie is set in the sheet's own jar, and the
   * sheet is what returns through the provider's callback. It closes on this app's own link: the callback with a
   * one-time code, or this screen with the provider's refusal. `errorCallbackURL` carries the provider's id so a
   * refusal can say who refused.
   *
   * With a universal link the sheet closes on one https path, so a refusal returns to the callback too, and the
   * callback hands it on to this screen.
   */
  async function redirectOnDevice(provider: { id: string }): Promise<Attempt> {
    const callbackURL = await beginHandoff(callbackTo);
    const refusedTo = universalLinkOrigin === null ? appLink(path) : returnLink(callbackPath);
    const start = nativeSignInStartURL({
      origin,
      basePath: transport.auth.basePath,
      provider: provider.id,
      callbackURL,
      errorCallbackURL: `${refusedTo}${queryString({ provider: provider.id })}`,
    });
    if (start === null) {
      await abandonHandoff();
      return { ok: false, code: SILENT };
    }
    const closesOn = universalLinkOrigin === null ? appLink("") : returnLink(callbackPath);
    const result = await WebBrowser.openAuthSessionAsync(start, closesOn);
    if (result.type !== "success") {
      await abandonHandoff();
      return null;
    }
    const code = handoffCode(result.url);
    if (code !== null) return completeHandoff(code);
    await abandonHandoff();
    const back = parseQuery(parseLink(result.url)?.search ?? "");
    if (back.error) {
      // Rendered from the link, the way the web screen renders the same refusal.
      go(`${path}${queryString({ provider: provider.id, error: back.error })}`, { replace: true });
      return null;
    }
    return { ok: false, code: SILENT };
  }

  /** The redirect, on the web: leave for the provider in this tab, and come back on the cookie. */
  async function redirectOnWeb(provider: { id: string }): Promise<Attempt> {
    const started = await startSocialSignIn(
      { provider: provider.id, callbackURL: callbackTo, errorCallbackURL: `${path}?provider=${provider.id}` },
      transport.auth,
    );
    if (started.kind === "authorize") {
      await leaveInPlace(started.url);
      return null;
    }
    return { ok: false, code: started.kind === "unconfigured" ? UNCONFIGURED : SILENT };
  }

  async function social(provider: { id: string; label: string }): Promise<void> {
    setRefusal(null);
    setBusy(true);
    const way = wayFor(provider.id, appleNative === true);
    let attempt: Attempt;
    if (way === "apple") attempt = await appleSignIn();
    else if (way === "google") attempt = await googleSignIn();
    else attempt = onDevice() ? await redirectOnDevice(provider) : await redirectOnWeb(provider);
    setBusy(false);
    await settle(provider, attempt);
  }

  if (refusedAccount) return <Redirect screen={refusedAccount} />;

  const title = (key: "auth/sign_in.title" | "auth/sign_in.sent.title") => (
    <Text role="heading" style={[theme.type.title, { color: theme.colors.text }]}>
      {t.t(key)}
    </Text>
  );
  const muted = [theme.type.body, { color: theme.colors.muted }];

  if (sent) {
    return (
      <Frame brand={props.brand} mark={props.mark} theme={theme}>
        {title("auth/sign_in.sent.title")}
        <Text style={muted}>{t.t("auth/sign_in.sent.body")}</Text>
      </Frame>
    );
  }

  const shown = returned ?? refusal;

  return (
    <Frame brand={props.brand} mark={props.mark} theme={theme}>
      {title("auth/sign_in.title")}

      {/* The providers first, and the refusal directly under them: a failure belongs beside its control. */}
      {offered.length > 0 && (
        <>
          <View style={{ gap: theme.spacing.sm }}>
            {offered.map((provider) =>
              wayFor(provider.id, appleNative === true) === "apple" ? (
                <AppleAuthentication.AppleAuthenticationButton
                  key={provider.id}
                  buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
                  buttonStyle={
                    theme.scheme === "dark"
                      ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
                      : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
                  }
                  cornerRadius={theme.radius}
                  style={{ height: 44 }}
                  onPress={() => {
                    if (!busy) void social(provider);
                  }}
                />
              ) : (
                // The visible word is the provider; the accessible name says what the button does and contains
                // that word, so voice control still matches it.
                <Button
                  key={provider.id}
                  label={provider.label}
                  accessibleName={t.t("auth/sign_in.provider.label", { provider: provider.label })}
                  disabled={busy}
                  onPress={() => void social(provider)}
                  theme={theme}
                />
              ),
            )}
          </View>
          {shown?.reason === "refused" ? (
            <View style={{ gap: theme.spacing.xs }}>
              <Text style={[theme.type.body, { color: theme.colors.danger }]}>
                {t.t("auth/sign_in.refused.title", { provider: shown.provider })}
              </Text>
              <Text style={muted}>{t.t("auth/sign_in.refused.primary", { provider: shown.provider })}</Text>
              <Text style={muted}>{t.t("auth/sign_in.refused.secondary")}</Text>
              <Text style={muted}>{t.t("auth/sign_in.refused.remedy", { provider: shown.provider })}</Text>
            </View>
          ) : (
            shown && (
              <Text style={[theme.type.body, { color: theme.colors.danger }]}>{refusalText(t, shown, byCode)}</Text>
            )
          )}
          <Text style={[theme.type.caption, { color: theme.colors.muted, textAlign: "center" }]}>
            {t.t("auth/sign_in.divider")}
          </Text>
        </>
      )}

      <View style={{ gap: theme.spacing.sm }}>
        <Text style={[theme.type.caption, { color: theme.colors.muted }]}>{t.t("auth/sign_in.email.label")}</Text>
        <TextInput
          aria-label={t.t("auth/sign_in.email.label")}
          value={email}
          onChangeText={setEmail}
          inputMode="email"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="emailAddress"
          style={[
            theme.type.body,
            {
              borderWidth: 1,
              borderColor: theme.colors.border,
              borderRadius: theme.radius,
              backgroundColor: theme.colors.surface,
              color: theme.colors.text,
              paddingVertical: theme.spacing.sm,
              paddingHorizontal: theme.spacing.md,
            },
          ]}
        />
        {check.widget}
        <Button
          label={t.t(byCode ? "auth/otp.ask.submit" : "auth/sign_in.submit")}
          primary
          disabled={busy || !email || check.pending}
          onPress={() => void sendLink()}
          theme={theme}
        />
      </View>

      {/* Reassurance, not navigation: signing up is signing in, so there is no other screen to point at. */}
      <Text style={muted}>
        {auth.signUpEnabled ? (
          <>
            {t.t("auth/sign_in.signup.prompt")}{" "}
            <Text style={{ fontWeight: "700", color: theme.colors.text }}>
              {t.t(
                providerRefuses
                  ? byCode
                    ? "auth/otp.ask.signup_email_only"
                    : "auth/sign_in.signup.email_only"
                  : "auth/sign_in.signup.answer",
              )}
            </Text>
          </>
        ) : (
          t.t("auth/sign_in.signup.closed")
        )}
      </Text>
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
