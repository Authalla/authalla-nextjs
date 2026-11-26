// Configuration for an Authalla app, read once per request so `next build`
// works without the environment and a missing value fails with its name.

export type AuthallaOptions = {
  /** The tenant's URL, e.g. https://acme.authalla.com. Default: AUTHALLA_ISSUER. */
  issuer?: string;
  /** The app's client ID. Default: AUTHALLA_CLIENT_ID. */
  clientId?: string;
  /** Only for a confidential app. Default: AUTHALLA_CLIENT_SECRET. */
  clientSecret?: string;
  /**
   * Encrypts the session cookie: at least 32 characters, random, and kept
   * secret (`openssl rand -base64 32`). Default: AUTHALLA_SECRET.
   */
  secret?: string;
  /**
   * This app's public origin, e.g. https://app.example.com. The redirect URI
   * is this plus `${basePath}/callback`. Default: AUTHALLA_APP_URL, or the
   * request's own origin outside production.
   */
  appUrl?: string;
  /** Where the SDK's route handler is mounted. Default: /api/auth. */
  basePath?: string;
  /** Scopes asked for at sign-in. Default: openid profile email offline_access. */
  scopes?: string[];
  /**
   * Where Authalla sends the browser after signing out; must be one of the
   * app's allowed logout URIs. Default: appUrl.
   */
  postLogoutRedirectUri?: string;
};

export type ResolvedConfig = {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  secret: string;
  appUrl: string;
  basePath: string;
  scopes: string[];
  redirectUri: string;
  postLogoutRedirectUri: string;
  secureCookies: boolean;
};

export const DEFAULT_SCOPES = ["openid", "profile", "email", "offline_access"];

export class ConfigError extends Error {
  name = "AuthallaConfigError";
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Where the route handler is mounted; needs no environment. */
export function basePathOf(options: AuthallaOptions): string {
  return trimSlash(options.basePath ?? "/api/auth");
}

// resolveConfig fills options from the environment. requestUrl is the
// fallback for appUrl outside production, so `next dev` on any port works.
export function resolveConfig(options: AuthallaOptions, requestUrl?: string): ResolvedConfig {
  const env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {};
  const issuer = options.issuer ?? env.AUTHALLA_ISSUER;
  const clientId = options.clientId ?? env.AUTHALLA_CLIENT_ID;
  const secret = options.secret ?? env.AUTHALLA_SECRET;
  let appUrl = options.appUrl ?? env.AUTHALLA_APP_URL;

  if (!issuer) throw new ConfigError("Set AUTHALLA_ISSUER (or the issuer option) to your Authalla tenant's URL.");
  if (!clientId) throw new ConfigError("Set AUTHALLA_CLIENT_ID (or the clientId option) to your Authalla app's client ID.");
  if (!secret || secret.length < 32) {
    throw new ConfigError(
      "Set AUTHALLA_SECRET (or the secret option) to a random value of at least 32 characters; it encrypts the session cookie. `openssl rand -base64 32` makes one.",
    );
  }
  if (!appUrl) {
    // Behind a proxy the request URL may be an internal address, which would
    // send Authalla the wrong redirect URI. Production must say.
    if (env.NODE_ENV === "production" || !requestUrl) {
      throw new ConfigError("Set AUTHALLA_APP_URL (or the appUrl option) to this app's public origin, e.g. https://app.example.com.");
    }
    appUrl = new URL(requestUrl).origin;
  }
  appUrl = trimSlash(appUrl);
  const basePath = basePathOf(options);

  return {
    issuer: trimSlash(issuer),
    clientId,
    clientSecret: options.clientSecret ?? env.AUTHALLA_CLIENT_SECRET ?? undefined,
    secret,
    appUrl,
    basePath,
    scopes: options.scopes ?? DEFAULT_SCOPES,
    redirectUri: `${appUrl}${basePath}/callback`,
    postLogoutRedirectUri: options.postLogoutRedirectUri ?? appUrl,
    secureCookies: appUrl.startsWith("https://"),
  };
}
