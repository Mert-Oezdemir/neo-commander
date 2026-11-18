// electron-builder afterPack hook. macOS only: ad-hoc sign the .app (no Apple Developer account needed).
// Without any signature, Apple Silicon reports a downloaded app as "damaged". With an ad-hoc signature
// Gatekeeper shows the normal "unidentified developer" prompt (right-click -> Open works).
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // Fuses are normally flipped by electron-builder AFTER this hook, which would invalidate the signature made
  // below. Flip them first with the very same config (electron-builder's later flip is then a no-op in content),
  // so the ad-hoc signature covers the final binary.
  try {
    const fuses = context.packager.config.electronFuses;
    if (fuses) await context.packager.addElectronFuses(context, await context.packager.generateFuseConfig(fuses));
  } catch (e) {
    console.warn(`  ! could not pre-flip fuses (${e.message}); electron-builder will still flip them, but re-check the signature`);
  }
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
    console.log(`  - ad-hoc signed ${app}`);
  } catch (e) {
    console.warn(`  ! ad-hoc signing failed (${e.message}); the app may show as "damaged" on Apple Silicon`);
  }
};
