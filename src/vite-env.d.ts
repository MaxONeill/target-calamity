/// <reference types="vite/client" />

/**
 * Typed access to the app's Vite env vars. The Clock model takes no operator
 * parameters — the countdown warp is bounded by each threshold's own published
 * uncertainty range (see clockModel), so there is nothing to configure here.
 */
interface ImportMetaEnv {
  readonly [key: `VITE_${string}`]: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
