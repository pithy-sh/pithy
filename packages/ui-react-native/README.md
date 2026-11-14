# @pithy-sh/ui-react-native

The React Native front end for a Pithy app: the Expo templates `pithy ui add react-native` copies into `apps/<app>/`, and the stand-ins that test them without a device.

**Documentation: [`docs/UI.md`](../../docs/UI.md) § *React Native*.** What the app is and how it reaches the Worker. Every flag, file and output of the command is [`docs/commands/ui.md`](../../docs/commands/ui.md).

## Testing screens without a device

React Native's entry is untransformed Flow that only Metro loads, so a screen does not run in plain Node. `nativeTestProject` gives Vitest a project that does run it:

- happy-dom as the environment.
- `react-native` resolved to the app's own `react-native-web`, for every importer, kit packages included.
- Each native module aliased to a stand-in under this package's `testing/`.
- Metro's `require.context` answered with an empty directory.
- After each test, every stand-in back to a fresh install, and `I18nManager.isRTL` back to `false`.

```ts
// apps/<app>/vitest.config.ts
import { nativeTestProject } from "@pithy-sh/ui-react-native/testing/vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [nativeTestProject({ include: ["src/**/*.test.{ts,tsx}"] })],
  },
});
```

| Option | Default | |
|---|---|---|
| `include` | required | The test files, as globs from the project root |
| `src` | `src` | The directory holding the app's `payments-store.ts` and `payments-store.native.ts`, from the project root or absolute |
| `name` | `native` | The project's name in Vitest's output and `--project` |

`vitest` is an optional peer: only the preset needs it.

### Driving a stand-in

A test imports a stand-in's controls from `@pithy-sh/ui-react-native/testing/<file>`. That is the same module the alias hands the screen, so the controls drive what the screen calls.

```ts
import { secureStore } from "@pithy-sh/ui-react-native/testing/expo-secure-store";

secureStore.items.set("some-key", "a stored value");
secureStore.failing = true; // every call now rejects
```

| Module | Import from `testing/` | Controls |
|---|---|---|
| `expo-secure-store` | `expo-secure-store` | `secureStore.items`, a `Map`. `failing` rejects every call. `slowWrites`, a promise, holds every write until it settles |
| `@react-native-async-storage/async-storage` | `async-storage` | `asyncStorage.items`, a `Map` |
| `expo-constants` | `expo-constants` | `constants.expoConfig.extra`, the `extra` the app config handed the build, empty by default. Setting `pithyDevOrigin` there is the origin `pithy dev` exported, which a dev build calls in place of a loopback `origins.dev` |
| `expo-crypto` | `expo-crypto` | `cryptoStub.minted`, every `randomUUID` handed out. Randomness and SHA-256 are Web Crypto's, so they are real |
| `expo-router` | `expo-router` | `expoRouter.visit(href)` lands on a path as a deep link would. `history` logs each `push` and `replace`. `place` is the current pathname and params |
| `expo-linking` | `expo-linking` | `linking.scheme`, `pithyapp` by default. `opened` logs every `openURL` |
| `expo-localization` | `expo-localization` | `localization.setDevice(tags)` changes the device's languages while the app runs. Arabic, Hebrew, Persian and Urdu read right to left. `locales` holds the current list |
| `expo-web-browser` | `expo-web-browser` | `webBrowser.authResult` is what the next `openAuthSessionAsync` answers, `{ type: "cancel" }` by default. `opened` and `authSessions` log what was opened |
| `expo-apple-authentication` | `expo-apple-authentication` | `apple.next` is the next sign-in's credential, or the `Error` it throws. Apple's cancellation is an error with `code: "ERR_REQUEST_CANCELED"`. `available` and `requests` |
| `@react-native-google-signin/google-signin` | `google-signin` | `google.next` is the next sign-in's response, or the `Error` it throws. `configured` is what the app configured it with |
| `expo-iap` | `expo-iap` | `iap.products` is the catalog. `requests` logs every purchase asked for. `complete(purchase)` and `fail(error)` play the store's answer to the listeners, once the app has connected. `available`, `finished`, `restores`, `connects`, `loads`, and the failure switches `unreachable`, `connectThrows`, `requestRejects` and `finishFailing` |
| `@expo/app-integrity` | `expo-app-integrity` | `appIntegrity.supported` is iOS's `isSupported`, read when the screen's modules load, so set it before importing them. `failing`, an `Error`, rejects every call, as a device without App Attest or Play services does. `calls` logs each call with what it was handed, so a test can check the key generated, the challenge attested over and the Play Integrity `requestHash` |
| `react-native-webview` | `react-native-webview` | `webViews.last()` is the newest WebView's props, to post a message as the page would or ask whether a navigation is let through. `mounted` holds them all |

A screen's `./payments-store` goes to `testing/payments-store.ts`, which loads the app's own `payments-store.native.ts` when `Platform.OS` is `ios` or `android` and `payments-store.ts` otherwise, on each call. A test picks the platform by setting `Platform.OS`; one that sets it again calls `vi.resetModules()` so the screen loads afresh.

## Adding it to an existing app

`pithy init --react-native` and `pithy ui add react-native` write all of this, except in a project whose root `vitest.config.ts` would run the app's tests in plain Node. There, `pithy ui add react-native` writes no screen tests and prints the one line that adds them: add `"apps/<app>/**"` to the root config's `node` project `exclude`, then run the same command again.

An app scaffolded before this release can also be set up by hand, in four steps.

1. Add the devDependencies to `apps/<app>/package.json`: `vitest`, `happy-dom`, `@testing-library/react` and `@pithy-sh/ui-react-native`, at the range the app's other `@pithy-sh/*` packages use. `react-native-web` is already a dependency. Then install.
2. Write `apps/<app>/vitest.config.ts` as above.
3. Add `"test": "vitest run"` to the app's `scripts`.
4. Leave the app out of the root `vitest.config.ts`. Its `node` project collects `apps/*/src/**/*.test.{ts,tsx}` in plain Node, where a screen does not load. Add the app to that project's `exclude`:

```ts
exclude: ["apps/*/src/**/*.workers.test.{ts,tsx}", "apps/<app>/**"],
```

A project scaffolded now does step 4 for itself: its root config leaves out any `apps/<name>` with a `vitest.config.ts` of its own.

## License

MIT — adopter-side app value. The root `LICENSE` covers it.
