// The part of `metro-proxy.cjs` the app's TypeScript calls: `app.config.ts` reads the Worker's dev origin with it.

/**
 * The origin `pithy dev` exports in `env` for the Worker `ui.worker` names in the app at `appDir`, or `null` when
 * the app names no Worker or the variable is unset or empty.
 */
export function exportedOrigin(appDir: string, env: Readonly<Record<string, string | undefined>>): string | null;
