import type { Metadata, Viewport } from "next";
import "./globals.css";
import ServiceWorkerRegistrar from "@/components/ServiceWorkerRegistrar";

export const metadata: Metadata = {
  title: "Marathon Trainer",
  description: "Personal marathon training planner",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Marathon",
  },
};

export const viewport: Viewport = {
  themeColor: "#4a7c3f",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body className="bg-surface min-h-screen font-sans antialiased text-gray-900">
        <ServiceWorkerRegistrar />
        {children}
      </body>
    </html>
  );
}
