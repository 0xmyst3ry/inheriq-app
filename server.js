// Inheriq agent engine. No dependencies. Run: node server.js
// Keys live in .env or are saved from the UI. They never reach the browser.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const AGENTS = require('./agents');
const ROOT = __dirname, ENV_FILE = path.join(ROOT, '.env'), CACHE_FILE = path.join(ROOT, 'cache.json');
const PORT = +process.env.PORT || 3000;

function loadEnv() {
  try {
    fs.readFileSync(ENV_FILE, 'utf8').split('\n').forEach(function (l) {
      var m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    });
  } catch (e) {}
}
function saveEnv(map) {
  var lines = [];
  try { lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n').filter(Boolean); } catch (e) {}
  Object.keys(map).forEach(function (k) {
    var line = k + '=' + map[k], i = lines.findIndex(function (l) { return l.indexOf(k + '=') === 0; });
    if (i > -1) lines[i] = line; else lines.push(line);
    process.env[k] = map[k];
  });
  fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n', { mode: 0o600 });
}
function providers() {
  loadEnv();
  var list = [];
  if (process.env.GROQ_API_KEY) list.push({ name: 'Groq', base: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1', key: process.env.GROQ_API_KEY, model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile' });
  if (process.env.ALT_API_KEY && process.env.ALT_BASE_URL && process.env.ALT_MODEL) list.push({ name: 'Backup', base: process.env.ALT_BASE_URL, key: process.env.ALT_API_KEY, model: process.env.ALT_MODEL });
  return list;
}

var cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (e) {}
var cacheKey = function (a, mem, input) { return crypto.createHash('sha1').update(a + '\n' + mem + '\n' + input).digest('hex'); };
function saveCache() { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch (e) {} }

const PREAMBLE = [
  'You are an AI employee at the company described under "Company memory". Follow its policies and tone exactly.',
  'Use only facts from the memory and the input. If something is missing, write Unknown instead of inventing it.',
  'Write in the language of the person you are replying to. Be concise and plain.',
  'Return ONLY a JSON object, no markdown, with exactly this shape:',
  '{"headline": "one-line outcome", "facts": [{"label": "...", "value": "..."}], "steps": ["what you did or recommend"], "draft": null or {"channel": "...", "to": "...", "subject": "..." or null, "body": "..."}, "needs_approval": true or false, "approval_reason": "why a person must approve, or why it is safe to send alone"}',
  'facts: 3 to 6 items. steps: 2 to 5 items. Set needs_approval to true whenever your role instructions say a person must approve.'
].join('\n');

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function callProvider(p, messages) {
  var body = { model: p.model, messages: messages, temperature: 0.3, max_tokens: 900, response_format: { type: 'json_object' } };
  for (var attempt = 0; attempt < 3; attempt++) {
    var res = await fetch(p.base.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + p.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000)
    });
    if (res.status === 429 && attempt < 2) {
      var wait = Math.min(+(res.headers.get('retry-after') || 3), 8) * 1000; await sleep(wait); continue;
    }
    var text = await res.text();
    if (!res.ok) {
      if (res.status === 400 && /response_format|json_object/i.test(text) && body.response_format) { delete body.response_format; continue; }
      var msg = text; try { msg = JSON.parse(text).error.message || text; } catch (e) {}
      var err = new Error(msg); err.status = res.status; throw err;
    }
    var data = JSON.parse(text);
    return data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';
  }
  throw new Error('Rate limited. Wait a few seconds and run again.');
}

function parseJSON(text) {
  try { return JSON.parse(text); } catch (e) {}
  var a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a > -1 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch (e) {} }
  throw new Error('The model did not return valid JSON. Run it again.');
}
function normalize(o, agent) {
  var facts = o.facts;
  if (facts && !Array.isArray(facts) && typeof facts === 'object') facts = Object.keys(facts).map(function (k) { return { label: k, value: facts[k] }; });
  facts = (Array.isArray(facts) ? facts : []).slice(0, 8).map(function (f) { return { label: String(f && f.label || ''), value: String(f && f.value != null ? f.value : '') }; });
  var steps = (Array.isArray(o.steps) ? o.steps : []).slice(0, 8).map(String);
  var d = o.draft && typeof o.draft === 'object' ? o.draft : null;
  if (d) d = { channel: String(d.channel || 'Message'), to: String(d.to || ''), subject: d.subject ? String(d.subject) : '', body: String(d.body || '') };
  if (d && !d.body) d = null;
  var needs = !!o.needs_approval || agent.force;
  return { headline: String(o.headline || agent.name + ' finished'), facts: facts, steps: steps, draft: d, needs_approval: needs,
    approval_reason: String(o.approval_reason || (agent.force ? agent.rule : '')) };
}

