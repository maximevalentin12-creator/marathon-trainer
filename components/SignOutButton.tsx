"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/auth/browser";

/** Ends the session, wipes the offline cache (it may hold personal pages) and goes back to the sign-in page. */
export default function SignOutButton({ className }: { className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    await createSupabaseBrowserClient().auth.signOut();
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch {
      // Cache API unavailable: nothing to wipe.
    }
    router.replace("/login");
    router.refresh();
  }

  return (
    <button type="button" disabled={busy} onClick={signOut} className={className}>
      {busy ? "Déconnexion…" : "Se déconnecter"}
    </button>
  );
}
