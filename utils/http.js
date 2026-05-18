const https = require('https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36';

function httpsJson(hostname, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path,
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json,text/plain,*/*',
        ...headers
      }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 160)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Invalid JSON response'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('Request timeout'));
    });
    req.end();
  });
}

function httpsPostJson(hostname, path, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let text = '';
      res.on('data', chunk => text += chunk);
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(text); } catch {}
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(data?.description || `HTTP ${res.statusCode}`));
          return;
        }
        resolve(data || { ok: true });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { httpsJson, httpsPostJson };
