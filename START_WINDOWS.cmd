@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js no esta instalado o no esta en el PATH.
  echo Descarga Node.js LTS desde https://nodejs.org
  pause
  exit /b 1
)

echo Iniciando Screener IC V1...
echo.
echo Abriendo http://localhost:3100
echo Para cerrar el screener, cierra esta ventana o presiona Ctrl+C.
echo.

start "" "http://localhost:3100"
node server.js

echo.
echo Servidor cerrado.
pause
