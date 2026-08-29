"use client";

import { Tile } from "./Tile";
import type { RevealedTile } from "@/hooks/useBoardSync";

interface BoardProps {
  width: number;
  height: number;
  revealed: Map<number, RevealedTile>;
  flags: Map<number, `0x${string}`>;
  myAddress: `0x${string}` | undefined;
  frozen: boolean;
  onReveal: (index: number) => void;
  onToggleFlag: (index: number) => void;
}

export function Board({ width, height, revealed, flags, myAddress, frozen, onReveal, onToggleFlag }: BoardProps) {
  const totalTiles = width * height;

  return (
    <div
      className="grid gap-1"
      style={{ gridTemplateColumns: `repeat(${width}, minmax(0, 1fr))`, maxWidth: `${width * 44}px` }}
    >
      {Array.from({ length: totalTiles }, (_, index) => {
        const tile = revealed.get(index);
        return (
          <Tile
            key={index}
            index={index}
            revealed={Boolean(tile)}
            revealedByMe={tile?.player === myAddress}
            flaggedBy={flags.get(index) ?? null}
            disabled={frozen}
            onReveal={onReveal}
            onToggleFlag={onToggleFlag}
          />
        );
      })}
    </div>
  );
}
