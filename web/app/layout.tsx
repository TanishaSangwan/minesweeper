import type { Metadata } from "next";
import { VT323 } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

// Retro digital-display font, used only for the LED-style counters (entry fee, reward/tile) —
// evokes the classic Minesweeper mine-counter/timer displays.
const ledFont = VT323({ weight: "400", subsets: ["latin"], variable: "--font-led" });

export const metadata: Metadata = {
  title: "Minesweeper Tournament",
  description: "Competitive multiplayer Minesweeper on Monad",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={ledFont.variable}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
