# Screener IC

Screener web local para reducir un universo de acciones líquidas a candidatos de trading **LONG**, **SHORT** y **MONITOR**. Calcula indicadores, aplica filtros, asigna un score de 0 a 100, conserva historial y puede enviar resultados agrupados a Telegram.

El screener **no ejecuta órdenes, no decide inversiones y no usa IA, Claude ni créditos de Anthropic**. Obtiene datos gratuitos de Yahoo Finance y realiza los cálculos localmente con Node.js y JavaScript.

## Funcionamiento

1. Construye un universo con movers/trending de Yahoo y listas locales de S&P 500, Nasdaq 100 y acciones líquidas.
2. Descarga histórico diario, calcula indicadores y aplica vetos de liquidez, precio, volatilidad e historial incompleto.
3. Puntúa tendencia (25), volumen (25), momentum (20), estructura (20) y riesgo/retorno (10).
4. Publica los mejores candidatos y guarda sus resultados para validación posterior.

Indicadores actuales: SMA20/50/200, EMA20, RSI14, MACD, ATR14, Bollinger Bands, volumen promedio 20D, RVOL, rendimientos 5D/20D, compresión y fuerza relativa contra SPY/QQQ.

## Las 9 fases

1. **Adjusted Close:** ajusta OHLC con el `adjclose` de Yahoo para evitar movimientos falsos causados por splits y dividendos.
2. **Deduplicación:** conserva un registro por ticker/bias dentro de cada ventana de 60 minutos; el Win Rate usa solo la primera aparición de cada ticker.
3. **Banda neutral ±2%:** rendimientos entre -2% y +2%, inclusive, se clasifican como neutrales.
4. **Alpha vs SPY:** guarda el rendimiento del candidato, el de SPY y su diferencia para cada validación.
5. **Régimen de mercado:** clasifica el entorno como BULLISH, BEARISH o NEUTRAL usando SPY y QQQ, y guarda el estado semanal de SPY.
6. **Prioridad de score:** ordena primero los candidatos con score 85-90 y los resalta según LONG o SHORT.
7. **CORE/SATELLITE:** usa pertenencia a S&P 500/Nasdaq 100 como proxy; CORE requiere además ATR igual o inferior al 4% del precio.
8. **Penalización EMA20:** resta 5/10/15/20 puntos cuando la distancia absoluta a EMA20 supera 5/10/15/20%.
9. **Win Rate:** resume aciertos por LONG, SHORT y MONITOR para ventanas 5D, 15D y 30D.

## Win Rate

El historial principal se guarda en `data/scan-history.json`.

- LONG acertado: rendimiento del activo mayor a +2%.
- SHORT acertado: rendimiento del activo menor a -2%.
- MONITOR: se evalúa con el bias LONG o SHORT que tenía el candidato.
- Neutral: rendimiento entre -2% y +2%, inclusive; no entra en el denominador.
- Fórmula: `aciertos / (aciertos + fallos)`.
- Deduplicación: si un ticker aparece en varios scans, cuenta una sola vez usando su primera señal histórica.
- Sin observaciones válidas, la interfaz muestra `Sin datos`.

## Scan automático

El scheduler se ejecuta dentro del proceso Node:

| Día | Hora (`America/Denver`) | Etiqueta |
|---|---:|---|
| Lunes a viernes | 7:30 AM | Apertura |
| Lunes a viernes | 1:00 PM | Pre-cierre |

- `America/Denver` aplica automáticamente MST/MDT.
- Envía un mensaje agrupado con todos los LONG, SHORT y MONITOR generados por el scan.
- Consulta el horario cada 30 segundos.
- Ante un fallo, reintenta cada 5 minutos durante un máximo de 30 minutos.
- Los slots completados se guardan en `data/memory.json` para evitar envíos duplicados tras reiniciar.
- El servidor debe permanecer activo; en AWS se recomienda una sola instancia con almacenamiento persistente para `data/`.
- Solo se excluyen fines de semana; no incluye calendario de feriados bursátiles.

### Trigger manual protegido

Ejecuta inmediatamente un scan completo y su envío agrupado, sin consumir los slots automáticos:

```http
POST /api/auto-scan/test
Authorization: Bearer <SCAN_TRIGGER_TOKEN>
```

Ejemplo en PowerShell:

```powershell
$token = "TU_CLAVE_PRIVADA"

Invoke-RestMethod `
  -Method POST `
  -Uri "http://localhost:3100/api/auto-scan/test" `
  -Headers @{ Authorization = "Bearer $token" }
```

## Instalación y arranque

Requiere Node.js y no depende de paquetes npm externos.

```powershell
Copy-Item .env.example .env
npm.cmd start
```

Abre en el navegador:

```text
http://localhost:3100
```

También puede iniciarse con `node server.js`. El puerto predeterminado es `3100`; puede sobrescribirse con la variable de entorno de proceso `PORT`.

Guías adicionales: [Windows](WINDOWS_SETUP.md) y [macOS](MAC_SETUP.md).

## Variables de entorno

`.env` utiliza solamente estos nombres:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
SCAN_TRIGGER_TOKEN=
```

- `TELEGRAM_BOT_TOKEN`: token del bot creado en Telegram.
- `TELEGRAM_CHAT_ID`: chat privado o grupo que recibirá los mensajes.
- `SCAN_TRIGGER_TOKEN`: secreto Bearer que protege el trigger manual.

`PORT` es opcional y se lee del entorno del proceso, no del archivo `.env`.

Para generar un `SCAN_TRIGGER_TOKEN` hexadecimal de 256 bits en PowerShell:

```powershell
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
```

## API local

| Ruta | Método | Uso |
|---|---|---|
| `/api/scan` | GET | Ejecuta el scan manual completo. |
| `/api/auto-scan/test` | POST | Fuerza scan y Telegram con Bearer token. |
| `/api/telegram/send` | POST | Envía candidatos seleccionados desde la interfaz. |
| `/api/history` | GET | Devuelve el historial para la interfaz. |
| `/api/history/summary` | GET | Devuelve la matriz de Win Rate. |
| `/api/watchlist` | POST | Agrega o elimina tickers de la watchlist. |
| `/yahoo` | GET | Proxy local hacia Yahoo Finance. |

## Estructura

```text
screener-ic/
├── server.js                 # Servidor HTTP, API y coordinación de scans
├── screener-ic.html          # Interfaz web responsive
├── config.json               # Filtros, scoring, cache y horarios
├── scanners/                 # Scan, indicadores, filtros, scoring, régimen e historial
├── scheduler/                # Scheduler de scans automáticos
├── telegram/                 # Formato, anti-spam y transporte Telegram
├── utils/                    # HTTP, cache, auth, logs, JSON y horario de mercado
├── universes/                # Listas locales de símbolos
├── data/                     # Memoria, historial y estado local
├── cache/                    # Respuestas temporales de Yahoo
└── logs/                     # Logs rotativos del servidor
```

## Seguridad

- `.env` contiene secretos y **nunca debe subirse a GitHub**; ya está incluido en `.gitignore`.
- No pongas tokens en el HTML, `config.json`, capturas, commits ni mensajes de soporte.
- Usa HTTPS y restringe el acceso al desplegar el trigger manual en AWS.
- `memory.json`, historiales, cache y logs son datos operativos locales.

## Alcance y aviso

No incluye opciones, Level 2, unusual flow, IV, ejecución automática de órdenes ni recomendación financiera. Los candidatos requieren análisis y decisión manual.
