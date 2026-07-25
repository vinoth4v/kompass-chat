// Is the model that answered actually suited to the work it was given?
//
// The Council planner already refuses to seat vision-fallback models, because
// one was seated and "did one search, ignored the instruction to fetch, and
// answered from memory" (councilPlanner.ts). But that filter only governs seats
// the planner picks. Chat and Research take whatever the gateway's lane routing
// hands them, so the same model could still be handed a research turn — the
// planner can only filter what it seats.
//
// The lane chains live in the gateway's lanes.yaml, which this app cannot edit.
// What it CAN do is notice, and re-run once on a model that researches.
import { fetchStatus } from "./kompassClient";
import { planCouncil, type StatusSnapshot } from "./councilPlanner";
import type { KompassSettings } from "./types";

/** /status is a live snapshot, but not one worth re-fetching per turn. */
const TTL_MS = 60_000;
let cache: { url: string; at: number; status: StatusSnapshot | null } | null =
  null;

export function resetStatusCache(): void {
  cache = null;
}

/**
 * The gateway's status, cached briefly. Returns null when it cannot be read —
 * a routing optimisation must never be the reason a turn fails, so every caller
 * treats null as "no opinion" and proceeds.
 */
export async function loadStatus(
  settings: KompassSettings,
): Promise<StatusSnapshot | null> {
  const now = Date.now();
  if (cache && cache.url === settings.workerUrl && now - cache.at < TTL_MS)
    return cache.status;
  let status: StatusSnapshot | null = null;
  try {
    status = (await fetchStatus(settings)) as StatusSnapshot;
  } catch {
    status = null;
  }
  cache = { url: settings.workerUrl, at: now, status };
  return status;
}

function providerOf(entry: string): string {
  return entry.split("/")[0] ?? entry;
}

/**
 * True when this entry is only in the roster to read images.
 *
 * Provider-wide multimodal ('*') is deliberately NOT treated as a vision
 * fallback: those are general models that happen to accept images, which is a
 * different thing from a vision model standing in as a fallback.
 */
export function isVisionFallback(
  status: StatusSnapshot,
  entry: string,
): boolean {
  const provider = providerOf(entry);
  const list = status.providers?.[provider]?.multimodal_models ?? [];
  return list.includes(entry.slice(provider.length + 1));
}

/**
 * A research-capable model to re-run on, or undefined if there is no better
 * option than what already answered.
 *
 * Reuses the Council planner rather than re-deriving "which models can
 * research": it already excludes vision fallbacks, small-model lanes, disabled
 * and cooling entries, and providers out of quota, and ranks what is left by
 * measured reliability. One definition of a research-capable model, used by
 * both the council and the chat loop.
 */
export function pickResearchModel(
  status: StatusSnapshot,
  avoid: string[] = [],
): string | undefined {
  const plan = planCouncil(status, 1);
  const ranked = [...plan.seats.map((s) => s.model), ...plan.alternates];
  return ranked.find(
    // A "kompass-*" entry means the planner found nothing healthy to pin, so
    // it fell back to lane routing — which is what we are already doing.
    (m) => !m.startsWith("kompass") && !avoid.includes(m),
  );
}

/**
 * Given the model that just answered, the model the turn should be re-run on —
 * or undefined to keep the answer. Undefined is the common case and costs one
 * cached /status read.
 */
export async function unfitModelReplacement(
  settings: KompassSettings,
  servedBy: string,
): Promise<string | undefined> {
  const status = await loadStatus(settings);
  if (!status) return undefined;
  if (!isVisionFallback(status, servedBy)) return undefined;
  return pickResearchModel(status, [servedBy]);
}
