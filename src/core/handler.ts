// The SDK's route handler, on Web-standard Request and Response so any
// framework that speaks them can mount it. Under basePath (default
// /api/auth):
//
//   GET  /signin      starts a sign-in at Authalla
//   GET  /callback    Authalla's redirect back; stores the session
//   POST /signout     revokes the grant, then Authalla's logout
//   GET  /session     the session as the browser may see it
//   POST /refresh     new tokens now, e.g. after changing the user's name
//   *    /me[/…]      the User API (/me/v1/…) with the session's token

import { ERROR_DESCRIPTION_PARAM, ERROR_PARAM, ERROR_PROMPT_PARAM } from "./constants.js";
import { resolveConfig, type AuthallaOptions, type ResolvedConfig } from "./config.js";
import { applyToJar, cookieName, parseCookieHeader, serializeCookie, type CookieJar, type CookieToSet } from "./cookies.js";
import { authorizationUrl, exchangeCode, logoutUrl, OAuthError, revoke, type SignInParams } from "./oauth.js";
import { readSignInParams } from "./sign-in-path.js";
import { randomString, seal, sha256Base64Url, unseal } from "./seal.js";
import {
  clearStoredSession,
  cookieOptions,
  freshen,
  isEnded,
  readStoredSession,
  storedFromTokens,
  toClientSession,
  writeStoredSession,
} from "./session.js";

type PendingSignIn = { state: string; verifier: string; nonce: string; returnTo: string; prompt?: SignInParams["prompt"] };

const PENDING_PURPOSE = "pending-sign-in";
// Long enough to sign up and read an email code; short enough that a
// forgotten tab can't finish a sign-in tomorrow.
const PENDING_MAX_AGE = 15 * 60;


function pendingCookieName(config: ResolvedConfig): string {
  return cookieName("authalla-signin", config.secureCookies);
}

function respond(body: BodyInit | null, init: ResponseInit, cookies: CookieToSet[] = []): Response {
  const headers = new Headers(init.headers);
  for (const cookie of cookies) headers.append("Set-Cookie", serializeCookie(cookie));
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return new Response(body, { ...init, headers });
}

function json(value: unknown, status = 200, cookies: CookieToSet[] = []): Response {
  return respond(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }, cookies);
}

function redirect(location: string, cookies: CookieToSet[] = [], status = 303): Response {
  return respond(null, { status, headers: { Location: location } }, cookies);
}

