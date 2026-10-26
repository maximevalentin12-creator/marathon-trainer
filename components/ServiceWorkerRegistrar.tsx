"use client";

import { useEffect } from "react";

export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let registration: ServiceWorkerRegistration | undefined;
    navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then((r) => {
        registration = r;
      })
      .catch((err) => console.warn("SW registration failed:", err));

    // A home-screen app is resumed, not reloaded: look for a new deploy every time it comes back to the front.
    const check = () => {
      if (document.visibilityState === "visible") void registration?.update().catch(() => {});
    };
    document.addEventListener("visibilitychange", check);
    return () => document.removeEventListener("visibilitychange", check);
  }, []);

  return null;
}
