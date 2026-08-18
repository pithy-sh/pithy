import { sendOtp, signInWithOtp } from "@pithy-sh/auth/src/client/api";
import { useCallback, useRef, useState } from "react";
import { authConfig } from "../../pithy-config";
import { navigate, useSearchParam } from "../../router";
import { Turnstile, turnstilePending, turnstileRequest } from "../../turnstile";
import "../../pithy-screens.css";

export const path = "/otp";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.
//
// **Nothing sends anyone here by default.** The sign-in screen offers one way in — the magic link —
// because two passwordless paths on one screen is two things to explain, two surfaces to rate-limit,
// and two inboxes' worth of mail for one intent. This screen stays because the server route behind it
// does: if you would rather have a code, send one from your own screen and route here with
// `navigate(`/otp?email=${encodeURIComponent(email)}`)`.
//
// **The email stays a query parameter, now that `/otp/:email` is expressible.** A path parameter
// identifies the thing a URL points at, and this URL points at the code entry screen — the address is
// a prefill, not the resource. `/otp` with no email is a valid screen and renders "your inbox", which
// a path segment cannot say without an optional-segment rule the router deliberately does not have.
// Nothing mails a link here either, so the argument for identifiers in the path — that a link is the
// way in — does not apply. And an address in a path is PII in every access log and referrer along the
// way: the same argument that favours the path for a token, pointing the other way for an email.

export default function Otp() {
  const email = useSearchParam("email") ?? "";
  const [digits, setDigits] = useState<string[]>(() => Array.from({ length: authConfig.otpLength }, () => ""));
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const onToken = useCallback((value: string | null) => setCaptcha(value), []);

  const code = digits.join("");

  function setDigit(index: number, value: string): void {
    const digit = value.replace(/\D/g, "").slice(-1);
    setDigits((current) => current.map((existing, position) => (position === index ? digit : existing)));
    if (digit && index + 1 < authConfig.otpLength) inputs.current[index + 1]?.focus();
  }

  // Where the auth routes are. Both calls below name an intent and nothing about transport: the
  // base-path join, the cookie mode and the failure directions belong to `@pithy-sh/auth`, which can
  // still fix them after this file is yours.
  const client = { basePath: authConfig.basePath };

  async function verify(): Promise<void> {
    setBusy(true);
    setError(false);
    const result = await signInWithOtp({ email, otp: code }, client);
    setBusy(false);
    if (result.ok) navigate("/");
    else setError(true);
  }

  async function resend(): Promise<void> {
    // The gate goes on the send route and not on the verify one, which is where `@pithy-sh/auth`
    // stacks the humanity check: a code that was already mailed is not a surface worth challenging.
    await sendOtp({ email, type: "sign-in" }, { ...client, gate: (body) => turnstileRequest(body, captcha) });
  }

  return (
    <main className="screen">
      <h1>Enter the code.</h1>
      <p className="muted">
        We sent {authConfig.otpLength} digits to {email || "your inbox"}.
      </p>

      <div className="otp">
        {digits.map((digit, index) => (
          <input
            // The inputs are a fixed-length positional row; the position is the identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity here
            key={index}
            ref={(element) => {
              inputs.current[index] = element;
            }}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={1}
            value={digit}
            onChange={(event) => setDigit(index, event.target.value)}
          />
        ))}
      </div>

      {error && <p className="muted">That code didn't work. Try again, or send a new one.</p>}

      <div className="stack">
        <button type="button" disabled={busy || code.length < authConfig.otpLength} onClick={() => void verify()}>
          Sign in
        </button>
        {/* Resending goes back through the gated send route, so the widget belongs here too. */}
        <Turnstile onToken={onToken} />
        <button
          type="button"
          className="secondary"
          disabled={busy || turnstilePending(captcha)}
          onClick={() => void resend()}
        >
          Send a new code
        </button>
      </div>
    </main>
  );
}