// safeReturnTo keeps a sign-in's destination on this app: only a path, so a
// crafted link can't use the sign-in to send the user to another site.
export function safeReturnTo(config: ResolvedConfig, returnTo: string | null | undefined): string {
  if (!returnTo || !returnTo.startsWith("/") || returnTo.startsWith("//") || returnTo.startsWith("/\\")) return "/";
  try {
    const url = new URL(returnTo, config.appUrl);
    if (url.origin !== new URL(config.appUrl).origin) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

// sameOrigin guards every state-changing request against cross-site
// forgery: the browser must say the request came from this app.
function sameOrigin(config: ResolvedConfig, request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (origin) return origin === new URL(config.appUrl).origin;
  return request.headers.get("Sec-Fetch-Site") === "same-origin";
}

function withError(config: ResolvedConfig, returnTo: string, error: string, description?: string, prompt?: string): string {
  const url = new URL(returnTo, config.appUrl);
  url.searchParams.set(ERROR_PARAM, error);
  if (description) url.searchParams.set(ERROR_DESCRIPTION_PARAM, description);
  // So the app can tell a passkey the user didn't add from a sign-in they cancelled.
  if (prompt === "passkey") url.searchParams.set(ERROR_PROMPT_PARAM, prompt);
  return `${url.pathname}${url.search}${url.hash}`;
}

export type AuthallaCore = ReturnType<typeof createCore>;

export function createCore(options: AuthallaOptions = {}) {
  const config = (requestUrl?: string) => resolveConfig(options, requestUrl);

  async function signIn(cfg: ResolvedConfig, request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams;
    const params = readSignInParams(query);
    const pending: PendingSignIn = {
      state: randomString(),
      verifier: randomString(48),
      nonce: randomString(),
      returnTo: safeReturnTo(cfg, query.get("returnTo")),
      prompt: params.prompt,
    };
    const sealed = await seal(pending, cfg.secret, PENDING_PURPOSE);
    const cookies = [{ name: pendingCookieName(cfg), value: sealed, options: cookieOptions(cfg, PENDING_MAX_AGE) }];
    const location = authorizationUrl(cfg, {
      state: pending.state,
      nonce: pending.nonce,
      codeChallenge: await sha256Base64Url(pending.verifier),
      params,
    });
    return redirect(location, cookies, 302);
  }

  async function callback(cfg: ResolvedConfig, request: Request, jar: CookieJar): Promise<Response> {
    const query = new URL(request.url).searchParams;
    const sealed = jar.get(pendingCookieName(cfg));
    const pending = sealed ? await unseal<PendingSignIn>(sealed, cfg.secret, PENDING_PURPOSE) : undefined;
    const clearPending: CookieToSet = { name: pendingCookieName(cfg), value: "", options: cookieOptions(cfg, 0) };

    // No pending sign-in: it took longer than PENDING_MAX_AGE, or the link
    // from Authalla was opened in another browser.
    if (!pending) {
      return redirect(withError(cfg, "/", "sign_in_expired", "The sign-in took too long or was started in another browser"), [clearPending]);
    }
    // The state must be the one this browser sent, or someone is trying to
    // sign this browser in to their own account (login CSRF).
    if (query.get("state") !== pending.state) {
      return redirect(withError(cfg, pending.returnTo, "invalid_state", "The sign-in didn't match the one this browser started"), [clearPending]);
    }
    const error = query.get("error");
    if (error) {
      return redirect(withError(cfg, pending.returnTo, error, query.get("error_description") ?? undefined, pending.prompt), [clearPending]);
    }
    const code = query.get("code");
    if (!code) return redirect(withError(cfg, pending.returnTo, "invalid_request", "Authalla sent no code"), [clearPending]);

    try {
      const tokens = await exchangeCode(cfg, code, pending.verifier);
      const stored = storedFromTokens(cfg, tokens, pending.nonce);
      const cookies = await writeStoredSession(cfg, jar, stored);
      return redirect(pending.returnTo, [clearPending, ...cookies]);
    } catch (err) {
      if (err instanceof OAuthError) {
        return redirect(withError(cfg, pending.returnTo, err.error, err.description), [clearPending]);
      }
      console.error("authalla: finishing the sign-in failed:", err);
      return redirect(withError(cfg, pending.returnTo, "temporarily_unavailable", "Authalla couldn't be reached"), [clearPending]);
    }
  }

  // endSession revokes the grant and clears the session, and says where to
  // send the browser: Authalla's logout, which comes back to the app.
  async function endSession(cfg: ResolvedConfig, jar: CookieJar): Promise<{ cookies: CookieToSet[]; location: string }> {
    const stored = await readStoredSession(cfg, jar);
    let reachable = true;
    if (stored && !isEnded(stored)) {
      try {
        // Ending the grant first means the tokens stop working even if the
        // browser never reaches Authalla's logout below.
        if (stored.refreshToken) await revoke(cfg, stored.refreshToken, "refresh_token");
        else await revoke(cfg, stored.accessToken, "access_token");
      } catch (err) {
        // An answer, even a refusal, means Authalla is up.
        reachable = err instanceof OAuthError;
        console.error("authalla: revoking the grant at sign-out failed; signing out here anyway:", err);
      }
    }
    const cookies = clearStoredSession(cfg, jar);
    // Without Authalla its logout page would be the browser's error page, so
    // the user stays here, signed out of the app.
    return { cookies, location: reachable ? logoutUrl(cfg) : cfg.postLogoutRedirectUri };
  }

  async function signOut(cfg: ResolvedConfig, request: Request, jar: CookieJar): Promise<Response> {
    if (!sameOrigin(cfg, request)) return json({ error: "forbidden" }, 403);
    const { cookies, location } = await endSession(cfg, jar);
    return redirect(location, cookies);
  }

  async function session(cfg: ResolvedConfig, jar: CookieJar): Promise<Response> {
    const { stored, cookies } = await freshen(cfg, jar);
    return json(toClientSession(stored), 200, cookies);
  }

  async function refresh(cfg: ResolvedConfig, request: Request, jar: CookieJar): Promise<Response> {
    if (!sameOrigin(cfg, request)) return json({ error: "forbidden" }, 403);
    const { stored, cookies } = await freshen(cfg, jar, { force: true });
    return json(toClientSession(stored), 200, cookies);
  }

  async function userApi(cfg: ResolvedConfig, request: Request, jar: CookieJar, path: string): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD" && !sameOrigin(cfg, request)) {
      return json({ error: "forbidden", message: "Cross-site request refused" }, 403);
    }
    const fresh = await freshen(cfg, jar);
    const { stored } = fresh;
    let { cookies } = fresh;
    if (!stored || isEnded(stored)) {
      return json({ error: "unauthorized", message: "Not signed in" }, 401, cookies);
    }
    const url = new URL(request.url);
    const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.method !== "DELETE";
    let upstream: Response;
    try {
      upstream = await fetch(`${cfg.issuer}/me/v1${path}${url.search}`, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${stored.accessToken}`,
          Accept: "application/json",
          ...(hasBody ? { "Content-Type": request.headers.get("Content-Type") ?? "application/json" } : {}),
        },
        body: hasBody ? await request.text() : undefined,
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      console.error("authalla: the User API couldn't be reached:", err);
      return json({ error: "unreachable", message: "Authalla couldn't be reached" }, 502, cookies);
    }
    // A profile change shows in the ID token only once it's reissued, so
    // the session is refreshed straight away and auth() sees the new name.
    if (upstream.ok && path === "" && request.method === "PATCH") {
      const refreshed = await freshen(cfg, applyToJar(jar, cookies), { force: true });
      cookies = [...cookies, ...refreshed.cookies];
    }
    const headers: Record<string, string> = {};
    const contentType = upstream.headers.get("Content-Type");
    if (contentType) headers["Content-Type"] = contentType;
    return respond(upstream.status === 204 ? null : await upstream.arrayBuffer(), { status: upstream.status, headers }, cookies);
  }

  /** Handles every request under basePath. */
  async function handle(request: Request): Promise<Response> {
    let cfg: ResolvedConfig;
    try {
      cfg = config(request.url);
    } catch (err) {
      console.error(`authalla: ${err instanceof Error ? err.message : String(err)}`);
      return json({ error: "misconfigured", message: "Authalla sign-in isn't configured on this server" }, 500);
    }
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith(`${cfg.basePath}/`)) return json({ error: "not_found" }, 404);
    const route = pathname.slice(cfg.basePath.length);
    const jar = parseCookieHeader(request.headers.get("Cookie"));
    const method = request.method;

    if (route === "/signin" && method === "GET") return signIn(cfg, request);
    if (route === "/callback" && method === "GET") return callback(cfg, request, jar);
    if (route === "/signout" && method === "POST") return signOut(cfg, request, jar);
    if (route === "/session" && method === "GET") return session(cfg, jar);
    if (route === "/refresh" && method === "POST") return refresh(cfg, request, jar);
    if (route === "/me" || route.startsWith("/me/")) return userApi(cfg, request, jar, route.slice(3));
    return json({ error: "not_found" }, 404);
  }

  return {
    handle,
    config,
    /** The session from a request's cookies, without refreshing it. */
    async readSession(cookieHeader: string | null | undefined, requestUrl?: string) {
      return readStoredSession(config(requestUrl), parseCookieHeader(cookieHeader));
    },
    /**
     * Signs out from the server: the cookies to set and where to send the
     * browser. The caller must have checked the request is this app's own
     * (a Server Action is).
     */
    async signOut(cookieHeader: string | null | undefined, requestUrl?: string) {
      return endSession(config(requestUrl), parseCookieHeader(cookieHeader));
    },
    /** Refreshes the session if its access token is about to expire. */
    async freshen(cookieHeader: string | null | undefined, opts?: { force?: boolean }, requestUrl?: string) {
      const jar = parseCookieHeader(cookieHeader);
      const result = await freshen(config(requestUrl), jar, opts);
      return { ...result, jar: applyToJar(jar, result.cookies) };
    },
  };
}
