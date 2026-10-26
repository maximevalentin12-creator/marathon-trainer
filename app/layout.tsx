import type { Metadata, Viewport } from "next";
import "./globals.css";
import ServiceWorkerRegistrar from "@/components/ServiceWorkerRegistrar";
import TabBar from "@/components/TabBar";
import { createSupabaseServerClient } from "@/lib/auth/server";

export const metadata: Metadata = {
  title: "Marathon Trainer",
  description: "Personal marathon training planner",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Marathon",
  },
};

export const viewport: Viewport = {
  themeColor: "#DCC9EE",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Session-aware: the navigation only exists for a signed-in user (the middleware keeps everyone else on /login).
  const {
    data: { user },
  } = await createSupabaseServerClient().auth.getUser();

  return (
    <html lang="fr">
      <body className="bg-surface min-h-screen font-sans antialiased text-gray-900">
        <ServiceWorkerRegistrar />
        {user && <TabBar />}
        {children}
      </body>
    </html>
  );
}
