// The session for one request: refreshed only where the new tokens can be
// stored, read as it is elsewhere. Through core alone, with no framework.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CookieToSet } from "../src/core/cookies.js";
import { createCore } from "../src/core/handler.js";
import { APP, Browser, CLIENT_ID, FakeAuthalla, ISSUER } from "./fake-authalla.js";

const SECRET = "test-secret-test-secret-test-secret-0123";
const core = createCore({ issuer: ISSUER, clientId: CLIENT_ID, secret: SECRET, appUrl: APP });

let authalla: FakeAuthalla;
let browser: Browser;

beforeEach(async () => {
  authalla = new FakeAuthalla();
  authalla.install();
  browser = new Browser(core.handle);
  const start = await browser.request("/api/auth/signin?returnTo=/");
  const { code, state } = authalla.approve(start.headers.get("Location")!);
  await browser.request(`/api/auth/callback?code=${code}&state=${state}`);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function later() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 2 * 3600 * 1000);
}

describe("where cookies can't be stored", () => {
  const readOnly = () => core.session({ jar: new Map(browser.cookies) });

  it("reads an expired session as it is, without rotating the refresh token", async () => {
    later();
    expect(await readOnly().current()).toMatchObject({ user: { id: "usr_1" } });
    expect(authalla.tokenCalls("refresh_token")).toHaveLength(0);
  });

  it("refuses to force a refresh, or to sign out", async () => {
    await expect(readOnly().current({ force: true })).rejects.toThrow(/Server Action or Route Handler/);
    await expect(readOnly().signOut()).rejects.toThrow(/Server Action or Route Handler/);
    expect(authalla.tokenCalls("refresh_token")).toHaveLength(0);
  });
});

describe("where cookies can be stored", () => {
  function writable() {
    const stored: CookieToSet[] = [];
    return { session: core.session({ jar: new Map(browser.cookies), set: (c) => stored.push(...c) }), stored };
  }

  it("refreshes an expiring access token and stores the new tokens", async () => {
    later();
    const { session, stored } = writable();
    expect(await session.current()).not.toBeNull();
    expect(authalla.tokenCalls("refresh_token")).toHaveLength(1);
    expect(stored.map((c) => c.name)).toContain("__Host-authalla-session");
  });

  it("reports a revoked grant as signed out, and stores that the session ended", async () => {
    authalla.revokeAll();
    later();
    const { session } = writable();
    expect(await session.current()).toBeNull();
    expect(await session.client()).toEqual({ status: "signed-out", ended: true });
  });

  it("refreshes after a name change, so the session carries the new name", async () => {
    const { session } = writable();
    const response = await session.callUserApi({ method: "PATCH", path: "", body: JSON.stringify({ name: "Jane Smith" }) });
    expect(response.status).toBe(200);
    expect((await session.current())?.user.name).toBe("Jane Smith");
  });

  it("answers 401 from the User API when nobody is signed in", async () => {
    const response = await core.session({ jar: new Map(), set: () => {} }).callUserApi({ method: "GET", path: "" });
    expect(response.status).toBe(401);
  });
});
