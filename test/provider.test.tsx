// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientSession } from "../src/core/session.js";
import { AuthallaProvider, useAuth } from "../src/react/provider.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const signedIn: ClientSession = {
  status: "signed-in",
  user: { id: "u1", name: "Jane", email: "jane@example.com", emailVerified: true, claims: {} },
  expiresAt: Date.now() + 600_000,
  scopes: ["openid"],
};

function Status() {
  const { status, user } = useAuth();
  return <span>{status}{user ? `:${user.name}` : ""}</span>;
}

let container: HTMLElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "signed-out", ended: false }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("AuthallaProvider", () => {
  it("takes the session as it is", async () => {
    await act(async () => root.render(<AuthallaProvider session={signedIn}><Status /></AuthallaProvider>));
    expect(container.textContent).toBe("signed-in:Jane");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // With Cache Components a layout that awaits cookies() can't be
  // prerendered, so the layout hands over the promise instead.
  it("takes the session as a promise, loading until it resolves", async () => {
    let resolve!: (session: ClientSession) => void;
    const promise = new Promise<ClientSession>((r) => (resolve = r));
    await act(async () => root.render(<AuthallaProvider session={promise}><Status /></AuthallaProvider>));
    expect(container.textContent).toBe("loading");

    await act(async () => resolve(signedIn));
    expect(container.textContent).toBe("signed-in:Jane");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches the session itself when the promise fails", async () => {
    const promise = Promise.reject(new Error("render aborted"));
    await act(async () => root.render(<AuthallaProvider session={promise}><Status /></AuthallaProvider>));
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/session", expect.objectContaining({ method: "GET" }));
    expect(container.textContent).toBe("signed-out");
  });

  it("fetches the session without one", async () => {
    await act(async () => root.render(<AuthallaProvider><Status /></AuthallaProvider>));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("signed-out");
  });
});
