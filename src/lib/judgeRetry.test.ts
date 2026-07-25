import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMessage = vi.fn();
vi.mock("./kompassClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./kompassClient")>()),
  sendMessage: (...a: unknown[]) => sendMessage(...a),
}));

const { retryJudge, JUDGE_RETRY_WAITS_MS } = await import("./council");
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

describe("judge retries", () => {
  it("waits before retrying, rather than asking drained providers instantly", () => {
    // The bug this encodes: the old path retried immediately, so it hit the
    // same exhausted per-minute window a second later and failed identically.
    expect(JUDGE_RETRY_WAITS_MS[0]).toBe(0);
    expect(JUDGE_RETRY_WAITS_MS.slice(1).every((w) => w >= 10_000)).toBe(true);
  });

  it("reports rather than throws when there is nothing to synthesize", async () => {
    const empty: CouncilRun = { agents: [], judgePhase: "failed" };
    const out = await retryJudge(settings, "q", empty, "m", () => {}, undefined, [0]);
    expect(out.judgePhase).toBe("failed");
    expect(out.judgeError).toMatch(/No analyst answers/);
    expect(sendMessage).not.toHaveBeenCalled();
  });
  it("recovers when a later model answers", async () => {
    sendMessage
      .mockImplementationOnce(async () => exhausted())
      .mockResolvedValueOnce(
        reply('{"agreements":["both cite sources"],"disagreements":[]}\nThe verdict.'),
      );
    const out = await retryJudge(
      settings,
      "q",
      run(),
      "provider/judge",
      () => {},
      undefined,
      [0, 0, 0, 0],
    );
    expect(out.judgePhase).toBe("done");
    expect(out.judgeError).toBeUndefined();
    expect(out.verdict?.agreements).toEqual(["both cite sources"]);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

});
