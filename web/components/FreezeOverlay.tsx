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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="win-window w-72">
        <div className="win-titlebar flex items-center justify-between px-2 py-1 text-sm">
          <span>⚠ Boom!</span>
          <span className="win-raised flex h-4 w-4 items-center justify-center text-xs leading-none text-black">
            ✕
          </span>
        </div>
        <div className="flex items-start gap-3 p-4">
          <p className="text-3xl leading-none">💥</p>
          <div>
            <p className="text-sm font-bold">You hit a mine!</p>
            <p className="mt-1 text-sm">Frozen — no moves for {(remainingMs / 1000).toFixed(1)}s</p>
          </div>
        </div>
      </div>
    </div>
  );
}
