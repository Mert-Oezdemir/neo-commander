// electron-builder afterPack hook. macOS only: ad-hoc sign the .app (no Apple Developer account needed).
// Without any signature, Apple Silicon reports a downloaded app as "damaged". With an ad-hoc signature
// Gatekeeper shows the normal "unidentified developer" prompt (right-click -> Open works).
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
    console.log(`  - ad-hoc signed ${app}`);
  } catch (e) {
    console.warn(`  ! ad-hoc signing failed (${e.message}); the app may show as "damaged" on Apple Silicon`);
  }
};
