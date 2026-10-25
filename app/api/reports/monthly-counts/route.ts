import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function currentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthRange(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  const start = `${month}-01`;
  const end = new Date(Date.UTC(y, m, 1)).toISOString().split("T")[0]; // 1st of next month
  return { start, end };
}

/**
 * GET /api/reports/monthly-counts?month=YYYY-MM
 * Completed/skipped planned_sessions counts for a calendar month — computed
 * live from planned_sessions, no running total is stored. Used by the
 * dashboard's monthly counter; `month` defaults to the current month.
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { userId, db } = auth;
  const params = req.nextUrl.searchParams;
  const month = params.get("month") ?? currentMonth();
  if (!MONTH_RE.test(month)) return NextResponse.json({ error: "month must be in YYYY-MM format." }, { status: 400 });

  const { start, end } = monthRange(month);

  const { data: sessions, error } = await db
    .from("planned_sessions")
    .select("completed, skipped")
    .eq("user_id", userId)
    .gte("planned_date", start)
    .lt("planned_date", end);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = sessions ?? [];
  const completed = rows.filter((s) => s.completed).length;
  const skipped = rows.filter((s) => s.skipped).length;

  return NextResponse.json({ month, completed, skipped, totalPlanned: rows.length });
}
