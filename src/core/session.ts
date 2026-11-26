// The signed-in session: Authalla's tokens, sealed into a cookie on the
// server. The browser never sees a token, so a script injected into the page
// can't take one (the OAuth 2.0 for Browser-Based Apps BCP's "backend for
// frontend" pattern).

import type { ResolvedConfig } from "./config.js";
import { cookieName, deleteChunked, readChunked, writeChunked, type CookieJar, type CookieOptions, type CookieToSet } from "./cookies.js";
import { OAuthError, readIdToken, refreshTokens, type TokenResponse } from "./oauth.js";
import { decodeJwtPayload, seal, unseal } from "./seal.js";

export type SessionUser = {
  /** The user's ID, the tokens' `sub`. It never changes. */
  id: string;
  name?: string;
  email?: string;
  emailVerified?: boolean;
  /** The user's picture, from their social login's profile, when there is one. Needs the profile scope. */
  picture?: string;
  /** Every claim of the latest ID token. */
  claims: Record<string, unknown>;
};

/** A signed-in session, as the server sees it. */
export type Session = {
  user: SessionUser;
  accessToken: string;
  idToken: string;
  /** When the access token expires, in milliseconds since the epoch. */
  expiresAt: number;
  /** The scopes the access token carries. */
  scopes: string[];
};

/** What the browser may know: the user, never the tokens. */
export type ClientSession =
  | { status: "signed-in"; user: SessionUser; expiresAt: number; scopes: string[] }
  | {
      status: "signed-out";
      /**
       * True when the session ended without the user signing out here: the
       * grant was revoked (Sign out everywhere, a suspended user) or expired.
       */
      ended: boolean;
    };

type Stored = {
  v: 1;
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope: string;
};

// An ended session stays as a marker until the user signs in or out, so the
// app can say why they're signed out instead of just showing a sign-in.
type Ended = { v: 1; ended: true };

export type StoredSession = Stored | Ended;

const PURPOSE = "session";
// Refresh this long before the access token expires, so a request doesn't
// reach an API with a token that lapses on the way.
const REFRESH_MARGIN_MS = 60_000;
// The cookie outlives the access token; the refresh token decides how long
// the session really lasts, and Authalla says when it's over.
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

export function sessionCookieName(config: ResolvedConfig): string {
  return cookieName("authalla-session", config.secureCookies);
}

export function cookieOptions(config: ResolvedConfig, maxAge: number): CookieOptions {
  return { httpOnly: true, secure: config.secureCookies, sameSite: "lax", path: "/", maxAge };
}

export function isEnded(session: StoredSession | undefined): session is Ended {
  return !!session && "ended" in session;
}

export async function readStoredSession(config: ResolvedConfig, jar: CookieJar): Promise<StoredSession | undefined> {
  const sealed = readChunked(jar, sessionCookieName(config));
  if (!sealed) return undefined;
  const session = await unseal<StoredSession>(sealed, config.secret, PURPOSE);
  return session?.v === 1 ? session : undefined;
}

export async function writeStoredSession(config: ResolvedConfig, jar: CookieJar, session: StoredSession): Promise<CookieToSet[]> {
  const sealed = await seal(session, config.secret, PURPOSE);
  return writeChunked(jar, sessionCookieName(config), sealed, cookieOptions(config, SESSION_MAX_AGE));
}

export function clearStoredSession(config: ResolvedConfig, jar: CookieJar): CookieToSet[] {
  return deleteChunked(jar, sessionCookieName(config), cookieOptions(config, 0));
}

export function storedFromTokens(
  config: ResolvedConfig,
  tokens: TokenResponse,
  nonce: string | undefined,
  previous?: Stored,
): Stored {
  // A refresh may come back without an ID token or a new refresh token;
  // the ones from before still stand.
  const idToken = tokens.id_token ?? previous?.idToken;
  if (!idToken) throw new OAuthError("invalid_id_token", "Authalla returned no ID token; ask for the openid scope", 0);
  // Checked now; read back from the token itself later, so the cookie
  // doesn't carry the claims twice.
  if (tokens.id_token) readIdToken(config, tokens.id_token, nonce);
  return {
    v: 1,
    idToken,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? previous?.refreshToken,
    expiresAt: Date.now() + (tokens.expires_in ?? 300) * 1000,
    scope: tokens.scope ?? previous?.scope ?? config.scopes.join(" "),
  };
}

