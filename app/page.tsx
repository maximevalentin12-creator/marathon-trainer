import MonthlyReportCard from "@/components/MonthlyReportCard";
import GarminSyncCard from "@/components/GarminSyncCard";
import CsvImportCard from "@/components/CsvImportCard";
import WeeklyPlanCard from "@/components/WeeklyPlanCard";
import WeeklyMileageCard from "@/components/WeeklyMileageCard";
import MonthlyCounter from "@/components/MonthlyCounter";
import RaceCard from "@/components/RaceCard";

export default function Home() {
  return (
    <main className="max-w-xl mx-auto px-4 py-12">
      <header className="mb-10">
        <h1 className="text-xl font-semibold tracking-tight">Marathon Trainer</h1>
        <p className="mt-1 text-sm text-gray-500">Personal training planner — dev build</p>
      </header>

      <MonthlyCounter />

      <div className="space-y-5">
        <Card title="Onboarding">
          <p className="text-xs text-gray-500 mb-3">
            Set up your profile: personal records, race date, injury history,
            and auto-import of your Garmin history.
          </p>
          <a
            href="/onboarding"
            className="inline-block px-3 py-1.5 text-xs font-medium text-white bg-accent rounded hover:opacity-90 transition-opacity"
          >
            Start onboarding →
          </a>
        </Card>
        <Card title="Post-run log">
          <p className="text-xs text-gray-500 mb-3">
            Record mood, energy, pain, and notes after each run.
          </p>
          <a
            href="/log"
            className="inline-block px-3 py-1.5 text-xs font-medium text-white bg-accent rounded hover:opacity-90 transition-opacity"
          >
            Log a run →
          </a>
        </Card>

        <Card title="Pain &amp; fatigue trend">
          <p className="text-xs text-gray-500 mb-3">
            Weekly averages of pain, energy, and mood over the last 12 weeks.
          </p>
          <a
            href="/trends"
            className="inline-block px-3 py-1.5 text-xs font-medium border border-gray-200 text-gray-600 rounded hover:border-gray-400 transition-colors"
          >
            View trends →
          </a>
        </Card>

        <Card title="Garmin sync">
          <p className="text-xs text-gray-500 mb-3">
            Pulls your full running history (up to 5 years) into{" "}
            <code className="bg-gray-100 px-1 rounded">garmin_activities</code>.
            Requires <code className="bg-gray-100 px-1 rounded">GARMIN_USERNAME</code> and{" "}
            <code className="bg-gray-100 px-1 rounded">GARMIN_PASSWORD</code> env vars.
          </p>
          <GarminSyncCard />
        </Card>

        <Card title="Import CSV Garmin">
          <CsvImportCard />
        </Card>

        <WeeklyMileageCard />

        <Card title="Prochaine course">
          <RaceCard />
        </Card>

        <Card title="This week's plan">
          <p className="text-xs text-gray-500 mb-3">
            Pick how many runs you can fit in this week and how many are indoor —
            the planner adapts the rest (duration, quality-session variety, and any
            downgrade based on how you&apos;ve been feeling).
          </p>
          <WeeklyPlanCard />
        </Card>

        <Card title="Profil">
          <p className="text-xs text-gray-500 mb-3">
            FC max et FC repos — elles calibrent tes zones et l&apos;évaluation de tes séances — et ton allure facile
            estimée.
          </p>
          <a
            href="/profil"
            className="inline-block px-3 py-1.5 text-xs font-medium border border-gray-200 text-gray-600 rounded hover:border-gray-400 transition-colors"
          >
            Voir le profil →
          </a>
        </Card>

        <Card title="Historique">
          <p className="text-xs text-gray-500 mb-3">
            Every past session, week by week — planned vs actual, evaluation, shoes, and runs done outside the plan.
          </p>
          <a
            href="/historique"
            className="inline-block px-3 py-1.5 text-xs font-medium border border-gray-200 text-gray-600 rounded hover:border-gray-400 transition-colors"
          >
            Voir l&apos;historique →
          </a>
        </Card>

        <Card title="Monthly report">
          <p className="text-xs text-gray-500 mb-3">
            Mileage, VMA, race summaries, and improvement/consistency scores for a given month,
            exported as a PDF.
          </p>
          <MonthlyReportCard />
        </Card>

        <Card title="L'armoire">
          <p className="text-xs text-gray-500 mb-3">
            Track your shoe rotation: specs, cumulative km, and wear per pair.
          </p>
          <a
            href="/shoes"
            className="inline-block px-3 py-1.5 text-xs font-medium text-white bg-accent rounded hover:opacity-90 transition-opacity"
          >
            Ouvrir l&apos;armoire →
          </a>
        </Card>

        <Card title="Database schema">
          <p className="text-xs text-gray-500">
            Run <code className="bg-gray-100 px-1 rounded">supabase/schema.sql</code> in your
            Supabase SQL editor to create all four tables:{" "}
            <span className="font-mono">users</span>,{" "}
            <span className="font-mono">garmin_activities</span>,{" "}
            <span className="font-mono">planned_sessions</span>,{" "}
            <span className="font-mono">subjective_entries</span>.
          </p>
        </Card>
      </div>
    </main>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-gray-200 rounded-lg p-4">
      <h2 className="text-sm font-medium text-gray-700 mb-2">{title}</h2>
      {children}
    </div>
  );
}
