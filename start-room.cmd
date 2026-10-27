@echo off
cd /d "%~dp0"
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8787/'"
node "%~dp0bin\a2a-exchange.mjs" serve --port 8787 --data-dir "%~dp0.data"
