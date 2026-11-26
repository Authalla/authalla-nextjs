// @authalla/nextjs: Authalla sign-in for a Next.js app. The only layer that
// imports Next.js; everything it does is core plus Next's cookies(),
// headers(), redirect() and proxy.
//
//   // lib/authalla.ts
//   export const authalla = createAuthalla();
//   // app/api/auth/[...authalla]/route.ts
//   export const { GET, POST, PATCH, DELETE } = authalla.handlers;
//   // proxy.ts
//   export const proxy = authalla.proxy;

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import { basePathOf, type AuthallaOptions } from "../core/config.js";
import type { CookieToSet } from "../core/cookies.js";
import { createCore } from "../core/handler.js";
import { signInPath, type SignInOptions } from "../core/sign-in-path.js";
import type { ClientSession, Session } from "../core/session.js";
import { createUserApi, type UserApi } from "../core/user-api.js";

export type { AuthallaOptions } from "../core/config.js";
export type { SignInParams } from "../core/oauth.js";
export type { SignInOptions } from "../core/sign-in-path.js";
export type { Session, SessionUser, ClientSession } from "../core/session.js";
export { UserApiError, type UserApi, type Me, type UserSession, type ConnectedApp, type ConnectedApps, type Passkey } from "../core/user-api.js";
export { ConfigError } from "../core/config.js";

type CookieStore = Awaited<ReturnType<typeof cookies>>;

// The proxy tells the page its own path, which Server Components can't read,
// so requireSession() can come back to it. The proxy always sets it, so a
// browser can't choose it; the route handler checks returnTo regardless.
const PATH_HEADER = "x-authalla-path";

function pagePath(url: URL): string {
  const search = new URLSearchParams(url.search);
  search.delete("_rsc"); // Next.js's cache key for client navigations
  const query = search.toString();
  return `${url.pathname}${query ? `?${query}` : ""}`;
}

// The request's own URL, only for the development fallback of appUrl.
async function currentUrl(): Promise<string | undefined> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return undefined;
  return `${h.get("x-forwarded-proto") ?? "http"}://${host}/`;
}

// Next lets Server Actions and Route Handlers set cookies, and throws in a
// Server Component. Deleting a cookie that isn't there asks without effect.
function canSetCookies(store: CookieStore): boolean {
  try {
    store.delete("authalla-probe");
    return true;
  } catch {
    return false;
  }
}

function setAll(store: CookieStore, toSet: CookieToSet[]): void {
  for (const { name, value, options } of toSet) store.set(name, value, options);
}

export function createAuthalla(options: AuthallaOptions = {}) {
  const core = createCore(options);
  const handle = (request: Request) => core.handle(request);

  // The session for this request, through Next's cookies(): core refreshes
  // it where cookies can be set (Server Actions, Route Handlers) and only
  // reads it in Server Components.
  async function session() {
    const store = await cookies();
    return core.session(
      {
        jar: new Map(store.getAll().map(({ name, value }) => [name, value])),
        set: canSetCookies(store) ? (toSet) => setAll(store, toSet) : undefined,
      },
      await currentUrl(),
    );
  }

  /**
   * The signed-in session, or null. Works in Server Components, Server
   * Actions and Route Handlers. In Server Actions and Route Handlers it
   * refreshes an access token that is about to expire; in Server Components
   * the proxy has done that.
   */
  async function auth(): Promise<Session | null> {
    return (await session()).current();
  }

  /**
   * The session for <AuthallaProvider session={…}>: the user and no tokens,
   * or signed out (and whether it ended rather than being signed out).
   */
  async function clientSession(): Promise<ClientSession> {
    return (await session()).client();
  }

  /**
   * The link that starts a sign-in, for an <a href> in a Server Component
   * or redirect() in a Server Action. It reads no request data, so a page
   * using it can still be prerendered.
   */
  function signInUrl(params: SignInOptions = {}): string {
    return signInPath(basePathOf(options), params);
  }

  /**
   * The session, or a redirect to sign-in that comes back to returnTo:
   * by default the current page, which the proxy passes on, or / without it.
   */
  async function requireSession(returnTo?: string): Promise<Session> {
    const current = await auth();
    if (current) return current;
    redirect(signInUrl({ returnTo: returnTo ?? (await headers()).get(PATH_HEADER) ?? "/" }));
  }

  /**
   * Signs out from a Server Action or Route Handler: ends the grant, clears
   * the session, then sends the browser to Authalla's logout and back.
   * Throws in a Server Component, which can't clear the cookie.
   */
  async function signOut(): Promise<never> {
    const s = await session();
    if (!s.canStore) {
      throw new Error("authalla.signOut() must run in a Server Action or Route Handler, where cookies can be changed.");
    }
    redirect(await s.signOut());
  }

  /**
   * An access token with at least a minute left, refreshed if needed, for
   * calling Authalla's APIs or your own. null when nobody is signed in. In
   * a Server Component it's the stored token, and force throws.
   */
  async function getAccessToken(opts?: { force?: boolean }): Promise<string | null> {
    const current = await (await session()).current(opts);
    if (!current) return null;
    if (current.expiresAt < Date.now()) {
      console.warn("authalla: the access token has expired and couldn't be refreshed. Server Components rely on authalla.proxy in proxy.ts to refresh it.");
    }
    return current.accessToken;
  }

  /**
   * The User API for the signed-in user, from the server: Server Actions,
   * Route Handlers and Server Components.
   */
  const userApi: UserApi = createUserApi(async (method, path, body) =>
    (await session()).callUserApi({ method, path, body: body === undefined ? undefined : JSON.stringify(body) }),
  );

  /**
   * Next.js proxy (proxy.ts) that refreshes the session before a page
   * renders, so Server Components read fresh tokens, and passes the page's
   * path on for requireSession(). Leave the route handler's path out of its
   * matcher; it refreshes for itself.
   */
  async function proxy(request: NextRequest): Promise<NextResponse> {
    const forwarded = new Headers(request.headers);
    forwarded.set(PATH_HEADER, pagePath(new URL(request.url)));
    let result: Awaited<ReturnType<typeof core.refreshRequest>>;
    try {
      result = await core.refreshRequest(request);
    } catch (err) {
      console.error("authalla: the proxy couldn't check the session:", err);
      return NextResponse.next({ request: { headers: forwarded } });
    }
    if (result.cookies.length === 0) return NextResponse.next({ request: { headers: forwarded } });
    // The page renders from the request's cookies, so it gets the new ones
    // too, and the browser gets them on the response.
    forwarded.set("cookie", result.cookieHeader);
    const response = NextResponse.next({ request: { headers: forwarded } });
    for (const { name, value, options } of result.cookies) response.cookies.set(name, value, options);
    return response;
  }

  return {
    /** Mount at app/api/auth/[...authalla]/route.ts. */
    handlers: { GET: handle, POST: handle, PATCH: handle, PUT: handle, DELETE: handle },
    auth,
    clientSession,
    requireSession,
    signInUrl,
    signOut,
    getAccessToken,
    userApi,
    proxy,
  };
}

export type Authalla = ReturnType<typeof createAuthalla>;
