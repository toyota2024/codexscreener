# Uso En Windows

## 1. Instalar Node.js

Descarga e instala la version LTS desde:

```txt
https://nodejs.org
```

Verifica en PowerShell:

```powershell
node -v
npm -v
```

Si PowerShell bloquea `npm`, usa:

```powershell
npm.cmd -v
```

## 2. Descargar el proyecto

```powershell
git clone https://github.com/toyota2024/codexscreener.git
cd codexscreener
```

## 3. Ejecutar la app

Opcion recomendada:

```powershell
node server.js
```

Tambien puedes usar:

```powershell
npm.cmd start
```

Abre en el navegador:

```txt
http://localhost:3100
```

## 4. Telegram Opcional

Solo si quieres enviar alertas a Telegram:

```powershell
copy .env.example .env
```

Edita `.env` y agrega:

```env
TELEGRAM_BOT_TOKEN=tu_token
TELEGRAM_CHAT_ID=tu_chat_id
```

Luego reinicia el servidor:

```powershell
node server.js
```

## Notas

- Si no usas Telegram, no necesitas crear `.env`.
- No abras `screener-ic.html` con doble click; usa siempre el servidor.
- El servidor debe quedarse abierto mientras usas la app.
- Para cerrar el servidor, presiona `Ctrl + C` en PowerShell.
