// Document generation: PDF, Word, PowerPoint and Excel from one structured spec.
//
// The model produces STRUCTURE, not a formatted file. That split is the whole
// design: asking a model for "a nice PDF" gets you prose describing a PDF, and
// asking it to emit raw markup gets you broken markup. It emits headings,
// paragraphs, bullets and tables; the renderers below own typography, spacing
// and colour, so every document looks deliberate regardless of which free model
// happened to answer.
//
// All four render in the BROWSER. Nothing is uploaded to generate a file, which
// keeps the app's "no backend sees your content" property intact.

export interface DocTable {
  headers: string[];
  rows: string[][];
}

export interface DocSection {
  heading?: string;
  paragraphs?: string[];
  bullets?: string[];
  table?: DocTable;
  /** Speaker notes — used by pptx, ignored elsewhere. */
  notes?: string;
}

export type DocFormat = "pdf" | "docx" | "pptx" | "xlsx";

export interface DocumentSpec {
  format: DocFormat;
  title: string;
  subtitle?: string;
  sections: DocSection[];
}

export interface RenderedDocument {
  blob: Blob;
  filename: string;
}

/** One accent, used consistently across all four formats. */
const ACCENT = { r: 79, g: 91, b: 213 };
const ACCENT_HEX = "4F5BD5";
const INK_HEX = "16161A";
const MUTED_HEX = "6B6B75";

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "document"
  );
}

/* ── PDF ──────────────────────────────────────────────────────────────────── */

async function renderPdf(spec: DocumentSpec): Promise<Blob> {
  const { jsPDF } = await import("jspdf");
  const autoTable = (await import("jspdf-autotable")).default;
  const doc = new jsPDF({ unit: "pt", format: "a4" });

  const M = 56; // margin
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  let y = M;

  const newPageIfNeeded = (needed: number) => {
    if (y + needed > H - M) {
      doc.addPage();
      y = M;
    }
  };

  // Title block: an accent rule rather than a coloured banner — it reads as
  // typeset rather than as a template.
  doc.setFillColor(ACCENT.r, ACCENT.g, ACCENT.b);
  doc.rect(M, y, 38, 3.5, "F");
  y += 26;
  doc.setFont("helvetica", "bold").setFontSize(24).setTextColor(22, 22, 26);
  const titleLines = doc.splitTextToSize(spec.title, W - M * 2) as string[];
  doc.text(titleLines, M, y);
  y += titleLines.length * 28;

  if (spec.subtitle) {
    doc
      .setFont("helvetica", "normal")
      .setFontSize(12)
      .setTextColor(107, 107, 117);
    const sub = doc.splitTextToSize(spec.subtitle, W - M * 2) as string[];
    doc.text(sub, M, y);
    y += sub.length * 16;
  }
  y += 14;

  for (const section of spec.sections) {
    if (section.heading) {
      newPageIfNeeded(40);
      doc.setFont("helvetica", "bold").setFontSize(14).setTextColor(22, 22, 26);
      const h = doc.splitTextToSize(section.heading, W - M * 2) as string[];
      doc.text(h, M, y);
      y += h.length * 18 + 6;
    }

    for (const p of section.paragraphs ?? []) {
      doc
        .setFont("helvetica", "normal")
        .setFontSize(10.5)
        .setTextColor(40, 40, 46);
      const lines = doc.splitTextToSize(p, W - M * 2) as string[];
      newPageIfNeeded(lines.length * 14 + 8);
      doc.text(lines, M, y, { lineHeightFactor: 1.45 });
      y += lines.length * 15 + 8;
    }

    for (const b of section.bullets ?? []) {
      doc
        .setFont("helvetica", "normal")
        .setFontSize(10.5)
        .setTextColor(40, 40, 46);
      const lines = doc.splitTextToSize(b, W - M * 2 - 16) as string[];
      newPageIfNeeded(lines.length * 14 + 4);
      doc.setFillColor(ACCENT.r, ACCENT.g, ACCENT.b);
      doc.circle(M + 3, y - 3.5, 1.8, "F");
      doc.text(lines, M + 16, y, { lineHeightFactor: 1.45 });
      y += lines.length * 15 + 4;
    }

    if (section.table) {
      newPageIfNeeded(80);
      autoTable(doc, {
        head: [section.table.headers],
        body: section.table.rows,
        startY: y + 4,
        margin: { left: M, right: M },
        styles: {
          font: "helvetica",
          fontSize: 9.5,
          cellPadding: 6,
          textColor: [40, 40, 46],
        },
        headStyles: {
          fillColor: [ACCENT.r, ACCENT.g, ACCENT.b],
          textColor: 255,
          fontStyle: "bold",
        },
        alternateRowStyles: { fillColor: [246, 246, 249] },
        theme: "grid",
        tableLineColor: [226, 226, 232],
        tableLineWidth: 0.5,
      });
      y =
        (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable
          .finalY + 18;
    }
    y += 6;
  }

  // Page numbers, added last so the total is known.
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc
      .setFont("helvetica", "normal")
      .setFontSize(8.5)
      .setTextColor(150, 150, 158);
    doc.text(`${i} / ${pages}`, W - M, H - 24, { align: "right" });
  }

  return doc.output("blob");
}

