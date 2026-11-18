#!/usr/bin/env bash
# Neo Commander launcher for macOS / Linux
set -u
cd "$(dirname "$0")"
printf '\n  ====================================\n    Neo Commander\n  ====================================\n\n'

pause_exit() { echo; read -r -p "  Kapatmak için Enter'a basın…" _ || true; exit "${1:-0}"; }

if ! command -v node >/dev/null 2>&1 || ! node scripts/launcher-check.mjs node; then
  echo "  Node.js 22.12 veya üzeri gerekli."
  if command -v brew >/dev/null 2>&1; then echo "  Kurmak için: brew install node@22";
  else echo "  https://nodejs.org adresinden LTS sürümünü kurun."; fi
  pause_exit 1
fi
echo "  [1/4] Node.js hazır."

STATUS="$(node scripts/launcher-check.mjs status)"
if [ "$STATUS" = "install" ]; then
  echo "  [2/4] Gerekli dosyalar kuruluyor (ilk seferde birkaç dakika sürer)…"
  npm ci --ignore-scripts --no-audit --no-fund && npm rebuild @vscode/ripgrep && node scripts/launcher-check.mjs stamp || { echo "  *** Kurulum hatası ***"; pause_exit 1; }
  STATUS=build
else
  echo "  [2/4] Bağımlılıklar hazır."
fi

if [ "$STATUS" != "ok" ]; then
  echo "  [3/4] Uygulama derleniyor…"
  npm run build || { echo "  *** Derleme hatası ***"; pause_exit 1; }
fi

echo "  [4/4] Başlatılıyor… Tarayıcıda kontrol paneli açılacak."
echo "        (Bu pencereyi kapatırsanız Neo Commander durur.)"
echo
node dist/index.js || { echo "  *** Bir hata oluştu ***"; pause_exit 1; }
