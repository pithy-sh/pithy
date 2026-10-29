// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import {
  AUTH_BASE_PATH,
  type AuthClientOptions,
  type AuthFetch,
  type AuthRequestInit,
  type AuthResponse,
  type AuthResult,
  callAuth,
  isBareOrigin,
  resolveFetch,
  withoutCookies,
} from "./api";

/**
 * The bearer half of `@pithy-sh/auth`'s client: how a program this Worker does not serve — a native app —
 * holds a session and presents it.
 *
 * **The credential is the raw session token**, the `token` a sign-in answers with and the `refreshToken`
 * `/token/rotate` answers with. Never the JWT `accessToken` beside it, which the kit's own routes do not
 * accept, and never the signed `set-auth-token` header, which the Worker cannot match against a spent
 * credential. Only the raw token lets a replay be recognized as one.
 *
 * **It lives in memory and persists through a {@link SecureStore}**, the Keychain or the Keystore on a
 * phone (`expo-secure-store`). Nothing here writes to `AsyncStorage` or `localStorage`.
 *
 * **Rotation is single-flight, and the successor is stored before anything uses it.** `/token/rotate`
 * spends the credential it is shown. A second rotation of the same credential is refused, and one more
 * than thirty seconds late is read as theft: every session descended from that sign-in is revoked. So
 * one rotation is ever in flight, every request that arrives during it waits for it, and none proceeds
 * until the successor is in the store — a launch that read the spent one back would present it.
 *
 * Nothing here throws. A store that fails costs persistence, never a crash, and every failure on the
 * wire is an {@link AuthResult}.
 */

/** Where a credential is persisted between launches. `expo-secure-store`'s three calls have this shape. */
export interface SecureStore {
  /** The value stored under `key`, or `null`. */
  getItem(key: string): Promise<string | null>;
  /** Store `value` under `key`. */
  setItem(key: string, value: string): Promise<void>;
  /** Remove whatever is stored under `key`. */
  deleteItem(key: string): Promise<void>;
}

/** The device a sign-in registers. The Worker lists it, and revoking it signs out its sessions. */
export interface DeviceInfo {
  /** A stable id the app mints once per install, at most 128 characters. */
  id: string;
  /** The platform the app runs on. */
  platform: "ios" | "android" | "web";
  /** A human label for the device, when the platform gives one. */
  name?: string;
  /** The hardware model, when the platform gives one. */
  model?: string;
}

/** A bearer session: the transport every client call takes, and the credential behind it. */
export interface BearerSession {
  /** `{ origin, basePath, fetch }`. Pass it to every auth call. */
  readonly options: AuthClientOptions;
  /**
   * A fetch that adds `Authorization` when a credential is held, sends no cookie, and rotates first when
   * the credential is due. Another capability's client takes it as its own `fetch`.
   */
  readonly fetch: AuthFetch;
  /** Load the credential an earlier launch stored. `true` when one was found. */
  restore(): Promise<boolean>;
  /** Hold the raw session token a sign-in answered with. Resolves once it is stored. */
  adopt(token: string): Promise<void>;
  /** Trade the credential for its successor. Concurrent calls share one request. */
  rotate(): Promise<AuthResult<{ expiresAt: string }>>;
  /** Forget the credential here and in the store. Sign-out calls this after the server call. */
  clear(): Promise<void>;
  /** Whether a credential is held. */
  signedIn(): boolean;
  /**
   * The `Authorization` value a request to `url` would carry now, rotating first when due, for a request the
   * platform sends itself rather than through {@link BearerSession.fetch}: an image the app draws. `null` when
   * nothing is held, and for any URL off the Worker's origin, so the credential is still only ever presented there.
   */
  authorization(url: string): Promise<string | null>;
}

/** The key a credential is stored under by default. */
export const BEARER_STORAGE_KEY = "pithy.auth.session";

/**
 * How long before its expiry a credential is rotated.
 *
 * Wide enough to absorb a phone's clock running a few minutes off the Worker's, narrow enough that a
 * short configured session lifetime does not rotate on every request.
 */
export const ROTATION_MARGIN_MS = 10 * 60_000;

/** The request headers the Worker reads a device from at sign-in. */
export const BEARER_DEVICE_HEADERS = {
  id: "x-pithy-device-id",
  platform: "x-pithy-platform",
  name: "x-pithy-device-name",
  model: "x-pithy-device-model",
} as const;

/** The longest device id the Worker stores. A longer one would fail the sign-in, so none is sent. */
const MAX_DEVICE_ID = 128;

