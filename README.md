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

## Scan automatico

El servidor ejecuta scans de lunes a viernes a las 7:30 AM y 1:00 PM en la zona `America/Denver`. El proceso Node debe permanecer abierto.

Para habilitar el trigger de prueba, agrega una clave privada a `.env`:

```env
SCAN_TRIGGER_TOKEN=TU_CLAVE_SEGURA
```

Genera una clave hexadecimal de 256 bits en PowerShell:

```powershell
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
```

Reinicia el servidor y fuerza un scan con envio Telegram:

```powershell
$token = "TU_CLAVE_SEGURA"
Invoke-RestMethod -Method POST `
  -Uri "http://localhost:3100/api/auto-scan/test" `
  -Headers @{ Authorization = "Bearer $token" }
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

En Windows tambien puedes abrir la app con doble click en `START_WINDOWS.cmd`.
