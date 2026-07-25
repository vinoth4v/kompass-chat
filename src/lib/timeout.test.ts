import { describe, it, expect, vi, afterEach } from "vitest";
import {
  KompassTimeoutError,
  REQUEST_TIMEOUT_MS,
  sendMessage,
} from "./kompassClient";
import type { KompassSettings } from "./types";

const settings: KompassSettings = {
  workerUrl: "https://worker.example",
  bearer: "test",
  theme: "light",
  defaultLane: "kompass",
};
const req = { model: "kompass", max_tokens: 10, messages: [] };

afterEach(() => vi.unstubAllGlobals());

/** A fetch that never settles until its signal aborts — a hung model. */
function hangingFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(
            new DOMException("The operation was aborted.", "AbortError"),
          ),
        );
      }) as Promise<Response>,
  );
}

describe("sendMessage timeouts", () => {
  // Deliberately real time rather than fake timers: AbortSignal.timeout is
  // implemented by the platform, and a faked clock would test the mock instead
  // of the mechanism this exists to guarantee. One slow test, once.
  it("gives up on a model that never responds, and says how long it waited", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    // The failure this fixes: with no timeout, this promise never settles and
    // the council seat sits on "thinking" until the user reloads. A budget of 0
    // also exercises the floor — it waits the minimum, not zero.
    const started = Date.now();
    await expect(
      sendMessage(settings, req, undefined, undefined, 0),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof KompassTimeoutError && /within 5s/.test(e.message),
    );
    expect(Date.now() - started).toBeGreaterThan(4_000);
  }, 15_000);

  it("keeps a user cancellation distinguishable from a timeout", async () => {
    // This distinction is load-bearing: the council retries a timeout on
    // another model, but must never "retry" the user pressing stop.
    vi.stubGlobal("fetch", hangingFetch());
    const user = new AbortController();
    const p = sendMessage(settings, req, user.signal, undefined, 60_000);
    user.abort();
    await expect(p).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DOMException &&
        e.name === "AbortError" &&
        !(e instanceof KompassTimeoutError),
    );
  });

  it("enforces a floor, so an exhausted budget cannot make every call fail instantly", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ content: [], usage: { input_tokens: 1, output_tokens: 1 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    // A negative budget must still issue the request rather than abort at once.
    const r = await sendMessage(settings, req, undefined, undefined, -1000);
    expect(r.response).toBeDefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("passes a normal response straight through", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              content: [{ type: "text", text: "hi" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-kompass-served-by": "provider/model",
              },
            },
          ),
      ),
    );
    const r = await sendMessage(settings, req);
    expect(r.servedBy).toBe("provider/model");
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(30_000);
  });
});