/** The credential, and when it stops working if that is known. */
interface Held {
  token: string;
  expiresAt: number | null;
}

/** Whether a value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What `/token/rotate` answers with, as far as this client reads it. */
function isRotation(value: unknown): value is { refreshToken: string; expiresAt: string } {
  return (
    isRecord(value) &&
    typeof value.refreshToken === "string" &&
    value.refreshToken !== "" &&
    typeof value.expiresAt === "string"
  );
}

/** An ISO instant as epoch milliseconds, or `null` when it is not one. */
function instant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** A stored credential read back, or `null` when the value is not one this module wrote. */
function readHeld(raw: string | null): Held | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.token !== "string" || parsed.token === "") return null;
  const expiresAt = typeof parsed.expiresAt === "number" && Number.isFinite(parsed.expiresAt) ? parsed.expiresAt : null;
  return { token: parsed.token, expiresAt };
}

/**
 * A header value `fetch` will send: printable ASCII only, trimmed, or nothing.
 *
 * `fetch` rejects a header value outside Latin-1, so a phone named with a curly apostrophe or an emoji
 * would otherwise turn every sign-in from it into an unreachable Worker.
 */
function headerValue(value: string | undefined): string | null {
  if (value === undefined) return null;
  const cleaned = value.replace(/[^\x20-\x7e]/g, "").trim();
  return cleaned === "" ? null : cleaned;
}

/** The device headers a sign-in carries, or none when the id is one the Worker would refuse. */
function deviceHeaders(device: DeviceInfo): Record<string, string> {
  const id = headerValue(device.id);
  if (id === null || id.length > MAX_DEVICE_ID) return {};
  const headers: Record<string, string> = {
    [BEARER_DEVICE_HEADERS.id]: id,
    [BEARER_DEVICE_HEADERS.platform]: device.platform,
  };
  const name = headerValue(device.name);
  if (name !== null) headers[BEARER_DEVICE_HEADERS.name] = name;
  const model = headerValue(device.model);
  if (model !== null) headers[BEARER_DEVICE_HEADERS.model] = model;
  return headers;
}

/**
 * Start a bearer session against the Worker at `origin`.
 *
 * Nothing is held until {@link BearerSession.restore} or {@link BearerSession.adopt}. Device headers
 * ride on every request to the auth routes, so whichever route creates the session registers the
 * device; requests to another capability's routes carry the credential alone.
 * A URL off `origin` is refused before it is sent, so the credential is only ever presented to this Worker.
 *
 * The expiry is learnt from what the Worker says: each rotation's `expiresAt`, and the session a
 * `get-session` describes. Until one of those has been seen, nothing rotates on its own. A `get-session`
 * that answers nobody means the credential is dead, and it is forgotten.
 */
