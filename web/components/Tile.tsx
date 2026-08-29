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
    </button>
  );
}
