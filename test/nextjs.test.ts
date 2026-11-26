// The Next.js layer: the proxy, signInUrl() and the server signOut(), with
// next/headers and next/navigation standing in for a request.
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCore } from "../src/core/handler.js";
import { readSignInParams, signInPath } from "../src/core/sign-in-path.js";
import { APP, Browser, CLIENT_ID, FakeAuthalla, ISSUER } from "./fake-authalla.js";

// The request a Server Action sees: the browser's cookies, which it may change.
const request = vi.hoisted(() => ({ cookies: new Map<string, string>(), writable: true, headers: {} as Record<string, string> }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...request.cookies].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string, options: { maxAge?: number }) => {
      if (!request.writable) throw new Error("Cookies can only be modified in a Server Action or Route Handler.");
      if (options.maxAge === 0) request.cookies.delete(name);
      else request.cookies.set(name, value);
    },
    delete: (name: string) => {
      if (!request.writable) throw new Error("Cookies can only be modified in a Server Action or Route Handler.");
      request.cookies.delete(name);
    },
  }),
  headers: async () => new Headers({ host: new URL(APP).host, "x-forwarded-proto": "https", ...request.headers }),
}));

vi.mock("next/navigation", () => ({
  redirect: (location: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { location });
  },
}));

const { createAuthalla } = await import("../src/nextjs/index.js");

const SECRET = "test-secret-test-secret-test-secret-0123";
const options = { issuer: ISSUER, clientId: CLIENT_ID, secret: SECRET, appUrl: APP };

let authalla: FakeAuthalla;
let browser: Browser;

// Signs the browser in through the route handler, against the fake Authalla.
async function signIn() {
  const start = await browser.request("/api/auth/signin?returnTo=/");
  const { code, state } = authalla.approve(start.headers.get("Location")!);
  await browser.request(`/api/auth/callback?code=${code}&state=${state}`);
  expect(browser.cookies.has("__Host-authalla-session")).toBe(true);
}

