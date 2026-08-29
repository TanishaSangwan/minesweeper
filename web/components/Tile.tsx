"use client";

interface TileProps {
  index: number;
  revealed: boolean;
  /** Neighbour-mine count, shown on every revealed tile to every player — the reward for
   *  revealing went to one player, but the information is public. 0 renders blank, as in
   *  classic Minesweeper. */
  adjacentMines: number;
  revealedByMe: boolean;
  flaggedBy: `0x${string}` | null;
  disabled: boolean;
  onReveal: (index: number) => void;
  onToggleFlag: (index: number) => void;
}

// Classic Minesweeper hint colours, picked to stay legible on the dark revealed-tile fill.
const HINT_COLORS = [
  "",
  "text-sky-400",
  "text-emerald-400",
  "text-red-400",
  "text-indigo-400",
  "text-amber-500",
  "text-cyan-400",
  "text-slate-200",
  "text-slate-400",
];

export function Tile({
  index,
  revealed,
  adjacentMines,
  revealedByMe,
  flaggedBy,
  disabled,
  onReveal,
  onToggleFlag,
}: TileProps) {
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
<<<<<<< HEAD
        "win-tile flex aspect-square w-full items-center justify-center text-sm leading-none",
        revealed
          ? revealedByMe
            ? "win-tile-sunken win-tile-sunken-mine text-emerald-700"
            : "win-tile-sunken text-neutral-500"
          : "win-tile-raised cursor-pointer disabled:cursor-not-allowed",
      ].join(" ")}
      title={flaggedBy ? `Flagged by ${flaggedBy}` : undefined}
    >
      {flaggedBy && !revealed ? "🚩" : ""}
=======
        "aspect-square w-full rounded-md border text-sm font-bold transition-colors",
        revealed
          ? revealedByMe
            ? "border-emerald-500 bg-emerald-500/20"
            : "border-slate-600 bg-slate-800/60"
          : "border-slate-700 bg-slate-900 hover:bg-slate-800 disabled:opacity-50",
        revealed ? HINT_COLORS[adjacentMines] ?? "text-slate-200" : "",
      ].join(" ")}
      title={flaggedBy ? `Flagged by ${flaggedBy}` : undefined}
    >
      {!revealed && flaggedBy ? "🚩" : revealed && adjacentMines > 0 ? adjacentMines : ""}
>>>>>>> ea9686aa51dcf81814208560cb0dde1ec5a50318
    </button>
  );
}
