/// <reference types="vite/client" />

/**
 * Typed access to the app's Vite env vars. `VITE_CLOCK_MAX_SHIFT_YEARS` is the
 * operator-set bound (in years) on how far net direction may shift the Clock's
 * tipping-point baseline — an estimate, not a hardcoded figure (see clockModel).
 */
interface ImportMetaEnv {
  readonly VITE_CLOCK_MAX_SHIFT_YEARS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