export function createBearerSession(input: {
  origin: string;
  basePath?: string;
  store: SecureStore;
  device: DeviceInfo;
  fetch?: AuthFetch;
  now?: () => number;
  storageKey?: string;
}): BearerSession {
  const { origin, store } = input;
  const basePath = input.basePath ?? AUTH_BASE_PATH;
  const key = input.storageKey ?? BEARER_STORAGE_KEY;
  const now = input.now ?? Date.now;
  const device = deviceHeaders(input.device);
  const authPrefix = `${origin}${basePath}/`;
  const sessionUrl = `${origin}${basePath}/get-session`;

  let held: Held | null = null;
  // Bumped by every adopt and clear, so a rotation or a restore that started under an older credential
  // never writes over a newer one.
  let generation = 0;
  let inflight: Promise<AuthResult<{ expiresAt: string }>> | null = null;

  async function persist(next: Held): Promise<void> {
    try {
      await store.setItem(key, JSON.stringify(next));
    } catch {
      // A stored credential that is not the live one is worse than none: after a rotation it is spent,
      // and presenting it later revokes the family. Remove it, and hold the live one in memory.
      await forget();
    }
  }

  async function forget(): Promise<void> {
    try {
      await store.deleteItem(key);
    } catch {
      // Nothing left to try. The next launch reads whatever the store kept, and the Worker decides.
    }
  }

  /** Whether the credential may be presented to `url`: the Worker's own origin, and nowhere else. */
  function ownOrigin(url: string): boolean {
    return isBareOrigin(origin) && url.startsWith(`${origin}/`);
  }

  function send(url: string, init: AuthRequestInit | undefined, token: string | null): Promise<AuthResponse> {
    // The credential is for this Worker alone. A URL anywhere else — another host, a host that merely
    // starts with this one, a relative path the platform would resolve somewhere unknown — is refused
    // the way `fetch` refuses, so the caller's client reports it unreachable and nothing is presented.
    // The origin itself is held to the shape `callAuth` holds it to: one with userinfo or a path in it would make
    // the prefix test below name another host.
    if (!ownOrigin(url)) {
      return Promise.reject(new TypeError("A bearer session only sends to its own Worker's origin."));
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(init?.headers ?? {})) {
      if (name.toLowerCase() !== "authorization") headers[name] = value;
    }
    if (url.startsWith(authPrefix)) Object.assign(headers, device);
    if (token !== null) headers.authorization = `Bearer ${token}`;
    const underlying = resolveFetch({ fetch: input.fetch });
    if (!underlying) return Promise.reject(new TypeError("No fetch is available to send this request."));
    return underlying(url, withoutCookies({ ...init, headers }));
  }

  function due(): boolean {
    return held !== null && held.expiresAt !== null && now() >= held.expiresAt - ROTATION_MARGIN_MS;
  }

  async function runRotation(): Promise<AuthResult<{ expiresAt: string }>> {
    const started = generation;
    const token = held?.token ?? null;
    let status = 0;
    const recording: AuthFetch = async (url, init) => {
      const response = await send(url, init, token);
      status = response.status;
      return response;
    };
    const result = await callAuth(
      "/token/rotate",
      { method: "POST" },
      { origin, basePath, fetch: recording },
      isRotation,
    );
    const current = started === generation;
    if (!result.ok) {
      if (current && status === 401) await clear();
      return result;
    }
    if (current) {
      const next = { token: result.value.refreshToken, expiresAt: instant(result.value.expiresAt) };
      held = next;
      await persist(next);
    }
    return { ok: true, value: { expiresAt: result.value.expiresAt } };
  }

  function rotate(): Promise<AuthResult<{ expiresAt: string }>> {
    if (inflight) return inflight;
    const running = runRotation().finally(() => {
      if (inflight === running) inflight = null;
    });
    inflight = running;
    return running;
  }

  function observeSession(body: unknown, presented: string): void {
    // A rotation since the request left replaced the credential it describes, and an adopt or a clear
    // replaced or dropped it: either way the answer is about a credential this session no longer holds.
    if (held === null || held.token !== presented) return;
    if (body === null) {
      // A rotation in flight may have spent the presented credential, so the null can be about a
      // credential whose successor is on its way. Decide once the rotation settles.
      if (inflight) {
        const settle = () => {
          if (held !== null && held.token === presented) void clear();
        };
        void inflight.then(settle, settle);
        return;
      }
      void clear();
      return;
    }
    if (!isRecord(body) || !isRecord(body.session)) return;
    const expiresAt = instant(body.session.expiresAt);
    if (expiresAt === null || expiresAt === held.expiresAt) return;
    held = { token: held.token, expiresAt };
    void persist(held);
  }

  /** Wait out a rotation in flight, or start one when the credential is due. */
  async function current(): Promise<void> {
    if (inflight) await inflight;
    else if (due()) await rotate();
  }

  const sessionFetch: AuthFetch = async (url, init) => {
    await current();
    const token = held?.token ?? null;
    const response = await send(url, init, token);
    if (token === null || url !== sessionUrl || !response.ok) return response;
    return {
      ok: response.ok,
      status: response.status,
      json: async () => {
        const body = await response.json();
        observeSession(body, token);
        return body;
      },
    };
  };

  async function clear(): Promise<void> {
    generation += 1;
    held = null;
    await forget();
  }

  return {
    options: { origin, basePath, fetch: sessionFetch },
    fetch: sessionFetch,
    async restore() {
      // An adopt, a clear or a rotation while the store is read makes what it reads stale: after a rotation it
      // is the spent credential, and presenting that to a later rotation revokes the family.
      const started = generation;
      const before = held;
      let raw: string | null;
      try {
        raw = await store.getItem(key);
      } catch {
        return false;
      }
      if (started !== generation || held !== before) return held !== null;
      const restored = readHeld(raw);
      if (restored === null) {
        if (raw !== null) await forget();
        return false;
      }
      held = restored;
      return true;
    },
    async adopt(token) {
      generation += 1;
      const next = { token, expiresAt: null };
      held = next;
      await persist(next);
    },
    rotate,
    clear,
    signedIn: () => held !== null,
    async authorization(url) {
      if (!ownOrigin(url)) return null;
      await current();
      return held === null ? null : `Bearer ${held.token}`;
    },
  };
}
