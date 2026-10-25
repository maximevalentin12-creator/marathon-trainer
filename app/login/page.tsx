"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/auth/browser";

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get("next");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await createSupabaseBrowserClient().auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) {
      setError("E-mail ou mot de passe incorrect.");
      return;
    }
    // Only same-site paths: never follow a full URL from the query string.
    router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
    router.refresh();
  }

  const field =
    "w-full px-3 py-2.5 min-h-[44px] text-base border border-gray-200 rounded-lg bg-white focus:outline-none focus:border-gray-400";

  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="block">
        <span className="text-xs text-gray-600 block mb-1">E-mail</span>
        <input
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={field}
        />
      </label>
      <label className="block">
        <span className="text-xs text-gray-600 block mb-1">Mot de passe</span>
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={field}
        />
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={busy}
        className="w-full px-4 py-3 min-h-[44px] text-sm font-medium text-white bg-accent rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        {busy ? "Connexion…" : "Se connecter"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="max-w-sm mx-auto px-4 pt-16 pb-10">
      <h1 className="text-xl font-semibold tracking-tight mb-1">Marathon Trainer</h1>
      <p className="text-sm text-gray-600 mb-6">Connecte-toi pour retrouver ton plan.</p>
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
