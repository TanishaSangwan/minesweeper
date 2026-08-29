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

// The original Minesweeper hint palette (1 blue, 2 green, 3 red, 4 navy, 5 maroon, 6 teal,
// 7 black, 8 grey), in shades dark enough to read on the light sunken tile face.
const HINT_COLORS = [
  "",
  "text-blue-700",
  "text-green-700",
  "text-red-600",
  "text-blue-900",
  "text-red-900",
  "text-teal-700",
  "text-black",
  "text-neutral-600",
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
        "win-tile flex aspect-square w-full items-center justify-center text-sm font-bold leading-none",
        revealed
          ? revealedByMe
            ? "win-tile-sunken win-tile-sunken-mine"
            : "win-tile-sunken"
          : "win-tile-raised cursor-pointer disabled:cursor-not-allowed",
        // The hint colour has to win over the tile's own text colour, so it comes last.
        revealed ? HINT_COLORS[adjacentMines] ?? "text-black" : "",
      ].join(" ")}
      title={flaggedBy ? `Flagged by ${flaggedBy}` : undefined}
    >
      {!revealed && flaggedBy ? "🚩" : revealed && adjacentMines > 0 ? adjacentMines : ""}
    </button>
  );
}
