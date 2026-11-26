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
import { cookieName, jarToHeader, parseCookieHeader, serializeCookie, type CookieJar, type CookieToSet } from "./cookies.js";
import { authorizationUrl, exchangeCode, OAuthError, type SignInParams } from "./oauth.js";
import { requestSession, type RequestCookies } from "./request-session.js";
import { readSignInParams } from "./sign-in-path.js";
import { randomString, seal, sha256Base64Url, unseal } from "./seal.js";
import { cookieOptions, storedFromTokens, writeStoredSession } from "./session.js";

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

// The User API's paths are plain segments (/passkeys/pk_123): nothing
// encoded, so no %2F or %5C can reach another path at Authalla.
const USER_API_PATH = /^(\/[A-Za-z0-9_-][A-Za-z0-9._~-]*)*$/;
const MAX_USER_API_BODY = 64 * 1024;

// The User API answers JSON. Served from the app's origin, it must never be
// read as a page, whatever Content-Type comes back.
const USER_API_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
};

class BodyTooLarge extends Error {}

// readLimited reads a request body, refusing more than max bytes, also when
// no Content-Length says so up front.
async function readLimited(request: Request, max: number): Promise<string> {
  if (Number(request.headers.get("Content-Length") ?? 0) > max) throw new BodyTooLarge();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// A path a browser reads as another site: //evil.example or /\evil.example.
function isSchemeRelative(path: string): boolean {
  return path.startsWith("//") || path.startsWith("/\\");
}

// safeReturnTo keeps a sign-in's destination on this app: only a path, so a
// crafted link can't use the sign-in to send the user to another site. The
// check runs on the path as normalized too, because /.//evil.example
// normalizes to //evil.example.
export function safeReturnTo(config: ResolvedConfig, returnTo: string | null | undefined): string {
  if (!returnTo || !returnTo.startsWith("/") || isSchemeRelative(returnTo)) return "/";
  try {
    const url = new URL(returnTo, config.appUrl);
    if (url.origin !== new URL(config.appUrl).origin) return "/";
    const path = `${url.pathname}${url.search}${url.hash}`;
    return isSchemeRelative(path) ? "/" : path;
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

  // The session for a request the handler answers: cookies it stores go
  // on the response.
  function sessionFor(cfg: ResolvedConfig, jar: CookieJar) {
    const out: CookieToSet[] = [];
    return { session: requestSession(cfg, { jar, set: (cookies) => out.push(...cookies) }), out };
  }

  async function signOut(cfg: ResolvedConfig, request: Request, jar: CookieJar): Promise<Response> {
    if (!sameOrigin(cfg, request)) return json({ error: "forbidden" }, 403);
    const { session, out } = sessionFor(cfg, jar);
    const location = await session.signOut();
    return redirect(location, out);
  }

  async function session(cfg: ResolvedConfig, jar: CookieJar): Promise<Response> {
    const { session, out } = sessionFor(cfg, jar);
    await session.current();
    return json(await session.client(), 200, out);
  }

  async function refresh(cfg: ResolvedConfig, request: Request, jar: CookieJar): Promise<Response> {
    if (!sameOrigin(cfg, request)) return json({ error: "forbidden" }, 403);
    const { session, out } = sessionFor(cfg, jar);
    await session.current({ force: true });
    return json(await session.client(), 200, out);
  }

  async function userApi(cfg: ResolvedConfig, request: Request, jar: CookieJar, path: string): Promise<Response> {
    if (!USER_API_PATH.test(path)) return json({ error: "not_found" }, 404);
    if (request.method !== "GET" && request.method !== "HEAD" && !sameOrigin(cfg, request)) {
      return json({ error: "forbidden", message: "Cross-site request refused" }, 403);
    }
    const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.method !== "DELETE";
    let body: string | undefined;
    try {
      body = hasBody ? await readLimited(request, MAX_USER_API_BODY) : undefined;
    } catch (err) {
      if (err instanceof BodyTooLarge) return json({ error: "too_large", message: "The request body is too large" }, 413);
      throw err;
    }
    const { session, out } = sessionFor(cfg, jar);
    let upstream: Response;
    try {
      upstream = await session.callUserApi({
        method: request.method,
        path,
        search: new URL(request.url).search,
        body,
        contentType: request.headers.get("Content-Type") ?? undefined,
      });
    } catch (err) {
      console.error("authalla: the User API couldn't be reached:", err);
      return json({ error: "unreachable", message: "Authalla couldn't be reached" }, 502, out);
    }
    const headers: Record<string, string> = { ...USER_API_HEADERS };
    const contentType = upstream.headers.get("Content-Type");
    if (contentType) headers["Content-Type"] = contentType;
    return respond(upstream.status === 204 ? null : await upstream.arrayBuffer(), { status: upstream.status, headers }, out);
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
    /**
     * The session for a request whose cookies the framework hands over:
     * read, refreshed where cookies can be stored, signed out, and the User
     * API. requestUrl is the fallback for appUrl outside production.
     */
    session(cookies: RequestCookies, requestUrl?: string) {
      return requestSession(config(requestUrl), cookies);
    },
    /**
     * For a framework's proxy (middleware): refreshes the session before a
     * page renders. Returns the cookies to set on the response and the
     * Cookie header the page should see; no cookies when nothing changed.
     */
    async refreshRequest(request: Request): Promise<{ cookies: CookieToSet[]; cookieHeader: string }> {
      const out: CookieToSet[] = [];
      const session = requestSession(config(request.url), {
        jar: parseCookieHeader(request.headers.get("Cookie")),
        set: (cookies) => out.push(...cookies),
      });
      await session.current();
      return { cookies: out, cookieHeader: jarToHeader(session.jar()) };
    },
  };
}
