"use client";

interface TileProps {
  index: number;
  revealed: boolean;
  revealedByMe: boolean;
  flaggedBy: `0x${string}` | null;
  disabled: boolean;
  onReveal: (index: number) => void;
  onToggleFlag: (index: number) => void;
}

export function Tile({ index, revealed, revealedByMe, flaggedBy, disabled, onReveal, onToggleFlag }: TileProps) {
  return (
    <button
      type="button"
      disabled={revealed || disabled}
      onClick={() => onReveal(index)}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!revealed) onToggleFlag(index);
      }}
      className={[
        "aspect-square w-full rounded-md border text-xs font-semibold transition-colors",
        revealed
          ? revealedByMe
            ? "border-emerald-500 bg-emerald-500/20 text-emerald-300"
            : "border-slate-600 bg-slate-800/60 text-slate-400"
          : "border-slate-700 bg-slate-900 hover:bg-slate-800 disabled:opacity-50",
      ].join(" ")}
      title={flaggedBy ? `Flagged by ${flaggedBy}` : undefined}
    >
      {flaggedBy && !revealed ? "🚩" : revealed ? "" : ""}
    </button>
  );
}
