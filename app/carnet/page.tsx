export default function CarnetPage() {
  return (
    <main className="max-w-xl mx-auto px-4 pt-6 pb-24 md:py-10">
      <h1 className="text-xl font-semibold tracking-tight mb-4">Carnet</h1>
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <p className="text-sm text-gray-800">Ton carnet d&apos;entraînement arrive bientôt.</p>
        <p className="text-xs text-gray-500 mt-1">En attendant, tu retrouves tes séances passées et ton ressenti ici :</p>
        <div className="mt-3 flex flex-col gap-1">
          <a href="/historique" className="min-h-[44px] flex items-center text-sm font-medium text-accent underline">
            Historique des séances →
          </a>
          <a href="/log" className="min-h-[44px] flex items-center text-sm font-medium text-accent underline">
            Noter une séance (ressenti, douleurs) →
          </a>
        </div>
      </div>
    </main>
  );
}
