# Screener IC V1

Screener local para detectar candidatos LONG y SHORT usando Yahoo Finance, scoring modular y alertas de Telegram desde backend.

## Uso

1. Copia `.env.example` a `.env` y agrega `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID` si quieres enviar alertas.
2. Ejecuta:

```bash
npm start
```

3. Abre:

```txt
http://localhost:3100
```

## Alcance V1

- Datos gratuitos de Yahoo Finance.
- Indicadores locales: SMA, EMA, RSI, MACD, ATR, Bollinger, RVOL.
- Market regime simple con SPY/QQQ.
- Top LONG/SHORT con score 0-100.
- Memoria ligera y anti-spam Telegram.

No incluye opciones, Level 2, unusual flow, IV ni ejecucion automatica de ordenes.

## Mac

Ver [MAC_SETUP.md](MAC_SETUP.md).

## Windows

Ver [WINDOWS_SETUP.md](WINDOWS_SETUP.md).
