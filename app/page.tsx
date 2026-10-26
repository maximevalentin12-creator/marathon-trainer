import WeeklyPlanCard from "@/components/WeeklyPlanCard";
import WeeklyMileageCard from "@/components/WeeklyMileageCard";
import MonthlyCounter from "@/components/MonthlyCounter";
import NextRaceCard from "@/components/NextRaceCard";
import DebriefBanner from "@/components/DebriefBanner";

export default function Home() {
  return (
    <main className="max-w-xl mx-auto px-4 pt-6 pb-24 md:py-10">
      <header className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">Aujourd&apos;hui</h1>
      </header>

      <DebriefBanner />

      <MonthlyCounter />

      <div className="space-y-4">
        <Card title="Prochaine course">
          <NextRaceCard />
        </Card>

        <WeeklyMileageCard />

        <Card title="Cette semaine">
          <p className="text-xs text-gray-500 mb-3">
            Choisis combien de sorties tu peux faire cette semaine : le plan adapte la durée des séances et tient
            compte de ton ressenti.
          </p>
          <WeeklyPlanCard />
        </Card>
      </div>
    </main>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <h2 className="text-sm font-medium text-gray-700 mb-2">{title}</h2>
      {children}
    </div>
  );
}