function cookieHeader() {
  return [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function redirectOf(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toMatchObject({ message: "NEXT_REDIRECT" });
  return (err as { location: string }).location;
}

beforeEach(() => {
  authalla = new FakeAuthalla();
  authalla.install();
  browser = new Browser(createCore(options).handle);
  request.cookies.clear();
  request.writable = true;
  request.headers = {};
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("signInUrl", () => {
  it("links to the route handler with the sign-in options, and the handler reads them back", () => {
    const url = createAuthalla(options).signInUrl({ returnTo: "/account?tab=1", loginHint: "jane@example.com", uiLocales: "fi", prompt: "login", maxAge: 300 });
    expect(url.startsWith("/api/auth/signin?")).toBe(true);
    const query = new URL(url, APP).searchParams;
    expect(query.get("returnTo")).toBe("/account?tab=1");
    expect(readSignInParams(query)).toEqual({ loginHint: "jane@example.com", uiLocales: "fi", prompt: "login", maxAge: 300 });
  });

  it("needs no environment, so a prerendered page can use it", () => {
    expect(createAuthalla({ basePath: "/auth/" }).signInUrl()).toBe("/auth/signin");
  });

  it("is what requireSession() redirects to", async () => {
    expect(await redirectOf(createAuthalla(options).requireSession("/account"))).toBe(signInPath("/api/auth", { returnTo: "/account" }));
  });
});

describe("auth", () => {
  // A Route Handler under /api, which the proxy's matcher leaves out.
  async function expireAndRevoke() {
    await signIn();
    for (const [k, v] of browser.cookies) request.cookies.set(k, v);
    authalla.revokeAll();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 3600 * 1000);
  }

  it("sees a revoked grant in a Route Handler or Server Action, and stores that the session ended", async () => {
    await expireAndRevoke();
    expect(await createAuthalla(options).auth()).toBeNull();
    expect(authalla.tokenCalls("refresh_token")).toHaveLength(1);
    browser.cookies.set("__Host-authalla-session", request.cookies.get("__Host-authalla-session")!);
    expect(await browser.session()).toEqual({ status: "signed-out", ended: true });
  });

  it("doesn't refresh in a Server Component, which couldn't store the new tokens", async () => {
    await expireAndRevoke();
    request.writable = false;
    expect(await createAuthalla(options).auth()).not.toBeNull();
    expect(authalla.tokenCalls("refresh_token")).toHaveLength(0);
  });
});

describe("userApi on the server", () => {
  it("calls the User API as the signed-in user", async () => {
    await signIn();
    for (const [k, v] of browser.cookies) request.cookies.set(k, v);
    expect(await createAuthalla(options).userApi.getMe()).toMatchObject({ id: "usr_1", name: "Jane Doe" });
  });

  it("stores the refreshed session after a name change in a Server Action", async () => {
    await signIn();
    for (const [k, v] of browser.cookies) request.cookies.set(k, v);
    const client = createAuthalla(options);
    await client.userApi.updateMe({ name: "Jane Smith" });
    expect((await client.auth())?.user.name).toBe("Jane Smith");
  });

  it("throws UserApiError 401 when nobody is signed in", async () => {
    await expect(createAuthalla(options).userApi.getMe()).rejects.toMatchObject({ name: "AuthallaUserApiError", status: 401 });
  });
});

describe("getAccessToken", () => {
  it("refuses force in a Server Component instead of silently not refreshing", async () => {
    await signIn();
    for (const [k, v] of browser.cookies) request.cookies.set(k, v);
    request.writable = false;
    await expect(createAuthalla(options).getAccessToken({ force: true })).rejects.toThrow(/Server Action or Route Handler/);
  });
});

describe("requireSession", () => {
  it("comes back to the page the proxy saw when given no returnTo", async () => {
    const client = createAuthalla(options);
    const response = await client.proxy(new NextRequest(`${APP}/orders/42?tab=items&_rsc=abc`));
    request.headers = forwardedHeaders(response);
    expect(await redirectOf(client.requireSession())).toBe(signInPath("/api/auth", { returnTo: "/orders/42?tab=items" }));
  });

  it("comes back to / without the proxy", async () => {
    expect(await redirectOf(createAuthalla(options).requireSession())).toBe(signInPath("/api/auth", { returnTo: "/" }));
  });
});

describe("signOut on the server", () => {
  it("ends the grant, clears the session and sends the browser to Authalla's logout", async () => {
    await signIn();
    const refreshToken = authalla.refreshTokens[0];
    for (const [k, v] of browser.cookies) request.cookies.set(k, v);

    const location = await redirectOf(createAuthalla(options).signOut());

    const logout = new URL(location);
    expect(logout.origin + logout.pathname).toBe(`${ISSUER}/oauth2/logout`);
    expect(logout.searchParams.get("post_logout_redirect_uri")).toBe(APP);
    expect(request.cookies.has("__Host-authalla-session")).toBe(false);
    const revoked = authalla.calls.find((c) => c.url.pathname === "/oauth2/revoke");
    expect(new URLSearchParams(revoked?.body).get("token")).toBe(refreshToken);
  });

  it("refuses in a Server Component, where it couldn't clear the cookie", async () => {
    await signIn();
    for (const [k, v] of browser.cookies) request.cookies.set(k, v);
    request.writable = false;
    await expect(createAuthalla(options).signOut()).rejects.toThrow(/Server Action or Route Handler/);
    expect(authalla.calls.some((c) => c.url.pathname === "/oauth2/revoke")).toBe(false);
  });
});

// The request headers Next.js passes on to the page after the proxy.
function forwardedHeaders(response: Response): Record<string, string> {
  const names = (response.headers.get("x-middleware-override-headers") ?? "").split(",").filter(Boolean);
  return Object.fromEntries(names.map((name) => [name, response.headers.get(`x-middleware-request-${name}`) ?? ""]));
}

describe("proxy", () => {
  it("passes the page's path on, replacing one the browser sent", async () => {
    const forged = new NextRequest(`${APP}/account`, { headers: { "x-authalla-path": "/elsewhere" } });
    const headers = forwardedHeaders(await createAuthalla(options).proxy(forged));
    expect(headers["x-authalla-path"]).toBe("/account");
  });

  function page(cookie: string) {
    return new NextRequest(`${APP}/account`, { headers: { cookie } });
  }

  it("leaves a fresh session alone", async () => {
    await signIn();
    const response = await createAuthalla(options).proxy(page(cookieHeader()));
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(authalla.tokenCalls("refresh_token")).toHaveLength(0);
  });

  it("refreshes an expired access token before the page renders, for the page and the browser", async () => {
    await signIn();
    const before = await browser.session();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 3600 * 1000);

    const response = await createAuthalla(options).proxy(page(cookieHeader()));

    expect(authalla.tokenCalls("refresh_token")).toHaveLength(1);
    const setCookie = response.headers.getSetCookie().find((c) => c.startsWith("__Host-authalla-session="));
    expect(setCookie).toBeDefined();
    const newValue = setCookie!.split(";")[0].slice("__Host-authalla-session=".length);
    expect(newValue).not.toBe(browser.cookies.get("__Host-authalla-session"));
    // Next passes the overridden request cookies on to the page.
    expect(response.headers.get("x-middleware-override-headers")).toContain("cookie");
    expect(response.headers.get("x-middleware-request-cookie")).toContain(newValue);

    // The browser, with the new cookie, is still signed in with a later expiry.
    browser.cookies.set("__Host-authalla-session", newValue);
    const after = await browser.session();
    expect(after.status).toBe("signed-in");
    expect(after.expiresAt).toBeGreaterThan(before.expiresAt);
  });

  it("marks the session ended when the grant was revoked", async () => {
    await signIn();
    authalla.revokeAll();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 3600 * 1000);

    const response = await createAuthalla(options).proxy(page(cookieHeader()));
    const setCookie = response.headers.getSetCookie().find((c) => c.startsWith("__Host-authalla-session="))!;
    browser.cookies.set("__Host-authalla-session", setCookie.split(";")[0].slice("__Host-authalla-session=".length));
    expect(await browser.session()).toEqual({ status: "signed-out", ended: true });
  });

  it("lets the page render when Authalla is down", async () => {
    await signIn();
    authalla.down = true;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 3600 * 1000);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await createAuthalla(options).proxy(page(cookieHeader()));
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