export function toSession(stored: Stored): Session {
  return {
    user: userFromClaims(decodeJwtPayload(stored.idToken) ?? {}),
    accessToken: stored.accessToken,
    idToken: stored.idToken,
    expiresAt: stored.expiresAt,
    scopes: stored.scope.split(" ").filter(Boolean),
  };
}

export function toClientSession(stored: StoredSession | undefined): ClientSession {
  if (!stored) return { status: "signed-out", ended: false };
  if (isEnded(stored)) return { status: "signed-out", ended: true };
  const { user, expiresAt, scopes } = toSession(stored);
  return { status: "signed-in", user, expiresAt, scopes };
}

// Only an http(s) address, since apps put it straight into <img src> or a link.
function webUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function userFromClaims(claims: Record<string, unknown>): SessionUser {
  return {
    id: String(claims.sub),
    name: typeof claims.name === "string" && claims.name ? claims.name : undefined,
    email: typeof claims.email === "string" ? claims.email : undefined,
    emailVerified: typeof claims.email_verified === "boolean" ? claims.email_verified : undefined,
    picture: webUrl(claims.picture),
    claims,
  };
}

type RefreshOutcome = { kind: "refreshed"; session: Stored } | { kind: "ended" } | { kind: "unavailable" };

// Authalla rotates refresh tokens, and treats a rotated one presented again
// as a stolen token. A page can fire several requests at once, each carrying
// the same cookie, so refreshes of one token share a single call and its
// result for a short while. A request that set out with the old cookie
// after the rotation then gets the new tokens instead of a reuse error.
const SHARED_FOR_MS = 30_000;
const inflight: Map<string, { at: number; outcome: Promise<RefreshOutcome> }> =
  ((globalThis as Record<symbol, unknown>)[Symbol.for("authalla.refreshes")] as never) ??
  ((globalThis as Record<symbol, unknown>)[Symbol.for("authalla.refreshes")] = new Map());

async function refreshOnce(config: ResolvedConfig, stored: Stored): Promise<RefreshOutcome> {
  if (!stored.refreshToken) return { kind: "ended" };
  try {
    const tokens = await refreshTokens(config, stored.refreshToken);
    return { kind: "refreshed", session: storedFromTokens(config, tokens, undefined, stored) };
  } catch (err) {
    // invalid_grant: the grant was revoked or the refresh token expired, so
    // the session is over. Anything else (Authalla unreachable, a 5xx) may
    // pass, so the user stays signed in with the tokens they have.
    if (err instanceof OAuthError && err.error === "invalid_grant") return { kind: "ended" };
    console.error("authalla: refreshing the session failed; keeping the current tokens:", err);
    return { kind: "unavailable" };
  }
}

export function refreshStored(config: ResolvedConfig, stored: Stored): Promise<RefreshOutcome> {
  const now = Date.now();
  for (const [key, entry] of inflight) if (now - entry.at > SHARED_FOR_MS) inflight.delete(key);
  const key = stored.refreshToken ?? stored.accessToken;
  const existing = inflight.get(key);
  if (existing) return existing.outcome;
  const outcome = refreshOnce(config, stored);
  inflight.set(key, { at: now, outcome });
  return outcome;
}

export function needsRefresh(stored: Stored): boolean {
  return stored.expiresAt - Date.now() < REFRESH_MARGIN_MS;
}

export type Freshened = { stored: StoredSession | undefined; cookies: CookieToSet[] };

// freshen returns the session with an access token good for at least a
// minute more, refreshing it if needed (or always, with force), and the
// cookies that store the result.
export async function freshen(config: ResolvedConfig, jar: CookieJar, { force = false } = {}): Promise<Freshened> {
  const stored = await readStoredSession(config, jar);
  if (!stored || isEnded(stored)) return { stored, cookies: [] };
  if (!force && !needsRefresh(stored)) return { stored, cookies: [] };
  const outcome = await refreshStored(config, stored);
  switch (outcome.kind) {
    case "refreshed":
      return { stored: outcome.session, cookies: await writeStoredSession(config, jar, outcome.session) };
    case "ended": {
      const ended: Ended = { v: 1, ended: true };
      return { stored: ended, cookies: await writeStoredSession(config, jar, ended) };
    }
    case "unavailable":
      return { stored, cookies: [] };
  }
}