/* ── Word ─────────────────────────────────────────────────────────────────── */

async function renderDocx(spec: DocumentSpec): Promise<Blob> {
  const d = await import("docx");
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    Table,
    TableRow,
    TableCell,
    WidthType,
    AlignmentType,
    BorderStyle,
  } = d;

  // Mixed Paragraph | Table content; docx's own union is what the section takes.
  const children: (
    InstanceType<typeof Paragraph> | InstanceType<typeof Table>
  )[] = [];

  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: spec.title, bold: true, size: 48, color: INK_HEX }),
      ],
      spacing: { after: spec.subtitle ? 120 : 360 },
    }),
  );
  if (spec.subtitle) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: spec.subtitle, size: 24, color: MUTED_HEX }),
        ],
        spacing: { after: 360 },
        border: {
          bottom: {
            style: BorderStyle.SINGLE,
            size: 6,
            color: ACCENT_HEX,
            space: 8,
          },
        },
      }),
    );
  }

  for (const section of spec.sections) {
    if (section.heading) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [
            new TextRun({
              text: section.heading,
              bold: true,
              size: 28,
              color: INK_HEX,
            }),
          ],
          spacing: { before: 320, after: 140 },
        }),
      );
    }
    for (const p of section.paragraphs ?? []) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: p, size: 22 })],
          spacing: { after: 160, line: 320 },
        }),
      );
    }
    for (const b of section.bullets ?? []) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: b, size: 22 })],
          bullet: { level: 0 },
          spacing: { after: 80, line: 300 },
        }),
      );
    }
    if (section.table) {
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              tableHeader: true,
              children: section.table.headers.map(
                (h) =>
                  new TableCell({
                    shading: { fill: ACCENT_HEX },
                    margins: { top: 80, bottom: 80, left: 120, right: 120 },
                    children: [
                      new Paragraph({
                        children: [
                          new TextRun({
                            text: h,
                            bold: true,
                            color: "FFFFFF",
                            size: 20,
                          }),
                        ],
                      }),
                    ],
                  }),
              ),
            }),
            ...section.table.rows.map(
              (row, i) =>
                new TableRow({
                  children: row.map(
                    (cell) =>
                      new TableCell({
                        shading: i % 2 ? { fill: "F6F6F9" } : undefined,
                        margins: { top: 80, bottom: 80, left: 120, right: 120 },
                        children: [
                          new Paragraph({
                            children: [new TextRun({ text: cell, size: 20 })],
                          }),
                        ],
                      }),
                  ),
                }),
            ),
          ],
        }),
      );
      children.push(new Paragraph({ text: "", spacing: { after: 200 } }));
    }
  }

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 480 },
      children: [
        new TextRun({
          text: "Generated with Kompass AI",
          size: 16,
          color: MUTED_HEX,
        }),
      ],
    }),
  );

  const doc = new Document({
    sections: [{ properties: {}, children: children as never }],
  });
  return Packer.toBlob(doc);
}

/* ── PowerPoint ───────────────────────────────────────────────────────────── */

