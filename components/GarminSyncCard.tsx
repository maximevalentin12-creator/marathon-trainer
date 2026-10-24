"use client";

import { useEffect, useState } from "react";

export default function GarminSyncCard() {
  const [userId, setUserId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    setUserId(localStorage.getItem("marathon_user_id"));
  }, []);

  if (userId === undefined) return null;

  if (!userId) {
    return (
      <p className="text-xs text-gray-500">
        <a href="/onboarding" className="underline">
          Complete onboarding
        </a>{" "}
        first to link a Garmin sync to your profile.
      </p>
    );
  }

  return (
    <a
      href={`/api/garmin/sync?userId=${userId}`}
      className="inline-block px-3 py-1.5 text-xs font-medium text-white bg-gray-800 rounded hover:bg-gray-700 transition-colors"
    >
      GET /api/garmin/sync →
    </a>
  );
}
