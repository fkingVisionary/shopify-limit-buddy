/**
 * Where non-technical users get the Windows app.
 * Prefer an explicit CDN/env URL; otherwise GitHub Releases latest asset
 * (stable filename Vanta-Beta-Setup.exe from the desktop Windows workflow).
 */

const DEFAULT_REPO = "fkingVisionary/shopify-limit-buddy";
const SETUP_FILENAME = "Vanta-Beta-Setup.exe";
const PORTABLE_FILENAME = "Vanta-Beta-Portable.exe";

function githubRepo() {
  return String(process.env.VANTA_GITHUB_REPO || process.env.GITHUB_REPOSITORY || DEFAULT_REPO).trim();
}

/** Direct download URL for the Windows installer (Setup). */
export function vantaWinSetupUrl(): string {
  const override = String(process.env.VANTA_WIN_SETUP_URL || process.env.DESKTOP_WIN_SETUP_URL || "").trim();
  if (override) return override;
  return `https://github.com/${githubRepo()}/releases/latest/download/${SETUP_FILENAME}`;
}

export function vantaWinPortableUrl(): string {
  const override = String(process.env.VANTA_WIN_PORTABLE_URL || "").trim();
  if (override) return override;
  return `https://github.com/${githubRepo()}/releases/latest/download/${PORTABLE_FILENAME}`;
}

export function vantaProductName(): string {
  return "Vanta Beta";
}

export { SETUP_FILENAME, PORTABLE_FILENAME };
