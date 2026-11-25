// @vitest-environment happy-dom
import { act, Suspense } from "react";
import { renderToReadableStream } from "react-dom/server";
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

function Status({ suspense = false }: { suspense?: boolean }) {
  const { status, user } = useAuth({ suspense });
  return <span>{status}{user ? `:${user.name}` : ""}</span>;
}

function deferred() {
  let resolve!: (session: ClientSession) => void;
  const promise = new Promise<ClientSession>((r) => (resolve = r));
  return { promise, resolve };
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

  describe("useAuth({ suspense: true })", () => {
    it("suspends until the session arrives instead of showing loading", async () => {
      const { promise, resolve } = deferred();
      const tree = (
        <AuthallaProvider session={promise}>
          <Suspense fallback={<span>fallback</span>}>
            <Status suspense />
          </Suspense>
        </AuthallaProvider>
      );
      await act(async () => root.render(tree));
      expect(container.textContent).toBe("fallback");

      await act(async () => resolve(signedIn));
      expect(container.textContent).toBe("signed-in:Jane");
    });

    it("renders the user on the server, the first time", async () => {
      const { promise, resolve } = deferred();
      const stream = await renderToReadableStream(
        <AuthallaProvider session={promise}>
          <Suspense fallback={<span>fallback</span>}>
            <Status suspense />
          </Suspense>
          <Status />
        </AuthallaProvider>,
      );
      resolve(signedIn);
      await stream.allReady;
      const html = await new Response(stream).text();
      // The suspending one waited; the plain one rendered loading at once.
      expect(html).toContain("signed-in<!-- -->:Jane");
      expect(html).toContain("<span>loading</span>");
    });

    // What a Server Component's promise turns into in the browser and during
    // SSR: React's thenable, whose then() registers callbacks and returns
    // nothing rather than a chained promise.
    it("takes React's thenable from a Server Component", async () => {
      const callbacks: ((session: ClientSession) => void)[] = [];
      const thenable = {
        status: "pending",
        then(resolve: (session: ClientSession) => void) {
          callbacks.push(resolve);
        },
      } as unknown as Promise<ClientSession>;
      await act(async () =>
        root.render(
          <AuthallaProvider session={thenable}>
            <Suspense fallback={<span>fallback</span>}>
              <Status suspense />
            </Suspense>
            <Status />
          </AuthallaProvider>,
        ),
      );
      expect(container.textContent).toBe("fallbackloading");

      await act(async () => callbacks.forEach((resolve) => resolve(signedIn)));
      expect(container.textContent).toBe("signed-in:Janesigned-in:Jane");
    });

    it("doesn't suspend when the session is already known", async () => {
      await act(async () => root.render(<AuthallaProvider session={signedIn}><Status suspense /></AuthallaProvider>));
      expect(container.textContent).toBe("signed-in:Jane");
    });

    // Next.js rejects request data when a prerender ends. Rendering signed
    // out then would bake "signed out" into the static page for everyone.
    it("stays suspended when the promise fails, until the session is fetched", async () => {
      const promise = Promise.reject(new Error("prerender aborted"));
      let answer!: (response: Response) => void;
      fetchMock.mockImplementation(() => new Promise<Response>((r) => (answer = r)));
      const tree = (
        <AuthallaProvider session={promise}>
          <Suspense fallback={<span>fallback</span>}>
            <Status suspense />
          </Suspense>
        </AuthallaProvider>
      );
      await act(async () => root.render(tree));
      expect(container.textContent).toBe("fallback");

      await act(async () => answer(new Response(JSON.stringify(signedIn), { status: 200 })));
      expect(container.textContent).toBe("signed-in:Jane");
    });

    it("stays suspended on the server when the promise fails", async () => {
      const controller = new AbortController();
      const stream = await renderToReadableStream(
        <AuthallaProvider session={Promise.reject(new Error("prerender aborted"))}>
          <Suspense fallback={<span>fallback</span>}>
            <Status suspense />
          </Suspense>
        </AuthallaProvider>,
        { signal: controller.signal, onError: () => {} },
      );
      await new Promise((r) => setTimeout(r, 10));
      controller.abort();
      const html = await new Response(stream).text();
      expect(html).toContain("fallback");
      expect(html).not.toContain("loading");
    });
  });
});
