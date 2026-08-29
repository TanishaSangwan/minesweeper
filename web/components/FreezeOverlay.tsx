"use client";

import { useEffect, useState } from "react";

export function FreezeOverlay({ freezeUntil }: { freezeUntil: number | null }) {
  const [remainingMs, setRemainingMs] = useState(0);

  useEffect(() => {
    if (!freezeUntil) return;
    const tick = () => setRemainingMs(Math.max(0, freezeUntil - Date.now()));
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [freezeUntil]);

  if (!freezeUntil || remainingMs <= 0) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="rounded-xl border border-red-500 bg-slate-900 px-8 py-6 text-center">
        <p className="text-3xl">💥</p>
        <p className="mt-2 text-lg font-semibold text-red-400">You hit a mine</p>
        <p className="mt-1 text-sm text-slate-400">Frozen for {(remainingMs / 1000).toFixed(1)}s</p>
      </div>
    </div>
  );
}
