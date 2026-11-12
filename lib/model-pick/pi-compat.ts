/** Private credential-lock and metadata layouts reviewed against these hosts.
 * Profile identity/read-only preferences do not depend on this write allowlist.
 * Add a host only after running native lease, SDK override and picker regressions.
 */
export function isVerifiedPiVersion(version: string): boolean {
  return version === '1.4.0' || version === '1.5.2';
}
