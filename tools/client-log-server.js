import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const HOST = process.env.CLIENT_LOG_HOST || '127.0.0.1';
const PORT = Number(process.env.CLIENT_LOG_PORT || 9044);
const LOG_FILE = process.env.CLIENT_LOG_FILE || '/var/log/wetterradar/client.log';
const MAX_BODY_BYTES = 128 * 1024;
const MAX_RECORDS = 100;
const MAX_STRING = 4000;

await fs.mkdir(path.dirname(LOG_FILE), { recursive: true });

function reply(res, status, body = ''){
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  if (body) res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(body);
}

function cleanString(value, max = MAX_STRING){
  if (value == null) return null;
  return String(value).slice(0, max);
}

function safeData(value, depth = 0){
  if (depth > 3) return '[depth-limit]';
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return cleanString(value);
  if (Array.isArray(value)) return value.slice(0, 20).map(item => safeData(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 30)) {
      if (/token|password|secret|authorization|cookie/i.test(key)) out[cleanString(key, 120)] = '[redacted]';
      else out[cleanString(key, 120)] = safeData(item, depth + 1);
    }
    return out;
  }
  return cleanString(value);
}

function sanitizeRecord(input){
  const allowedLevels = new Set(['debug','info','warn','error']);
  return {
    receivedAt: new Date().toISOString(),
    ts: cleanString(input?.ts, 64),
    level: allowedLevels.has(input?.level) ? input.level : 'info',
    source: cleanString(input?.source, 120),
    event: cleanString(input?.event, 160),
    session: cleanString(input?.session, 120),
    page: cleanString(input?.page, 500),
    data: safeData(input?.data ?? null),
  };
}

async function appendRecords(records){
  if (!records.length) return;
  const lines = records.map(record => JSON.stringify(sanitizeRecord(record))).join('\n') + '\n';
  await fs.appendFile(LOG_FILE, lines, { encoding: 'utf8', mode: 0o640 });
}

function collectBody(req){
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      reply(res, 200, JSON.stringify({ ok: true }));
      return;
    }

    if (req.method !== 'POST' || req.url !== '/client-log') {
      reply(res, 404, JSON.stringify({ error: 'not found' }));
      return;
    }

    const contentType = String(req.headers['content-type'] || '');
    if (!contentType.includes('application/json')) {
      reply(res, 415, JSON.stringify({ error: 'application/json required' }));
      return;
    }

    const raw = await collectBody(req);
    const parsed = JSON.parse(raw || '{}');
    const records = Array.isArray(parsed?.records) ? parsed.records.slice(0, MAX_RECORDS) : [];
    if (!records.length) {
      reply(res, 400, JSON.stringify({ error: 'records required' }));
      return;
    }

    await appendRecords(records);
    reply(res, 204);
  } catch (err) {
    const status = Number(err?.status) || 500;
    process.stderr.write(`[client-log] ${err?.stack || err}\n`);
    if (!res.headersSent) reply(res, status, JSON.stringify({ error: status === 500 ? 'internal error' : cleanString(err.message, 500) }));
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`[client-log] listening on http://${HOST}:${PORT}; file=${LOG_FILE}\n`);
});

function shutdown(){
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
