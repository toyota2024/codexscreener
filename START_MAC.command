#!/bin/bash

set -u

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="3100"
URL="http://localhost:${PORT}"

clear
echo "Infusion Capital Screener IC V1"
echo "--------------------------------"
echo ""

cd "$APP_DIR" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js no esta instalado."
  echo "Instala la version LTS desde: https://nodejs.org"
  echo ""
  read -r -p "Presiona Enter para cerrar..."
  exit 1
fi

if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "El servidor ya parece estar corriendo."
  echo "Abriendo ${URL}..."
  open "$URL"
  echo ""
  echo "Puedes cerrar esta ventana."
  read -r -p "Presiona Enter para cerrar..."
  exit 0
fi

echo "Iniciando servidor local..."
echo "Carpeta: $APP_DIR"
echo "URL: ${URL}"
echo ""

node server.js &
SERVER_PID=$!

for _ in {1..20}; do
  if curl -fsS "$URL" >/dev/null 2>&1; then
    echo "Servidor listo. Abriendo navegador..."
    open "$URL"
    echo ""
    echo "Deja esta ventana abierta mientras uses el screener."
    echo "Para apagarlo, cierra esta ventana o presiona Control + C."
    echo ""
    wait "$SERVER_PID"
    exit $?
  fi
  sleep 0.5
done

echo "No pude confirmar que el servidor arranco correctamente."
echo "Revisa los mensajes de error arriba."
echo ""
read -r -p "Presiona Enter para cerrar..."
