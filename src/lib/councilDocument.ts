// Turn a finished Council run into a downloadable document.
//
// A Council run is the most expensive thing Kompass does — several models
// research in parallel, then a judge reconciles them. Leaving that on screen
// only, to be lost on the next question, wastes it. The judge's structure
// (answer, agreements, disagreements, sources) maps onto document sections
// almost directly, so the export keeps the reasoning rather than flattening
// everything into one blob of prose.
import type { CouncilRun } from "./council";
import type { DocSection, DocumentSpec } from "./documents";

export function councilToDocument(
  question: string,
  run: CouncilRun,
  format: DocumentSpec["format"] = "pdf",
): DocumentSpec {
  const v = run.verdict;
  const sections: DocSection[] = [];

  if (v?.answer) {
    sections.push({ heading: "Verdict", paragraphs: splitParagraphs(v.answer) });
  }

  // Disagreements before agreements: where the models diverged is the part a
  // reader cannot get from any single model, and the reason to run a council.
  if (v?.disagreements.length) {
    sections.push({
      heading: "Points of disagreement",
      bullets: v.disagreements.map((d) =>
        [d.point, d.positions?.join(" · ")].filter(Boolean).join(" — "),
      ),
    });
  }

  if (v?.agreements.length) {
    sections.push({ heading: "Points of agreement", bullets: v.agreements });
  }

  // Each agent's own answer, so the verdict can be checked rather than trusted.
  const answered = run.agents.filter((a) => a.answer);
  if (answered.length) {
    sections.push({
      heading: "Individual responses",
      paragraphs: [
        `${answered.length} of ${run.agents.length} agents returned an answer.`,
      ],
    });
    for (const a of answered) {
      sections.push({
        heading: `${a.spec.label} (${a.servedBy ?? a.spec.model})`,
        paragraphs: splitParagraphs(a.answer!),
      });
    }
  }

  // Sources as a table: a bare URL list is unreadable once it runs past ten.
  const sources = v?.sources ?? [];
  if (sources.length) {
    sections.push({
      heading: "Sources",
      table: {
        headers: ["#", "Title", "URL"],
        rows: sources.map((s, i) => [String(i + 1), s.title ?? "", s.url ?? ""]),
      },
    });
  }

  if (sections.length === 0) {
    sections.push({
      paragraphs: ["This council run produced no verdict before it was exported."],
    });
  }

  const failed = run.agents.length - answered.length;
  return {
    format,
    title: question.trim() || "Council run",
    subtitle:
      `Kompass AI Council · ${run.agents.length} agents` +
      (failed > 0 ? ` (${failed} failed)` : "") +
      (v?.servedBy ? ` · judged by ${v.servedBy}` : ""),
    sections,
  };
}

/** Blank-line separated prose becomes real paragraphs, not one wall of text. */
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}
