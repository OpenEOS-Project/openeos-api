/**
 * Version dieser Installation, wie sie `/health` und der MCP-Server melden.
 *
 * Die GitHub Action setzt `APP_VERSION` als Build-Nummer (z. B. "1.0.123");
 * lokal und in Entwicklungslaeufen gilt die Paketversion.
 */
export function appVersion(): string {
  return process.env.APP_VERSION || process.env.npm_package_version || 'dev';
}
