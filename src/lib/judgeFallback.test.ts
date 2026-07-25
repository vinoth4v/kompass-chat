import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMessage = vi.fn();
vi.mock("./kompassClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./kompassClient")>()),
  sendMessage: (...a: unknown[]) => sendMessage(...a),
}));

const { retryJudge } = await import("./council");
import type { AgentState, CouncilRun } from "./council";
import type { KompassSettings } from "./types";

const settings: KompassSettings = {
  workerUrl: "https://w.example",
  bearer: "t",
  theme: "light",
  defaultLane: "kompass",
};

function agent(label: string, reads: number, answer: string): AgentState {
  return {
    spec: { id: label, label, model: "provider/model" },
    phase: "done",
    searches: 2,
    reads,
    answer,
    sources: Array.from({ length: reads }, (_, i) => ({
      title: `${label} source ${i}`,
      url: `https://example.com/${label}/${i}`,
    })),
  };
}

const run = (): CouncilRun => ({
  agents: [agent("A", 1, "A says yes."), agent("B", 4, "B says no, with detail.")],
  judgePhase: "failed",
  judgeError: "gateway lanes exhausted",
});

const reply = (text: string) => ({
  response: {
    content: [{ type: "text", text }],
    usage: { input_tokens: 1, output_tokens: 1 },
  },
  servedBy: "provider/judge",
  lane: null,
  exhausted: false,
});

/**
 * The gateway's real "no model could serve this" reply: HTTP 200, a synthetic
 * body, and the x-kompass-exhausted header. This is the exact failure from the
 * screenshot that prompted the retry ladder — five seats drain the free tier's
 * per-minute allowance and only then does the judge ask for a model — so the
 * test reproduces it rather than substituting a generic Error.
 */
const exhausted = () => ({
  response: {
    content: [{ type: "text", text: "No model could serve this request." }],
    usage: { input_tokens: 0, output_tokens: 0 },
  },
  servedBy: null,
  lane: null,
  exhausted: true,
});

beforeEach(() => sendMessage.mockReset());

describe("judge fallback when every model refuses", () => {
  it("tries several distinct models before giving up", async () => {
    sendMessage.mockImplementation(async () => exhausted());
    await retryJudge(settings, "q", run(), "provider/judge", () => {}, undefined, [
      0, 0, 0, 0,
    ]);
    // The pinned judge, then the lanes — not one attempt and a shrug.
    expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("falls back to the best-evidenced analyst rather than showing nothing", async () => {
    sendMessage.mockImplementation(async () => exhausted());
    const out = await retryJudge(
      settings,
      "q",
      run(),
      "provider/judge",
      () => {},
      undefined,
      [0, 0, 0, 0],
    );
    expect(out.judgePhase).toBe("failed");
    // B read four pages to A's one, so B is the provisional answer.
    expect(out.verdict?.answer).toBe("B says no, with detail.");
    expect(out.verdict?.degraded).toBe(true);
    // And it must SAY it is not a synthesis — claiming otherwise would be the
    // exact dishonesty the council exists to prevent.
    expect(out.verdict?.notices?.[0]).toMatch(/NOT been weighed/);
    // Every seat's sources survive, not just the chosen one's.
    expect(out.verdict?.sources).toHaveLength(5);
  });

});
