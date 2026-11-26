// The session for one request, whichever way a framework hands over its
// cookies. It owns the rule that keeps refresh-token rotation safe: refresh
// only where the new tokens can be stored. Where they can't (a Next.js
// Server Component), a refresh would rotate the refresh token without
// storing the new one, the browser's next request would present the old
// one, and Authalla would treat that as theft and end the session. There
// the session is read as it is, and a proxy keeps it fresh.

import type { ResolvedConfig } from "./config.js";
import { applyToJar, type CookieJar, type CookieToSet } from "./cookies.js";
import { logoutUrl, OAuthError, revoke } from "./oauth.js";
import { clearStoredSession, freshen, isEnded, readStoredSession, toClientSession, toSession, type ClientSession, type Session, type StoredSession } from "./session.js";

/** A request's cookies, as a framework hands them over. */
export type RequestCookies = {
  /** The cookies the request came with. */
  jar: CookieJar;
  /** Stores cookies on the response. Absent where the framework can't, such as a Server Component. */
  set?: (cookies: CookieToSet[]) => void;
};

export type UserApiCall = {
  method: string;
  /** Under /me/v1, e.g. "" or "/passkeys/pk_1". */
  path: string;
  /** The query string, with its "?", or "". */
  search?: string;
  body?: string;
  contentType?: string;
};

export type RequestSession = ReturnType<typeof requestSession>;

export function requestSession(config: ResolvedConfig, cookies: RequestCookies) {
  let jar = cookies.jar;
  const canStore = cookies.set !== undefined;

  function store(toSet: CookieToSet[]): void {
    if (toSet.length === 0) return;
    cookies.set!(toSet);
    jar = applyToJar(jar, toSet);
  }

  function active(stored: StoredSession | undefined): Session | null {
    return stored && !isEnded(stored) ? toSession(stored) : null;
  }

  /**
   * The signed-in session, or null. Where cookies can be stored, an access
   * token that expires within a minute is refreshed first, which also finds
   * out if the grant was revoked; force refreshes now. Elsewhere it's read
   * as it is, and force throws.
   */
  async function current({ force = false }: { force?: boolean } = {}): Promise<Session | null> {
    if (!canStore) {
      if (force) throw new Error("authalla: refreshing needs a Server Action or Route Handler, where the new tokens can be stored.");
      return active(await readStoredSession(config, jar));
    }
    const result = await freshen(config, jar, { force });
    store(result.cookies);
    return active(result.stored);
  }

  /** The session as the browser may see it: the user, no tokens. Never refreshes. */
  async function client(): Promise<ClientSession> {
    return toClientSession(await readStoredSession(config, jar));
  }

  /**
   * Revokes the grant, clears the session, and returns where to send the
   * browser: Authalla's logout, which comes back to the app. The caller
   * must have checked the request is the app's own.
   */
  async function signOut(): Promise<string> {
    if (!canStore) throw new Error("authalla: signing out needs a Server Action or Route Handler, where cookies can be changed.");
    const stored = await readStoredSession(config, jar);
    let reachable = true;
    if (stored && !isEnded(stored)) {
      try {
        // Ending the grant first means the tokens stop working even if the
        // browser never reaches Authalla's logout below.
        if (stored.refreshToken) await revoke(config, stored.refreshToken, "refresh_token");
        else await revoke(config, stored.accessToken, "access_token");
      } catch (err) {
        // An answer, even a refusal, means Authalla is up.
        reachable = err instanceof OAuthError;
        console.error("authalla: revoking the grant at sign-out failed; signing out here anyway:", err);
      }
    }
    store(clearStoredSession(config, jar));
    // Without Authalla its logout page would be the browser's error page, so
    // the user stays here, signed out of the app.
    return reachable ? logoutUrl(config) : config.postLogoutRedirectUri;
  }

  /**
   * Calls Authalla's User API (/me/v1) with the session's access token. 401
   * when nobody is signed in. A name change refreshes the session where it
   * can be stored, so the ID token, and auth(), carry the new name. Throws
   * when Authalla can't be reached.
   */
  async function callUserApi({ method, path, search = "", body, contentType }: UserApiCall): Promise<Response> {
    const session = await current();
    if (!session) return Response.json({ error: "unauthorized", message: "Not signed in" }, { status: 401 });
    const response = await fetch(`${config.issuer}/me/v1${path}${search}`, {
      method,
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": contentType ?? "application/json" }),
      },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok && method === "PATCH" && path === "" && canStore) await current({ force: true });
    return response;
  }

  return {
    /** Whether cookies can be stored here. */
    canStore,
    current,
    client,
    signOut,
    callUserApi,
    /** The cookies as the rest of this request sees them, after any stored here. */
    jar: () => jar,
  };
}