async function runAgent(agent, memory, input) {
  var provs = providers(), key = cacheKey(agent.id, memory, input), last = null;
  var messages = [
    { role: 'system', content: PREAMBLE + '\n\n' + agent.prompt },
    { role: 'user', content: 'Company memory:\n' + memory + '\n\nInput:\n' + input }
  ];
  for (var i = 0; i < provs.length; i++) {
    var p = provs[i], t0 = Date.now();
    try {
      var raw = await callProvider(p, messages);
      var out = normalize(parseJSON(raw), agent);
      var result = { ok: true, data: out, ms: Date.now() - t0, model: p.model, provider: p.name, cached: false };
      cache[key] = { data: out, ms: result.ms, model: p.model, provider: p.name, at: new Date().toISOString() }; saveCache();
      return result;
    } catch (e) { last = e; }
  }
  if (cache[key]) { var c = cache[key]; return { ok: true, data: c.data, ms: c.ms, model: c.model, provider: c.provider, cached: true, cachedAt: c.at }; }
  var hint = !provs.length ? 'No model key yet. Add your Groq key at the top of the page.' :
    last && last.status === 401 ? 'The API key was rejected. Check it and save it again.' :
    last && (last.status === 404 || /model/i.test(last.message || '')) ? 'The model name was not accepted. Change the model name in the connection panel.' :
    last && /fetch failed|timeout|abort/i.test(last.message || '') ? 'Could not reach the model. Check the Wi-Fi.' : '';
  return { ok: false, error: (last ? last.message : 'No model configured.'), hint: hint };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
function readBody(req) {
  return new Promise(function (resolve, reject) {
    var s = '';
    req.on('data', function (c) { s += c; if (s.length > 80000) { reject(new Error('Too large')); req.destroy(); } });
    req.on('end', function () { try { resolve(JSON.parse(s || '{}')); } catch (e) { reject(new Error('Bad JSON')); } });
  });
}
function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

http.createServer(async function (req, res) {
  var host = (req.headers.host || '').split(':')[0];
  if (host !== 'localhost' && host !== '127.0.0.1') { res.writeHead(403); return res.end('Local only'); }
  var url = req.url.split('?')[0];
  try {
    if (req.method === 'GET' && url === '/api/agents') {
      return send(res, 200, AGENTS.map(function (a) { return { id: a.id, name: a.name, role: a.role, group: a.group, color: a.color, on: a.on, tagline: a.tagline, rule: a.rule, sample: a.sample }; }));
    }
    if (req.method === 'GET' && url === '/api/health') {
      var ps = providers();
      return send(res, 200, { ready: ps.length > 0, providers: ps.map(function (p) { return { name: p.name, model: p.model }; }), model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile' });
    }
    if (req.method === 'POST' && req.headers['x-inheriq'] !== '1') return send(res, 403, { error: 'Forbidden' });
    if (req.method === 'POST' && url === '/api/provider') {
      var b = await readBody(req), upd = {};
      if (b.slot === 'groq') { if (b.key) upd.GROQ_API_KEY = String(b.key).trim(); if (b.model) upd.GROQ_MODEL = String(b.model).trim(); }
      else if (b.slot === 'alt') { if (b.key) upd.ALT_API_KEY = String(b.key).trim(); if (b.base) upd.ALT_BASE_URL = String(b.base).trim(); if (b.model) upd.ALT_MODEL = String(b.model).trim(); }
      else return send(res, 400, { error: 'Unknown slot' });
      saveEnv(upd); return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url === '/api/run') {
      var r = await readBody(req), agent = AGENTS.find(function (a) { return a.id === r.agent; });
      if (!agent) return send(res, 400, { error: 'Unknown agent' });
      var input = String(r.input || '').slice(0, 6000).trim(), memory = String(r.memory || '').slice(0, 4000);
      if (!input) return send(res, 400, { error: 'Add some input first.' });
      return send(res, 200, await runAgent(agent, memory, input));
    }
    if (req.method === 'GET') {
      var file = path.normalize(path.join(ROOT, 'public', url === '/' ? 'index.html' : url));
      if (file.indexOf(path.join(ROOT, 'public')) !== 0) { res.writeHead(403); return res.end(); }
      fs.readFile(file, function (err, buf) {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(buf);
      });
      return;
    }
    res.writeHead(404); res.end();
  } catch (e) { send(res, 500, { error: e.message }); }
}).listen(PORT, '127.0.0.1', function () {
  var ps = providers();
  console.log('Inheriq running at http://localhost:' + PORT);
  console.log(ps.length ? 'Model: ' + ps.map(function (p) { return p.name + ' ' + p.model; }).join(', ') : 'No model key yet. Paste your Groq key in the page.');
  console.log(AGENTS.length + ' agents loaded.');
});
