import { NextRequest, NextResponse } from "next/server";
import { buildMonthlySummary } from "@/lib/reports/monthlySummary";
import { renderMonthlySummaryPdf } from "@/lib/reports/pdf";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function currentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * GET /api/reports/monthly?userId=<uuid>&month=YYYY-MM
 * Generates and streams back a PDF monthly training summary.
 * `month` defaults to the current calendar month if omitted.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const userId = params.get("userId");
  const month = params.get("month") ?? currentMonth();

  if (!userId) {
    return NextResponse.json({ error: "Required query param: userId." }, { status: 400 });
  }
  if (!MONTH_RE.test(month)) {
    return NextResponse.json({ error: "month must be in YYYY-MM format." }, { status: 400 });
  }

  try {
    const summary = await buildMonthlySummary(userId, month);
    const pdf = await renderMonthlySummaryPdf(summary);

    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="marathon-report-${month}.pdf"`,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to generate report." },
      { status: 500 }
    );
  }
}
