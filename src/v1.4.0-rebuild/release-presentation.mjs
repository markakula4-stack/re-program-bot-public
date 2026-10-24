// Display identity comes from the already installed server release runtime.
// This helper grants no access and reads no browser or environment override.
const RUNTIME_KEY='__RE_PROGRAM_PUBLIC_RELEASE_RUNTIME__';
const VERSION=/^\d+\.\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/u;
const MARKER='<span data-release-version>RE Program</span>';
export function publicReleaseVersion() {
  const version=globalThis[RUNTIME_KEY]?.version;
  return typeof version==='string'&&version.length<=80&&VERSION.test(version)?version:'1.4.1.1';
}
export function renderCabinetReleaseVersion(content) {
  return content.replace(MARKER,'<span data-release-version>v'+publicReleaseVersion()+'</span>');
}
