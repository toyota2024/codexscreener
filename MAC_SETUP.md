# Uso En Mac

## 1. Instalar Node.js

Descarga e instala la version LTS desde:

```txt
https://nodejs.org
```

Verifica en Terminal:

```bash
node -v
npm -v
```

## 2. Descargar el proyecto

```bash
git clone https://github.com/toyota2024/codexscreener.git
cd codexscreener
```

## 3. Ejecutar la app

```bash
npm start
```

Abre en el navegador:

```txt
http://localhost:3100
```

## 4. Telegram Opcional

Solo si quieres enviar alertas a Telegram:

```bash
cp .env.example .env
```

Edita `.env` y agrega:

```env
TELEGRAM_BOT_TOKEN=tu_token
TELEGRAM_CHAT_ID=tu_chat_id
```

Luego reinicia el servidor:

```bash
npm start
```

## Notas

- Si no usas Telegram, no necesitas crear `.env`.
- No abras `screener-ic.html` con doble click; usa siempre `npm start`.
- El servidor debe quedarse abierto mientras usas la app.
