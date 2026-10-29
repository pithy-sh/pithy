import { type AuthClientOptions, type AuthFetch, resolveFetch, withoutCookies } from "@pithy-sh/auth/src/client/api";
import {
  type BearerSession,
  createBearerSession,
  type DeviceInfo,
  type SecureStore,
} from "@pithy-sh/auth/src/client/bearer";
import { CONSENT_VISITOR_HEADER } from "@pithy-sh/consent/src/client/api";
import type { OrganizationClientOptions } from "@pithy-sh/organization/src/client/api";
import { randomUUID } from "expo-crypto";
import * as ExpoSecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { authConfig, consentConfig, origin } from "./pithy-config";
import { devicePlatform } from "./platform";

/**
 * How this app reaches its Worker: one decision, made once, from the platform it runs on.
 *
 * **On a phone the session is a bearer credential.** There is no page origin and no cookie jar, so every call goes
 * to the Worker's absolute origin, sends no cookie, and carries `Authorization: Bearer`. The credential is the raw
 * session token a sign-in answered with, held in memory and kept in the Keychain or the Keystore through
 * `expo-secure-store`, never in AsyncStorage. `@pithy-sh/auth/src/client/bearer` rotates it before it expires.
 *
 * **On the web the session is the page's httpOnly cookie**, exactly as the React screens hold it: calls are
 * relative, and nothing here stores anything. The web build is served from the Worker's own origin.
 *
 * Every client takes its options from here, so a screen never decides the transport itself: auth calls take
 * {@link Transport.auth}, organization calls {@link Transport.organization}, and payments and any other
 * capability {@link Transport.capability}.
 */

/** Where the device's own id is kept. */
export const DEVICE_ID_KEY = "pithy.device.id";

/** Where the visitor id consent knows a signed-out phone by is kept. */
export const CONSENT_VISITOR_KEY = "pithy.consent.visitor";

/** `expo-secure-store`, in the shape the bearer session persists through. */
export const secureStore: SecureStore = {
  getItem: (key) => ExpoSecureStore.getItemAsync(key),
  setItem: (key, value) => ExpoSecureStore.setItemAsync(key, value),
  deleteItem: (key) => ExpoSecureStore.deleteItemAsync(key),
};

/** The hardware React Native reports, as a label and a model. iOS reports only what kind of device it is. */
function hardware(): { name?: string; model?: string } {
  if (Platform.OS === "android") {
    const { Manufacturer, Model } = Platform.constants ?? {};
    if (!Model) return {};
    return { name: `${Manufacturer ?? ""} ${Model}`.trim(), model: Model };
  }
  if (Platform.OS === "ios") {
    const idiom = Platform.constants?.interfaceIdiom;
    if (idiom === "phone") return { name: "iPhone" };
    if (idiom === "pad") return { name: "iPad" };
  }
  return {};
}

/**
 * The device a sign-in registers: an id minted once per install and kept in the secure store, the platform, and
 * what React Native says about the hardware. A store that refuses costs the id's permanence, never the sign-in.
 */
export async function deviceInfo(store: SecureStore, platform: DeviceInfo["platform"]): Promise<DeviceInfo> {
  let id: string | null = null;
  try {
    id = await store.getItem(DEVICE_ID_KEY);
  } catch {
    id = null;
  }
  if (id === null || id === "") {
    id = randomUUID();
    try {
      await store.setItem(DEVICE_ID_KEY, id);
    } catch {
      // Kept for this launch only. The next launch registers as a new device.
    }
  }
  return { id, platform, ...hardware() };
}

/**
 * The id consent holds a signed-out choice against, minted once per install and kept in the secure store. It is
 * its own random UUID, never the device id: that one is registered at sign-in and listed to operators, and consent
 * takes whoever sends its visitor id to be that visitor. A store that refuses costs the id's permanence.
 */
export async function consentVisitor(store: SecureStore): Promise<string> {
  let id: string | null = null;
  try {
    id = await store.getItem(CONSENT_VISITOR_KEY);
  } catch {
    id = null;
  }
  if (id !== null && id !== "") return id;
  const minted = randomUUID();
  try {
    await store.setItem(CONSENT_VISITOR_KEY, minted);
  } catch {
    // Kept for this launch only. A choice made now is not found on the next launch.
  }
  return minted;
}

/** An image on the Worker, as React Native's `<Image source>` takes it. */
export interface WorkerImage {
  /** Where it is: an absolute URL on a phone, the path itself on the web. */
  readonly uri: string;
  /** The credential a phone's request for it carries. Absent on the web, where the page's cookie goes with it. */
  readonly headers?: Record<string, string>;
}

/**
 * `path` when it is a rooted path on the Worker, or `null`: one leading slash, nothing that reads as a second one,
 * and no control character, so prefixing the origin cannot name another host.
 */
function workerPath(path: string): string | null {
  if (!path.startsWith("/") || path[1] === "/" || path[1] === "\\") return null;
  for (const char of path) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || char === "\\") return null;
  }
  return path;
}

/** Client options that present one credential, the one held when they were made. */
export interface PinnedCredential {
  /** Pass to an `@pithy-sh/auth` client call. */
  readonly auth: AuthClientOptions;
  /** Spread into any other capability's client options. */
  readonly capability: { readonly origin: string; readonly fetch: AuthFetch };
}

