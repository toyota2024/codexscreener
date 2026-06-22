const crypto = require('crypto');

function authorizeBearer(header, expectedToken) {
  if (!expectedToken || expectedToken === 'CAMBIAR_ESTO') {
    return { ok: false, status: 503, error: 'SCAN_TRIGGER_TOKEN no configurado' };
  }
  const match = String(header || '').match(/^Bearer\s+(.+)$/i);
  if (!match) return { ok: false, status: 401, error: 'Authorization Bearer requerido' };
  const supplied = Buffer.from(match[1]);
  const expected = Buffer.from(String(expectedToken));
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    return { ok: false, status: 403, error: 'Token incorrecto' };
  }
  return { ok: true };
}

module.exports = { authorizeBearer };
