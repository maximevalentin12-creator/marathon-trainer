import PDFDocument from "pdfkit";
import type { MonthlySummary } from "./types";

type PDFDoc = InstanceType<typeof PDFDocument>;

const INK = "#111827";
const LABEL = "#374151";
const MUTED = "#6b7280";
const FAINT = "#9ca3af";
const GOOD = "#15803d";
const BAD = "#dc2626";

function sectionTitle(doc: PDFDoc, title: string) {
  doc.moveDown(0.6);
  doc.fontSize(13).fillColor(INK).text(title);
  doc.moveDown(0.3);
}

function kv(doc: PDFDoc, label: string, value: string) {
  doc
    .fontSize(10)
    .fillColor(LABEL)
    .text(`${label}: `, { continued: true })
    .fillColor(INK)
    .text(value);
}

function formatPace(secPerKm: number): string {
  const min = Math.floor(secPerKm / 60);
  const sec = Math.round(secPerKm % 60);
  return `${min}:${sec.toString().padStart(2, "0")}/km`;
}

export function renderMonthlySummaryPdf(summary: MonthlySummary): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(20).fillColor(INK).text("Marathon Trainer — Monthly Report");
    doc.fontSize(12).fillColor(MUTED).text(summary.monthLabel);

    sectionTitle(doc, "Overview");
    kv(doc, "Total mileage", `${summary.totalKm.toFixed(1)} km`);
    kv(doc, "Activities logged", `${summary.activityCount}`);
    kv(doc, "VMA score (Garmin VO2max estimate)", summary.vmaScore !== null ? summary.vmaScore.toFixed(1) : "No data");
    kv(doc, "Run type", summary.runType);

    sectionTitle(doc, "Scores");
    kv(doc, "Overall improvement score", summary.improvementScore !== null ? `${summary.improvementScore.toFixed(1)}%` : "N/A");
    doc.fontSize(9).fillColor(FAINT).text(summary.improvementNote);
    doc.moveDown(0.4);
    kv(doc, "Overall consistency score", summary.consistencyScore !== null ? `${summary.consistencyScore}%` : "N/A");
    doc.fontSize(9).fillColor(FAINT).text(summary.consistencyNote);
    doc.moveDown(0.4);
    doc
      .fontSize(10)
      .fillColor(LABEL)
      .text("Sessions completed: ", { continued: true })
      .fillColor(GOOD)
      .text(`${summary.completedCount}`, { continued: true })
      .fillColor(LABEL)
      .text("   Sessions skipped: ", { continued: true })
      .fillColor(BAD)
      .text(`${summary.skippedCount}`);

    sectionTitle(doc, "Races this month");
    if (summary.races.length === 0) {
      doc.fontSize(10).fillColor(MUTED).text("No races recorded this month.");
    } else {
      for (const race of summary.races) {
        doc.fontSize(11).fillColor(INK).text(`${race.date} — ${race.distanceKm.toFixed(2)} km`);
        doc
          .fontSize(9)
          .fillColor(MUTED)
          .text(
            `Duration: ${race.durationMinutes} min · Pace: ${
              race.avgPaceSecPerKm ? formatPace(race.avgPaceSecPerKm) : "—"
            } · HR: ${race.avgHeartRate ?? "—"} · VO2max: ${race.vo2maxEstimate ?? "—"}`
          );
        doc.fontSize(9).fillColor(FAINT).text(`Type: ${race.runType}`);
        doc.moveDown(0.4);
      }
    }

    sectionTitle(doc, "Suggestions");
    for (const suggestion of summary.suggestions) {
      doc.fontSize(10).fillColor(LABEL).text(`• ${suggestion}`);
    }

    doc.end();
  });
}