/** What every client call takes, and the credential behind it. */
export interface Transport {
  /** True on a phone, where the credential is a bearer token. */
  readonly bearer: boolean;
  /** Pass to every `@pithy-sh/auth` client call. */
  readonly auth: AuthClientOptions;
  /** Pass to every `@pithy-sh/organization` client call. */
  readonly organization: OrganizationClientOptions;
  /** Spread into any other capability's client options, such as payments'. */
  readonly capability: { readonly origin?: string; readonly fetch?: AuthFetch };
  /** The bearer session, restored from the store on first use; `null` on the web. */
  session(): Promise<BearerSession | null>;
  /** Hold the raw session token a sign-in answered with. Stored before it resolves. Nothing on the web. */
  adopt(token: string): Promise<void>;
  /** Forget the credential here and in the store, after the server's sign-out. Nothing on the web. */
  forget(): Promise<void>;
  /**
   * Run `listener` each time the credential this device holds is adopted or forgotten: someone signed in or out.
   * Answers a function that stops it. Never runs on the web, where the cookie changes out of sight.
   */
  onChange(listener: () => void): () => void;
  /**
   * The credential held now, fixed: every call made through what this answers presents exactly it, whatever is
   * adopted or forgotten meanwhile, so what one call learns about whose credential it is stays true of the next
   * call sent with it. A rotation since leaves it spent, and the Worker refuses it. `null` when nothing is held,
   * and on the web, where the cookie cannot be held still.
   */
  pinned(): Promise<PinnedCredential | null>;
  /**
   * How to draw an image the Worker serves at `path`, such as an organization's mark: `<Image>` makes its own
   * request, so on a phone it is handed the origin and the credential. `null` for anything but a path on the Worker.
   */
  image(path: string): Promise<WorkerImage | null>;
}

/** What {@link createTransport} is built from. The app's own is {@link transport}. */
export interface TransportInput {
  readonly platform: "ios" | "android" | "web";
  readonly origin: string;
  readonly authBasePath: string;
  /** Where consent's routes mount. A phone's calls under it carry the visitor id consent knows it by. */
  readonly consentBasePath: string;
  readonly store: SecureStore;
  /** The fetch under the session. The platform's own by default. */
  readonly fetch?: AuthFetch;
}

/** A transport for `platform`: bearer to `origin` on a phone, the page's cookie on the web. */
export function createTransport(input: TransportInput): Transport {
  const { platform, store } = input;
  if (platform === "web") {
    return {
      bearer: false,
      auth: { basePath: input.authBasePath },
      organization: {},
      capability: {},
      session: async () => null,
      adopt: async () => undefined,
      forget: async () => undefined,
      onChange: () => () => undefined,
      pinned: async () => null,
      image: async (path) => {
        const own = workerPath(path);
        return own === null ? null : { uri: own };
      },
    };
  }

  let opened: Promise<BearerSession> | null = null;
  const open = (): Promise<BearerSession> => {
    opened ??= (async () => {
      const session = createBearerSession({
        origin: input.origin,
        basePath: input.authBasePath,
        store,
        device: await deviceInfo(store, platform),
        ...(input.fetch ? { fetch: input.fetch } : {}),
      });
      await session.restore();
      return session;
    })();
    return opened;
  };
  // The session's own fetch, once it is open: it adds the credential, rotates it when due, and refuses any
  // address off the Worker's origin.
  const fetch: AuthFetch = async (url, init) => (await open()).fetch(url, init);
  // Signed out, a phone has no cookie for consent to know its visitor by, so consent's requests carry its own id.
  let visitor: Promise<string> | null = null;
  const consentPrefix = `${input.origin}${input.consentBasePath}/`;
  const capabilityFetch: AuthFetch = async (url, init) => {
    if (!url.startsWith(consentPrefix)) return fetch(url, init);
    visitor ??= consentVisitor(store);
    return fetch(url, { ...init, headers: { ...init?.headers, [CONSENT_VISITOR_HEADER]: await visitor } });
  };
  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const listener of [...listeners]) listener();
  };

  return {
    bearer: true,
    auth: { origin: input.origin, basePath: input.authBasePath, fetch },
    organization: { origin: input.origin, fetch },
    capability: { origin: input.origin, fetch: capabilityFetch },
    session: open,
    adopt: async (token) => {
      await (await open()).adopt(token);
      changed();
    },
    forget: async () => {
      await (await open()).clear();
      changed();
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    pinned: async () => {
      const authorization = await (await open()).authorization(`${input.origin}/`);
      if (authorization === null) return null;
      const held: AuthFetch = (url, init) => {
        if (!url.startsWith(`${input.origin}/`)) {
          return Promise.reject(new TypeError("A pinned credential only goes to the Worker's own origin."));
        }
        const underlying = resolveFetch({ fetch: input.fetch });
        if (!underlying) return Promise.reject(new TypeError("No fetch is available to send this request."));
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(init?.headers ?? {})) {
          if (name.toLowerCase() !== "authorization") headers[name] = value;
        }
        headers.authorization = authorization;
        return underlying(url, withoutCookies({ ...init, headers }));
      };
      return {
        auth: { origin: input.origin, basePath: input.authBasePath, fetch: held },
        capability: { origin: input.origin, fetch: held },
      };
    },
    image: async (path) => {
      const own = workerPath(path);
      if (own === null) return null;
      const uri = `${input.origin}${own}`;
      const authorization = await (await open()).authorization(uri);
      return authorization === null ? { uri } : { uri, headers: { authorization } };
    },
  };
}

/** This app's transport. */
export const transport: Transport = createTransport({
  platform: devicePlatform(),
  origin,
  authBasePath: authConfig.basePath,
  consentBasePath: consentConfig.basePath,
  store: secureStore,
});
