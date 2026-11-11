@echo off
chcp 65001 >nul
title Trading Beyni
cd /d "%~dp0"
rem Taşınabilir kullanım: klasörde node\node.exe varsa (USB disk) onu kullan, yoksa bilgisayardaki Node'u.
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"
where node >nul 2>nul || (
  echo Node bulunamadi. trading-beyni\node\node.exe olmali ya da bilgisayarda Node.js kurulu olmali.
  pause
  exit /b 1
)
if not exist ".env" (
  echo .env dosyasi yok. .env.example dosyasini .env olarak kopyalayip token ve API anahtarini yaz.
  pause
  exit /b 1
)
rem Paket hazir derlenmis gelir; npm install gerekmez.
:dongu
echo Trading Beyni baslatiliyor... (kapatmak icin bu pencereyi kapat; bot calisirken USB'yi cikarma)
node --no-warnings dist\local-runner.js
echo Bot durdu, 15 saniye sonra yeniden baslatilacak...
timeout /t 15 /nobreak >nul
goto dongu
