@echo off
setlocal EnableExtensions
title Neo Commander
cd /d "%~dp0"
echo.
echo  ====================================
echo    Neo Commander
echo  ====================================
echo.

where node >nul 2>nul
if errorlevel 1 goto :nonode
node scripts\launcher-check.mjs node
if errorlevel 1 goto :oldnode
goto :havenode

:nonode
echo  [1/4] Node.js bulunamadi. Kurulum deneniyor (birkac dakika surebilir)...
where winget >nul 2>nul
if errorlevel 1 goto :manualnode
winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
if errorlevel 1 goto :manualnode
echo.
echo  Node.js kuruldu. Lutfen bu pencereyi kapatip Neo-Commander.cmd'ye tekrar cift tiklayin.
goto :end

:oldnode
echo  Node.js surumunuz eski (22.12 veya uzeri gerekli). Guncelleme deneniyor...
where winget >nul 2>nul
if errorlevel 1 goto :manualnode
winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
echo.
echo  Guncelleme bitti. Lutfen bu pencereyi kapatip Neo-Commander.cmd'ye tekrar cift tiklayin.
goto :end

:manualnode
echo.
echo  Node.js otomatik kurulamadi. https://nodejs.org adresinden "LTS" surumunu kurun,
echo  sonra Neo-Commander.cmd'ye tekrar cift tiklayin.
goto :end

:havenode
echo  [1/4] Node.js hazir.
set "NEO_STATUS="
for /f "delims=" %%S in ('node scripts\launcher-check.mjs status') do set "NEO_STATUS=%%S"
if "%NEO_STATUS%"=="install" goto :doinstall
echo  [2/4] Bagimliliklar hazir.
goto :checkbuild

:doinstall
echo  [2/4] Gerekli dosyalar kuruluyor (ilk seferde birkac dakika surer)...
call npm ci --ignore-scripts --no-audit --no-fund
if errorlevel 1 goto :fail
call npm rebuild @vscode/ripgrep
if errorlevel 1 goto :fail
node scripts\launcher-check.mjs stamp
set "NEO_STATUS=build"

:checkbuild
if "%NEO_STATUS%"=="ok" goto :run
echo  [3/4] Uygulama derleniyor...
call npm run build
if errorlevel 1 goto :fail
goto :run

:run
echo  [4/4] Baslatiliyor... Tarayicida kontrol paneli acilacak.
echo        (Bu pencereyi kapatirsaniz Neo Commander durur.)
echo.
node dist\index.js
if errorlevel 1 goto :fail
goto :end

:fail
echo.
echo  *** Bir hata olustu. Yukaridaki mesaji okuyun. ***
echo  Sorun surerse mesaji kopyalayip yardim isteyin.

:end
echo.
pause
endlocal
