// The OAuth 2.1 / OpenID Connect calls to Authalla: the authorization URL,
// the code exchange, refresh, revocation and the logout URL. The endpoints
// are Authalla's fixed paths under the tenant's URL, so there is no
// discovery round trip.

import type { ResolvedConfig } from "./config.js";
import { decodeJwtPayload } from "./seal.js";

export type TokenResponse = {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
};

// OAuthError is an error Authalla answered with, e.g. invalid_grant when a
// refresh token was revoked. A network failure is a plain Error instead.
export class OAuthError extends Error {
  name = "AuthallaOAuthError";
  constructor(
    readonly error: string,
    readonly description: string | undefined,
    readonly status: number,
  ) {
    super(description ? `${error}: ${description}` : error);
  }
}

/** Parameters an app may add to the authorization request. */
export type SignInParams = {
  /** Fills in the email on Authalla's page. */
  loginHint?: string;
  /** The page's language, e.g. "fi" or "sv en" (OIDC ui_locales). */
  uiLocales?: string;
  /**
   * "create" opens on sign-up, "login" asks the user to sign in again.
   * "passkey" has a signed-in user add a passkey: they sign in again first
   * unless they did within five minutes, and choosing Not now comes back as
   * access_denied.
   */
  prompt?: "create" | "login" | "passkey";
  /** Seconds since the user last signed in before they must sign in again. */
  maxAge?: number;
};

const TIMEOUT_MS = 10_000;

export function authorizationUrl(
  config: ResolvedConfig,
  { state, nonce, codeChallenge, params }: { state: string; nonce: string; codeChallenge: string; params: SignInParams },
): string {
  const url = new URL(`${config.issuer}/oauth2/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (params.loginHint) url.searchParams.set("login_hint", params.loginHint);
  if (params.uiLocales) url.searchParams.set("ui_locales", params.uiLocales);
  if (params.prompt) url.searchParams.set("prompt", params.prompt);
  if (params.maxAge !== undefined) url.searchParams.set("max_age", String(params.maxAge));
  return url.toString();
}

// clientRequest posts a form to one of Authalla's endpoints, authenticating
// the app with HTTP Basic when it has a secret and with client_id alone when
// it is a public app.
async function clientRequest(config: ResolvedConfig, path: string, form: Record<string, string>): Promise<Response> {
  const body = new URLSearchParams(form);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (config.clientSecret) {
    const credentials = `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`;
    headers.Authorization = `Basic ${btoa(credentials)}`;
  } else {
    body.set("client_id", config.clientId);
  }
  return fetch(`${config.issuer}${path}`, {
    method: "POST",
    headers,
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function tokenRequest(config: ResolvedConfig, form: Record<string, string>): Promise<TokenResponse> {
  const response = await clientRequest(config, "/oauth2/token", form);
  const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  if (!response.ok || !body || typeof body.access_token !== "string") {
    const error = typeof body?.error === "string" ? body.error : "server_error";
    const description = typeof body?.error_description === "string" ? body.error_description : undefined;
    throw new OAuthError(error, description ?? (response.ok ? "The token response had no access token" : undefined), response.status);
  }
  return body as TokenResponse;
}

export function exchangeCode(config: ResolvedConfig, code: string, codeVerifier: string): Promise<TokenResponse> {
  return tokenRequest(config, {
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    code_verifier: codeVerifier,
  });
}

export function refreshTokens(config: ResolvedConfig, refreshToken: string): Promise<TokenResponse> {
  return tokenRequest(config, { grant_type: "refresh_token", refresh_token: refreshToken });
}

// revoke ends the grant (RFC 7009). Revoking either token revokes the whole
// grant at Authalla, refresh token included.
export async function revoke(config: ResolvedConfig, token: string, hint: "refresh_token" | "access_token"): Promise<void> {
  const response = await clientRequest(config, "/oauth2/revoke", { token, token_type_hint: hint });
  if (!response.ok) throw new OAuthError("revocation_failed", undefined, response.status);
}

export function logoutUrl(config: ResolvedConfig): string {
  const url = new URL(`${config.issuer}/oauth2/logout`);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("post_logout_redirect_uri", config.postLogoutRedirectUri);
  return url.toString();
}

// readIdToken checks the ID token's claims and returns them. The signature
// is not checked: the token came straight from Authalla's token endpoint
// over TLS, which OpenID Connect Core 3.1.3.7 accepts in place of it. The
// claims still have to be for this app, from this tenant, and carry the
// nonce this sign-in sent.
export function readIdToken(
  config: ResolvedConfig,
  idToken: string,
  expectedNonce: string | undefined,
): Record<string, unknown> {
  const claims = decodeJwtPayload(idToken);
  if (!claims) throw new OAuthError("invalid_id_token", "The ID token could not be read", 0);
  if (claims.iss !== config.issuer) {
    throw new OAuthError("invalid_id_token", `The ID token is from ${String(claims.iss)}, not ${config.issuer}`, 0);
  }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(config.clientId)) throw new OAuthError("invalid_id_token", "The ID token is for another app", 0);
  if (expectedNonce !== undefined && claims.nonce !== expectedNonce) {
    throw new OAuthError("invalid_id_token", "The ID token's nonce doesn't match this sign-in", 0);
  }
  if (typeof claims.sub !== "string" || !claims.sub) throw new OAuthError("invalid_id_token", "The ID token has no subject", 0);
  return claims;
}
