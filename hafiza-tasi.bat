@echo off
chcp 65001 >nul
title Trading Beyni - hafizayi GitHub'a tasi
cd /d "%~dp0"
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"
where node >nul 2>nul || (echo Node bulunamadi. & pause & exit /b 1)
if not exist trading-beyni.db (echo trading-beyni.db bulunamadi. & pause & exit /b 1)
if not exist durum-sifresi.txt node --no-warnings scripts\durum.js sifre-uret > durum-sifresi.txt
set /p DURUM_SIFRESI=<durum-sifresi.txt
node --no-warnings scripts\durum.js sifrele trading-beyni.db ilk-hafiza.enc || (echo Basarisiz. & pause & exit /b 1)
echo.
echo Tamam. Iki sey olustu:
echo   1) ilk-hafiza.enc     : sifreli hafiza, GitHub deposuna yuklenecek
echo   2) durum-sifresi.txt  : GitHub'da DURUM_SIFRESI adli secret'a yazilacak sifre
echo Sifreyi kimseyle paylasma, sohbete yazma.
echo.
notepad durum-sifresi.txt
