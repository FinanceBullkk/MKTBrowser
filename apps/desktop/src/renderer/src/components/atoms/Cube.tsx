import type { JSX } from "react";
// Import as URL so Vite/electron-vite rewrite the path correctly in
// production builds. Hardcoding "/logo.png" worked in dev (Vite's dev
// server serves public/ at /) but 404'd in the packaged Electron
// app — the renderer loads via file://, and / there resolves to the
// filesystem root.
import logoUrl from "/logo.png?url";

interface Props {
  size?: number;
  glow?: boolean;
  className?: string;
}

/**
 * Brand mark — the 3D-ish cube with orange→pink→purple→blue gradient.
 * Renders the bundled PNG asset; falls back to a CSS gradient div.
 */
export function Cube({ size = 28, glow = true, className }: Props): JSX.Element {
  return (
    <img
      src={logoUrl}
      alt="MKT Browser"
      width={size}
      height={size}
      className={className}
      style={{
        display: "block",
        flexShrink: 0,
        filter: glow ? `drop-shadow(0 ${size * 0.15}px ${size * 0.5}px rgba(255, 61, 138, 0.35))` : undefined,
      }}
    />
  );
}