async function renderPptx(spec: DocumentSpec): Promise<Blob> {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9";

  const title = pptx.addSlide();
  title.background = { color: "0B0B0D" };
  title.addShape(pptx.ShapeType.rect, {
    x: 0.6,
    y: 2.2,
    w: 0.9,
    h: 0.06,
    fill: { color: ACCENT_HEX },
  });
  title.addText(spec.title, {
    x: 0.6,
    y: 2.45,
    w: 8.6,
    h: 1.1,
    fontSize: 40,
    bold: true,
    color: "FFFFFF",
  });
  if (spec.subtitle) {
    title.addText(spec.subtitle, {
      x: 0.6,
      y: 3.6,
      w: 8.6,
      h: 0.6,
      fontSize: 16,
      color: "A0A0AA",
    });
  }

  for (const section of spec.sections) {
    const slide = pptx.addSlide();
    slide.addText(section.heading ?? spec.title, {
      x: 0.6,
      y: 0.45,
      w: 8.6,
      h: 0.7,
      fontSize: 26,
      bold: true,
      color: INK_HEX,
    });
    slide.addShape(pptx.ShapeType.rect, {
      x: 0.6,
      y: 1.18,
      w: 0.7,
      h: 0.045,
      fill: { color: ACCENT_HEX },
    });

    let y = 1.5;
    for (const p of section.paragraphs ?? []) {
      slide.addText(p, {
        x: 0.6,
        y,
        w: 8.6,
        h: 0.8,
        fontSize: 14,
        color: "33333B",
      });
      y += 0.75;
    }
    if (section.bullets?.length) {
      slide.addText(
        section.bullets.map((b) => ({ text: b, options: { bullet: true } })),
        {
          x: 0.7,
          y,
          w: 8.5,
          h: 4.2 - y,
          fontSize: 14,
          color: "33333B",
          lineSpacingMultiple: 1.3,
        },
      );
    }
    if (section.table) {
      slide.addTable(
        [
          section.table.headers.map((h) => ({
            text: h,
            options: {
              bold: true,
              color: "FFFFFF",
              fill: { color: ACCENT_HEX },
            },
          })),
          ...section.table.rows.map((r) => r.map((c) => ({ text: c }))),
        ],
        {
          x: 0.6,
          y: Math.max(y, 1.6),
          w: 8.6,
          fontSize: 11,
          border: { pt: 0.5, color: "E2E2E8" },
        },
      );
    }
    if (section.notes) slide.addNotes(section.notes);
  }

  return (await pptx.write({ outputType: "blob" })) as Blob;
}

/* ── Excel ────────────────────────────────────────────────────────────────── */

async function renderXlsx(spec: DocumentSpec): Promise<Blob> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Kompass AI";
  wb.created = new Date();

  // One sheet per table; sections without a table become a summary sheet, so a
  // prose answer still produces a usable workbook rather than an empty one.
  const tables = spec.sections.filter((s) => s.table);

  if (tables.length === 0) {
    const ws = wb.addWorksheet("Summary");
    ws.columns = [{ width: 110 }];
    ws.addRow([spec.title]).font = {
      size: 16,
      bold: true,
      color: { argb: "FF16161A" },
    };
    if (spec.subtitle)
      ws.addRow([spec.subtitle]).font = { color: { argb: "FF6B6B75" } };
    ws.addRow([]);
    for (const s of spec.sections) {
      if (s.heading) ws.addRow([s.heading]).font = { bold: true, size: 12 };
      for (const p of s.paragraphs ?? [])
        ws.addRow([p]).alignment = { wrapText: true, vertical: "top" };
      for (const b of s.bullets ?? [])
        ws.addRow([`• ${b}`]).alignment = { wrapText: true, vertical: "top" };
      ws.addRow([]);
    }
  }

  tables.forEach((section, i) => {
    const name = (section.heading ?? `Table ${i + 1}`)
      .slice(0, 28)
      .replace(/[\\/*?:[\]]/g, "");
    const ws = wb.addWorksheet(name || `Table ${i + 1}`);
    const t = section.table!;

    const header = ws.addRow(t.headers);
    header.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    header.height = 22;
    header.eachCell((cell) => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: `FF${ACCENT_HEX}` },
      };
      cell.alignment = { vertical: "middle" };
    });

    t.rows.forEach((r, ri) => {
      const row = ws.addRow(r);
      if (ri % 2) {
        row.eachCell((cell) => {
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFF6F6F9" },
          };
        });
      }
    });

    // Width from content, so nothing arrives as ####.
    ws.columns.forEach((col, ci) => {
      const cells = [t.headers[ci] ?? "", ...t.rows.map((r) => r[ci] ?? "")];
      col.width = Math.min(
        60,
        Math.max(12, ...cells.map((c) => String(c).length + 4)),
      );
    });
    ws.views = [{ state: "frozen", ySplit: 1 }];
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: t.headers.length },
    };
  });

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

/* ── Entry point ──────────────────────────────────────────────────────────── */

const EXT: Record<DocFormat, string> = {
  pdf: "pdf",
  docx: "docx",
  pptx: "pptx",
  xlsx: "xlsx",
};

export async function renderDocument(
  spec: DocumentSpec,
): Promise<RenderedDocument> {
  const blob =
    spec.format === "pdf"
      ? await renderPdf(spec)
      : spec.format === "docx"
        ? await renderDocx(spec)
        : spec.format === "pptx"
          ? await renderPptx(spec)
          : await renderXlsx(spec);
  return { blob, filename: `${slug(spec.title)}.${EXT[spec.format]}` };
}
