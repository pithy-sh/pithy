import { type FormEvent, useCallback, useState } from "react";
import { authConfig } from "../../pithy-config";
import { navigate } from "../../router";
import { Turnstile, turnstilePending, turnstileRequest } from "../../turnstile";
import "../../pithy-screens.css";

export const path = "/sign-in";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.
// (Guarding your home screen is one line — see `export const session` in src/routes/app/home.tsx.)

/** Social providers, in the order they render. Only the ones enabled in config appear at all. */
const SOCIAL: { id: keyof typeof authConfig.providers; label: string }[] = [
  { id: "google", label: "Continue with Google" },
  { id: "apple", label: "Continue with Apple" },
  { id: "facebook", label: "Continue with Facebook" },
  { id: "github", label: "Continue with GitHub" },
];

interface Redirect {
  url: string;
}

/**
 * A provider redirect we are willing to follow.
 *
 * The scheme check is the point. `window.location.href = url` with a `javascript:` URL executes that
 * script in this page, so a response body is not something to hand straight to the navigator however
 * trusted its origin. `@pithy-sh/email` makes the same http(s)-only check before following a tracked
 * link, for the same reason. An OAuth authorization endpoint is always https, so nothing legitimate
 * is turned away.
 */
function isRedirect(value: unknown): value is Redirect {
  const url = (value as { url?: unknown } | null)?.url;
  if (typeof url !== "string") return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

export default function SignIn() {
  const [email, setEmail] = useState("");
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const onToken = useCallback((value: string | null) => setCaptcha(value), []);

  const enabledSocial = SOCIAL.filter((provider) => authConfig.providers[provider.id]);

  async function post(url: string, body: Record<string, unknown>): Promise<Response> {
    const request = turnstileRequest(body, captcha);
    return fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", ...request.headers },
      body: JSON.stringify(request.body),
    });
  }

  async function sendLink(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    await post(`${authConfig.basePath}/sign-in/magic-link`, {
      email,
      callbackURL: `${window.location.origin}/callback`,
    }).catch(() => undefined);
    setBusy(false);
    // Always the same answer, whether or not the address is registered. Telling the two apart is an
    // enumeration oracle, so the copy never confirms either way.
    setSent(true);
  }

  async function sendCode(): Promise<void> {
    setBusy(true);
    await post(`${authConfig.basePath}/email-otp/send-verification-otp`, { email, type: "sign-in" }).catch(
      () => undefined,
    );
    setBusy(false);
    navigate(`/otp?email=${encodeURIComponent(email)}`);
  }

  async function social(provider: string): Promise<void> {
    const response = await fetch(`${authConfig.basePath}/sign-in/social`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, callbackURL: `${window.location.origin}/callback` }),
    });
    const body: unknown = await response.json();
    if (isRedirect(body)) window.location.href = body.url;
  }

  if (sent) {
    return (
      <main className="screen">
        <h1>Check your inbox.</h1>
        <p className="muted">If that address can sign in, a link is on its way. The link expires shortly.</p>
      </main>
    );
  }

  return (
    <main className="screen">
      <h1>Sign in.</h1>
      <p className="muted">
        {authConfig.signUpEnabled
          ? "No password. Signing in creates your account if you don't have one."
          : "No password."}
      </p>

      <form className="stack" onSubmit={(event) => void sendLink(event)}>
        <div>
          <label htmlFor="email">Email</label>
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

        {/* The humanity check gates the magic-link and OTP routes only. No social button sits behind it. */}
        <Turnstile onToken={onToken} />

        <button type="submit" disabled={busy || !email || turnstilePending(captcha)}>
          Email me a link
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy || !email || turnstilePending(captcha)}
          onClick={() => void sendCode()}
        >
          Email me a code
        </button>
      </form>

      {enabledSocial.length > 0 && (
        <>
          <div className="divider">or</div>
          <div className="stack">
            {enabledSocial.map((provider) => (
              <button key={provider.id} type="button" className="secondary" onClick={() => void social(provider.id)}>
                {provider.label}
              </button>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
