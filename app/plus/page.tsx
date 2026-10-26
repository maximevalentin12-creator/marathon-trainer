import GarminSyncCard from "@/components/GarminSyncCard";
import CsvImportCard from "@/components/CsvImportCard";
import MonthlyReportCard from "@/components/MonthlyReportCard";
import SignOutButton from "@/components/SignOutButton";
import InjuryEpisodesCard from "@/components/InjuryEpisodesCard";

const LINKS = [
  { href: "/shoes", title: "L'armoire", text: "Tes paires, leurs kilomètres et leur usure." },
  { href: "/profil", title: "Profil", text: "Fréquence cardiaque max et de repos, allure facile estimée." },
  { href: "/trends", title: "Douleurs et fatigue", text: "Évolution hebdomadaire sur les 12 dernières semaines." },
  { href: "/onboarding", title: "Prise en main", text: "Records personnels, historique de blessures, import Garmin." },
];

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <h2 className="text-sm font-medium text-gray-700 mb-2">{title}</h2>
      {children}
    </div>
  );
}

export default function PlusPage() {
  return (
    <main className="max-w-xl mx-auto px-4 pt-6 pb-24 md:py-10">
      <h1 className="text-xl font-semibold tracking-tight mb-4">Plus</h1>

      <ul className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100 mb-6">
        {LINKS.map((l) => (
          <li key={l.href}>
            <a href={l.href} className="flex flex-col justify-center min-h-[64px] px-4 py-3">
              <span className="text-sm font-medium text-gray-900">{l.title}</span>
              <span className="text-xs text-gray-500">{l.text}</span>
            </a>
          </li>
        ))}
      </ul>

      <h2 className="text-sm font-semibold text-gray-700 mb-2 px-1">Santé</h2>
      <div className="mb-6">
        <Card title="Mes douleurs">
          <InjuryEpisodesCard />
        </Card>
      </div>

      <h2 className="text-sm font-semibold text-gray-700 mb-2 px-1">Données</h2>
      <div className="space-y-4">
        <Card title="Synchronisation Garmin">
          <GarminSyncCard />
        </Card>
        <Card title="Import CSV Garmin">
          <CsvImportCard />
        </Card>
        <Card title="Rapport mensuel">
          <p className="text-xs text-gray-500 mb-3">Kilomètres, résumé des courses et régularité d&apos;un mois, en PDF.</p>
          <MonthlyReportCard />
        </Card>
      </div>

      <SignOutButton className="mt-8 w-full px-4 py-3 min-h-[44px] text-sm font-medium border border-gray-300 text-gray-700 rounded-lg hover:border-gray-500 disabled:opacity-50" />
    </main>
  );
}
