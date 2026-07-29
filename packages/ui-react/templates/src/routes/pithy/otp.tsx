import { useCallback, useRef, useState } from "react";
import { authConfig } from "../../pithy-config";
import { navigate } from "../../router";
import { Turnstile, turnstilePending, turnstileRequest } from "../../turnstile";

export const path = "/otp";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.

export default function Otp() {
  const email = new URLSearchParams(window.location.search).get("email") ?? "";
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

  async function verify(): Promise<void> {
    setBusy(true);
    setError(false);
    const response = await fetch(`${authConfig.basePath}/sign-in/email-otp`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, otp: code }),
    }).catch(() => undefined);
    setBusy(false);
    if (response?.ok) navigate("/");
    else setError(true);
  }

  async function resend(): Promise<void> {
    const request = turnstileRequest({ email, type: "sign-in" }, captcha);
    await fetch(`${authConfig.basePath}/email-otp/send-verification-otp`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", ...request.headers },
      body: JSON.stringify(request.body),
    }).catch(() => undefined);
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
