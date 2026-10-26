#!/usr/bin/env node
/*
 * Server for the Warehouse Preview Agent — no dependencies.
 *
 *   node server.js            → http://localhost:3000
 *
 * Serves the app and relays the agent's model calls with YOUR key, so the key
 * never reaches the browser. The agent loop and the tools run in the page;
 * this file only forwards model calls and protects the key.
 *
 * Choose a provider with PROVIDER (environment variable or .env file):
 *
 *   PROVIDER=groq        GROQ_API_KEY       free tier, no card   (OpenAI-compatible API)
 *   PROVIDER=gemini      GEMINI_API_KEY     free tier            (OpenAI-compatible API)
 *   PROVIDER=anthropic   ANTHROPIC_API_KEY  Claude               (Messages API)
 *
 * Optional:
 *   MODEL / MODEL_FAST   model names for "Thorough" / "Fast" (defaults per provider below;
 *                        check your provider's console for current names)
 *   PORT                 default 3000
 *   HOST                 default 127.0.0.1; use 0.0.0.0 when hosting publicly
 *   LIMIT_PER_IP         model calls per visitor per 10 minutes (default 40)
 *   LIMIT_PER_DAY        model calls per day for everyone together (default 1500)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

// --- tiny .env loader ---
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const PROVIDERS = {
  anthropic: { label: 'Claude', api: 'anthropic', keyVar: 'ANTHROPIC_API_KEY', base: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', fast: 'claude-haiku-4-5' },
  groq: { label: 'Groq', api: 'openai', keyVar: 'GROQ_API_KEY', base: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', fast: 'openai/gpt-oss-20b' },
  gemini: { label: 'Gemini', api: 'openai', keyVar: 'GEMINI_API_KEY', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash', fast: 'gemini-3.8-flash' },
};

function cfg() {
  const env = process.env;
  // Pick the provider: PROVIDER if set, else whichever key is present.
  let id = (env.PROVIDER || '').toLowerCase();
  if (!PROVIDERS[id]) id = env.GROQ_API_KEY ? 'groq' : env.GEMINI_API_KEY ? 'gemini' : 'anthropic';
  const p = PROVIDERS[id];
  return {
    id, label: p.label, api: p.api,
    key: env[p.keyVar] || '', keyVar: p.keyVar,
    base: (env[id.toUpperCase() + '_BASE_URL'] || p.base).replace(/\/$/, ''),
    model: env.MODEL || env.ANTHROPIC_MODEL || p.model,
    fast: env.MODEL_FAST || env.ANTHROPIC_MODEL_FAST || p.fast,
  };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.csv': 'text/csv', '.png': 'image/png', '.svg': 'image/svg+xml' };
const STATIC = new Set(['/', '/index.html', '/data/site.json', '/data/slots.csv']);
const VENDOR = {
  '/vendor/three.min.js': 'node_modules/three/build/three.min.js',
  '/vendor/OrbitControls.js': 'node_modules/three/examples/js/controls/OrbitControls.js',
};

// --- Key protection for a public link: per-visitor and per-day limits ---
const perIp = new Map(); // ip -> [timestamps]
let day = new Date().toISOString().slice(0, 10), dayCount = 0;
function allow(ip) {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; dayCount = 0; perIp.clear(); }
  const maxIp = Number(process.env.LIMIT_PER_IP) || 40, maxDay = Number(process.env.LIMIT_PER_DAY) || 1500;
  if (dayCount >= maxDay) return 'The demo has reached its AI limit for today. The guided scenarios still work; please try the AI again tomorrow.';
  const list = (perIp.get(ip) || []).filter(t => now - t < 600000);
  if (list.length >= maxIp) return 'You have used the AI a lot in the last few minutes. Wait a few minutes and try again.';
  list.push(now); perIp.set(ip, list); dayCount++;
  if (perIp.size > 5000) perIp.clear();
  return null;
}
const clientIp = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function forward(res, c, url, headers, payload) {
  try {
    const r = await fetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: JSON.stringify(payload) });
    const text = await r.text();
    if (!r.ok) {
      let msg = text;
      try { const j = JSON.parse(text); msg = (Array.isArray(j) ? j[0] : j).error?.message || text; } catch { /* keep text */ }
      return send(res, r.status, { error: `${c.label} API ${r.status}: ${String(msg).slice(0, 400)}` });
    }
    send(res, 200, text);
  } catch (e) {
    send(res, 502, { error: `Could not reach the ${c.label} API: ${e.message}` });
  }
}

async function relay(req, res, shape) {
  const c = cfg();
  if (!c.key) return send(res, 503, { error: `No ${c.keyVar} set. Add it and restart.` });
  if (c.api !== shape) return send(res, 400, { error: `This server uses the ${c.api} format; the page asked for ${shape}.` });
  const blocked = allow(clientIp(req));
  if (blocked) return send(res, 429, { error: blocked });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: e.message }); }
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 60) return send(res, 400, { error: 'messages must be a list of 1 to 60 items' });
  const model = body.tier === 'quick' ? c.fast : c.model;
  const tools = Array.isArray(body.tools) ? body.tools.slice(0, 16) : undefined;
  const maxTokens = Math.min(Number(body.max_tokens) || 1200, 2000);
  if (shape === 'anthropic') {
    return forward(res, c, c.base + '/v1/messages', { 'x-api-key': c.key, 'anthropic-version': '2023-06-01' },
      { model, max_tokens: maxTokens, system: String(body.system || '').slice(0, 200_000), messages: body.messages, tools });
  }
  // OpenAI-compatible chat completions (Groq, Gemini)
  return forward(res, c, c.base + '/chat/completions', { authorization: 'Bearer ' + c.key },
    { model, max_tokens: maxTokens, messages: body.messages, tools, tool_choice: tools ? 'auto' : undefined, temperature: 0.2 });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/health') {
      const c = cfg();
      return send(res, 200, { ok: !!c.key, provider: c.id, label: c.label, api: c.api, model: c.model, fast: c.fast });
    }
    if (url.pathname === '/api/messages' && req.method === 'POST') return relay(req, res, 'anthropic');
    if (url.pathname === '/api/chat' && req.method === 'POST') return relay(req, res, 'openai');
    if (req.method === 'GET' && VENDOR[url.pathname]) {
      return fs.readFile(path.join(__dirname, VENDOR[url.pathname]), (e, d) => e ? send(res, 404, '', 'text/plain') : send(res, 200, d, 'text/javascript'));
    }
    if (req.method === 'GET' && STATIC.has(url.pathname)) {
      const file = url.pathname === '/' ? 'dist/index.html' : url.pathname.slice(1).replace(/^index\.html$/, 'dist/index.html');
      return fs.readFile(path.join(__dirname, file), (e, d) => e
        ? send(res, 404, 'Not built yet. Run: npm run build', 'text/plain')
        : send(res, 200, d, TYPES[path.extname(file)] || 'application/octet-stream'));
    }
    send(res, 404, 'Not found', 'text/plain');
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  createServer().listen(port, host, () => {
    const c = cfg();
    console.log(`Warehouse Preview Agent → http://localhost:${port}`);
    console.log(c.key ? `AI: ${c.label} (Fast = ${c.fast}, Thorough = ${c.model})` : `AI: off (no ${c.keyVar}) — the app runs the guided demo`);
  });
}

module.exports = { createServer, cfg };
