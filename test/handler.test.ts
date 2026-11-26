import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCore } from "../src/core/handler.js";
import { APP, Browser, CLIENT_ID, FakeAuthalla, ISSUER } from "./fake-authalla.js";

const SECRET = "test-secret-test-secret-test-secret-0123";

let authalla: FakeAuthalla;
let browser: Browser;

function core(options = {}) {
  return createCore({ issuer: ISSUER, clientId: CLIENT_ID, secret: SECRET, appUrl: APP, scopes: ["openid", "profile", "email", "offline_access"], ...options });
}

beforeEach(() => {
  authalla = new FakeAuthalla();
  authalla.install();
  browser = new Browser(core().handle);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// signIn walks the whole sign-in: the app's /signin, Authalla's approval and
// the redirect back to /callback. It returns the callback's response.
async function signIn(query = "returnTo=/account", approve = (url: string) => authalla.approve(url)) {
  const start = await browser.request(`/api/auth/signin?${query}`);
  expect(start.status).toBe(302);
  const { code, state } = approve(start.headers.get("Location")!);
  return browser.request(`/api/auth/callback?code=${code}&state=${state}`);
}

describe("sign-in", () => {
  it("sends the browser to Authalla with PKCE, a nonce and the app's redirect URI", async () => {
    const response = await browser.request("/api/auth/signin?login_hint=jane%40example.com&ui_locales=fi&prompt=create&returnTo=/x");
    const url = new URL(response.headers.get("Location")!);
    expect(url.origin + url.pathname).toBe(`${ISSUER}/oauth2/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: `${APP}/api/auth/callback`,
      scope: "openid profile email offline_access",
      code_challenge_method: "S256",
      login_hint: "jane@example.com",
      ui_locales: "fi",
      prompt: "create",
    });
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("nonce")).toBeTruthy();
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
  });

  it("signs the user in and returns to the page they started from", async () => {
    const response = await signIn();
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/account");
    expect(await browser.session()).toMatchObject({
      status: "signed-in",
      user: { id: "usr_1", name: "Jane Doe", email: "jane@example.com", emailVerified: true, picture: "https://images.example.com/jane.png" },
    });
  });

  it("leaves out a picture that isn't a web address, so it can't become a javascript: link", async () => {
    authalla.user.picture = "javascript:alert(1)";
    await signIn();
    expect((await browser.session()).user.picture).toBeUndefined();
  });

  it("keeps the tokens out of the browser: sealed in the cookie, absent from /session", async () => {
    await signIn();
    const cookies = [...browser.cookies.values()].join(" ");
    const session = JSON.stringify(await browser.session());
    for (const secret of [...authalla.refreshTokens, "eyJ"]) {
      expect(cookies).not.toContain(secret);
      expect(session).not.toContain(secret);
    }
    expect([...browser.cookies.keys()]).toEqual(["__Host-authalla-session"]);
  });

  it("refuses a callback whose state isn't the one this browser started (login CSRF)", async () => {
    const response = await signIn(undefined, (url) => ({ ...authalla.approve(url), state: "attackers-state" }));
    expect(response.headers.get("Location")).toBe("/account?authalla_error=invalid_state&authalla_error_description=The+sign-in+didn%27t+match+the+one+this+browser+started");
    expect((await browser.session()).status).toBe("signed-out");
  });

  it("refuses an ID token carrying another sign-in's nonce", async () => {
    authalla.nonceOverride = "replayed";
    const response = await signIn();
    expect(new URL(response.headers.get("Location")!, APP).searchParams.get("authalla_error")).toBe("invalid_id_token");
    expect((await browser.session()).status).toBe("signed-out");
  });

  it("brings a cancelled sign-in back to the page with Authalla's error", async () => {
    const start = await browser.request("/api/auth/signin?returnTo=/pricing");
    const state = new URL(start.headers.get("Location")!).searchParams.get("state");
    const response = await browser.request(`/api/auth/callback?error=access_denied&state=${state}`);
    expect(response.headers.get("Location")).toBe("/pricing?authalla_error=access_denied");
  });

  it("asks Authalla for a passkey, and marks a passkey the user didn't add apart from a cancelled sign-in", async () => {
    const start = await browser.request("/api/auth/signin?prompt=passkey&returnTo=/account");
    const authorize = new URL(start.headers.get("Location")!);
    expect(authorize.searchParams.get("prompt")).toBe("passkey");
    const response = await browser.request(`/api/auth/callback?error=access_denied&state=${authorize.searchParams.get("state")}`);
    expect(response.headers.get("Location")).toBe("/account?authalla_error=access_denied&authalla_error_prompt=passkey");
  });

  it("says the sign-in expired when the callback arrives without a pending sign-in", async () => {
    const response = await browser.request("/api/auth/callback?code=x&state=y");
    expect(new URL(response.headers.get("Location")!, APP).searchParams.get("authalla_error")).toBe("sign_in_expired");
  });

  it.each(["//evil.example/x", "https://evil.example/x", "/\\evil.example", "javascript:alert(1)", "/.//evil.example", "/a/..//evil.example", "/%2e//evil.example", "/./\\evil.example"])(
    "never returns to another site after signing in (returnTo=%s)",
    async (returnTo) => {
      const response = await signIn(`returnTo=${encodeURIComponent(returnTo)}`);
      expect(response.headers.get("Location")).toBe("/");
    },
  );

  it("splits a session too large for one cookie, and reads it back", async () => {
    authalla.extraClaims = { "https://authalla.com/claims/sign_in": { roles: "x".repeat(6000) } };
    await signIn();
    const names = [...browser.cookies.keys()];
    expect(names.length).toBeGreaterThan(1);
    expect(names.every((name) => /^__Host-authalla-session\.\d$/.test(name))).toBe(true);
    for (const value of browser.cookies.values()) expect(value.length).toBeLessThanOrEqual(3800);
    expect(await browser.session()).toMatchObject({ status: "signed-in", user: { id: "usr_1" } });

    // A smaller session afterwards removes the chunks it no longer needs.
    authalla.extraClaims = {};
    await signIn();
    expect([...browser.cookies.keys()]).toEqual(["__Host-authalla-session"]);
  });

  it("treats a tampered session cookie as signed out", async () => {
    await signIn();
    const value = browser.cookies.get("__Host-authalla-session")!;
    browser.cookies.set("__Host-authalla-session", value.slice(0, -4) + (value.endsWith("AAAA") ? "BBBB" : "AAAA"));
    expect(await browser.session()).toEqual({ status: "signed-out", ended: false });
  });

  it("doesn't accept a session sealed with another app's secret", async () => {
    await signIn();
    const other = new Browser(createCore({ issuer: ISSUER, clientId: CLIENT_ID, secret: "another-secret-another-secret-012345", appUrl: APP }).handle);
    other.cookies = new Map(browser.cookies);
    expect((await other.session()).status).toBe("signed-out");
  });
});

describe("refresh", () => {
  it("refreshes an access token about to expire, and keeps the user signed in", async () => {
    authalla.expiresIn = 30;
    await signIn();
    const before = browser.cookies.get("__Host-authalla-session");
    expect((await browser.session()).status).toBe("signed-in");
    expect(authalla.tokenCalls("refresh_token")).toHaveLength(1);
    expect(browser.cookies.get("__Host-authalla-session")).not.toBe(before);
  });

  it("doesn't refresh a token with time left", async () => {
    await signIn();
    await browser.session();
    expect(authalla.tokenCalls("refresh_token")).toHaveLength(0);
  });

  it("shares one refresh between requests sent at once, so the rotated token isn't presented twice", async () => {
    authalla.expiresIn = 30;
    await signIn();
    const results = await Promise.all([browser.session(), browser.session(), browser.session()]);
    expect(results.map((r) => r.status)).toEqual(["signed-in", "signed-in", "signed-in"]);
    expect(authalla.tokenCalls("refresh_token")).toHaveLength(1);
  });

  it("says the session ended when Authalla has revoked the grant", async () => {
    authalla.expiresIn = 30;
    await signIn();
    authalla.revokeAll();
    expect(await browser.session()).toEqual({ status: "signed-out", ended: true });
    // And it stays ended, without asking Authalla again.
    expect(await browser.session()).toEqual({ status: "signed-out", ended: true });
    expect(authalla.tokenCalls("refresh_token")).toHaveLength(1);
  });

  it("keeps the user signed in when Authalla can't be reached", async () => {
    authalla.expiresIn = 30;
    await signIn();
    authalla.down = true;
    expect((await browser.session()).status).toBe("signed-in");
  });

  it("a new sign-in clears an ended session", async () => {
    authalla.expiresIn = 30;
    await signIn();
    authalla.revokeAll();
    await browser.session();
    authalla.expiresIn = 3600;
    await signIn();
    expect((await browser.session()).status).toBe("signed-in");
  });
});

describe("sign-out", () => {
  it("revokes the grant, clears the session and sends the browser to Authalla's logout", async () => {
    await signIn();
    const response = await browser.request("/api/auth/signout", { method: "POST" });
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(
      `${ISSUER}/oauth2/logout?client_id=${CLIENT_ID}&post_logout_redirect_uri=${encodeURIComponent(APP)}`,
    );
    const revoke = authalla.calls.find((c) => c.url.pathname === "/oauth2/revoke")!;
    expect(Object.fromEntries(new URLSearchParams(revoke.body))).toEqual({ token: authalla.refreshTokens[0], token_type_hint: "refresh_token", client_id: CLIENT_ID });
    expect(browser.cookies.size).toBe(0);
    expect(await browser.session()).toEqual({ status: "signed-out", ended: false });
  });

  it("authenticates a confidential app with HTTP Basic instead of sending client_id", async () => {
    browser = new Browser(core({ clientSecret: "s3cret" }).handle);
    await signIn();
    await browser.request("/api/auth/signout", { method: "POST" });
    const revoke = authalla.calls.find((c) => c.url.pathname === "/oauth2/revoke")!;
    expect(revoke.headers.get("Authorization")).toBe(`Basic ${btoa(`${CLIENT_ID}:s3cret`)}`);
    expect(new URLSearchParams(revoke.body).has("client_id")).toBe(false);
  });

  it("refuses a sign-out posted from another site", async () => {
    await signIn();
    const response = await browser.request("/api/auth/signout", { method: "POST", crossSite: true });
    expect(response.status).toBe(403);
    expect(authalla.calls.some((c) => c.url.pathname === "/oauth2/revoke")).toBe(false);
    expect((await browser.session()).status).toBe("signed-in");
  });

  it("stays on the app, signed out, when Authalla can't be reached", async () => {
    await signIn();
    authalla.down = true;
    const response = await browser.request("/api/auth/signout", { method: "POST" });
    expect(response.headers.get("Location")).toBe(APP);
    expect(browser.cookies.size).toBe(0);
  });
});

describe("User API", () => {
  it("calls /me/v1 with the session's access token", async () => {
    await signIn();
    const response = await browser.request("/api/auth/me");
    expect(await response.json()).toMatchObject({ id: "usr_1", name: "Jane Doe" });
    const call = authalla.calls.find((c) => c.url.pathname === "/me/v1")!;
    expect(call.headers.get("Authorization")).toMatch(/^Bearer eyJ/);
  });

  it("refreshes the session after a name change, so the ID token carries the new name", async () => {
    await signIn();
    const response = await browser.request("/api/auth/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Jane Smith" }),
    });
    expect(response.status).toBe(200);
    expect(await browser.session()).toMatchObject({ user: { name: "Jane Smith" } });
  });

  it("refuses a change posted from another site", async () => {
    await signIn();
    const response = await browser.request("/api/auth/me", { method: "PATCH", body: "{}", crossSite: true });
    expect(response.status).toBe(403);
    expect(authalla.calls.some((c) => c.url.pathname === "/me/v1")).toBe(false);
  });

  it("answers 401 when nobody is signed in", async () => {
    expect((await browser.request("/api/auth/me")).status).toBe(401);
  });
});

it("answers 500 without leaking the reason when the app isn't configured", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  browser = new Browser(createCore({ issuer: ISSUER, clientId: CLIENT_ID, secret: "short", appUrl: APP }).handle);
  const response = await browser.request("/api/auth/session");
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "misconfigured", message: "Authalla sign-in isn't configured on this server" });
  expect(error.mock.calls[0][0]).toContain("AUTHALLA_SECRET");
});
