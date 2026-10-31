// SPDX-License-Identifier: AGPL-3.0-only
// Inheriq: open-source AI employees with human approval. No dependencies. Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const BUILTIN = require('./agents');
const actions = require('./actions');

const ROOT = __dirname;
const DATA = process.env.INHERIQ_DATA || path.join(ROOT, 'data');
const HOST = process.env.HOST || '127.0.0.1';
fs.mkdirSync(DATA, { recursive: true });

const MEMORY0 = [
  'Company: Acme Dynamics (B2B software). Tone: warm, concise, plain English.',
  'Plans: Starter $59/month, Growth $179/month, Enterprise custom. Annual plans save 15%.',
  'Refunds: up to $50 are approved automatically. Above $50 needs the support manager. Returns accepted within 30 days.',
  "Invoices above $2,000 need the finance lead's sign-off. Payment terms: net 30.",
  "Sales: deals above $15k need the sales lead's OK. The AI never offers discounts beyond 15%.",
  "Hours: Mon to Fri, 9 AM to 6 PM. Reply in the customer's language."
].join('\n');

/* ---------- storage ---------- */
function readJSON(name, fallback) { try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); } catch (e) { return fallback; } }
function writeJSON(name, obj) { fs.writeFileSync(path.join(DATA, name), JSON.stringify(obj, null, 2), { mode: 0o600 }); }
const uid = function () { return crypto.randomBytes(5).toString('hex'); };

var settings = Object.assign({ providers: [], integrations: [], routes: {}, defaultRoute: '', autoSend: false, apiToken: '', memory: MEMORY0 }, readJSON('settings.json', {}));
var custom = readJSON('agents.custom.json', []);
var tasks = readJSON('tasks.json', []);
var cache = readJSON('cache.json', {});
const saveSettings = function () { writeJSON('settings.json', settings); };
const saveTasks = function () { tasks = tasks.slice(0, 300); writeJSON('tasks.json', tasks); };
const saveCache = function () { var k = Object.keys(cache); if (k.length > 400) k.slice(0, k.length - 400).forEach(function (x) { delete cache[x]; }); writeJSON('cache.json', cache); };

// First run: pick up a key from the environment or a .env file so a plain `GROQ_API_KEY=... node server.js` works.
(function bootstrapEnv() {
  try {
    fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').forEach(function (l) {
      var m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    });
  } catch (e) {}
  if (process.env.GROQ_API_KEY && !settings.providers.some(function (p) { return p.key === process.env.GROQ_API_KEY; })) {
    settings.providers.push({ id: uid(), name: 'Groq', base: 'https://api.groq.com/openai/v1', model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile', key: process.env.GROQ_API_KEY });
  }
  if (process.env.LLM_BASE_URL && process.env.LLM_MODEL && !settings.providers.some(function (p) { return p.base === process.env.LLM_BASE_URL; })) {
    settings.providers.push({ id: uid(), name: 'Custom', base: process.env.LLM_BASE_URL, model: process.env.LLM_MODEL, key: process.env.LLM_API_KEY || '' });
  }
  saveSettings();
})();
const apiToken = function () { return process.env.INHERIQ_API_TOKEN || settings.apiToken || ''; };

/* ---------- agents ---------- */
const PALETTE = ['#FFC629', '#FF9F43', '#5AB8FF', '#C9A7FF', '#7BDFB2', '#FFB5A7', '#F6A6FF', '#B8E64B'];
const allAgents = function () { return BUILTIN.concat(custom.map(function (a) { return Object.assign({ group: 'Your agents', on: '#17123A', custom: true }, a); })); };
const findAgent = function (id) { return allAgents().find(function (a) { return a.id === id; }); };
const publicAgent = function (a) { return { id: a.id, name: a.name, role: a.role, group: a.group, color: a.color, on: a.on, tagline: a.tagline, rule: a.rule, sample: a.sample, custom: !!a.custom, force: !!a.force }; };

/* ---------- model calls ---------- */
const PREAMBLE = [
  'You are an AI employee at the company described under "Company memory". Follow its policies and tone exactly.',
  'Use only facts from the memory and the input. If something is missing, write Unknown instead of inventing it.',
  'Write in the language of the person you are replying to. Be concise and plain.',
  'Return ONLY a JSON object, no markdown, with exactly this shape:',
  '{"headline": "one-line outcome", "facts": [{"label": "...", "value": "..."}], "steps": ["what you did or recommend"], "draft": null or {"channel": "...", "to": "...", "subject": "..." or null, "body": "..."}, "needs_approval": true or false, "approval_reason": "why a person must approve, or why it is safe to send alone"}',
  'facts: 3 to 6 items. steps: 2 to 5 items. Set needs_approval to true whenever your role instructions say a person must approve.'
].join('\n');

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

async function callProvider(p, messages, maxTokens) {
  var body = { model: p.model, messages: messages, temperature: 0.3, max_tokens: maxTokens || 900, response_format: { type: 'json_object' } };
  var headers = { 'Content-Type': 'application/json' };
  if (p.key) headers.Authorization = 'Bearer ' + p.key;
  for (var attempt = 0; attempt < 3; attempt++) {
    var res = await fetch(p.base.replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers: headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
    if (res.status === 429 && attempt < 2) { await sleep(Math.min(+(res.headers.get('retry-after') || 3), 8) * 1000); continue; }
    var t = await res.text();
    if (!res.ok) {
      if ((res.status === 400 || res.status === 422) && /response_format|json_object|json_schema/i.test(t) && body.response_format) { delete body.response_format; continue; }
      var msg = t; try { msg = JSON.parse(t).error.message || t; } catch (e) {}
      var err = new Error(String(msg).slice(0, 300)); err.status = res.status; throw err;
    }
    var data = JSON.parse(t);
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  }
  throw new Error('Rate limited. Wait a few seconds and run again.');
}

function parseJSON(text) {
  try { return JSON.parse(text); } catch (e) {}
  var a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a > -1 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch (e) {} }
  throw new Error('The model did not return valid JSON. Run it again or try a larger model.');
}
function normalize(o, agent) {
  var facts = o.facts;
  if (facts && !Array.isArray(facts) && typeof facts === 'object') facts = Object.keys(facts).map(function (k) { return { label: k, value: facts[k] }; });
  facts = (Array.isArray(facts) ? facts : []).slice(0, 8).map(function (f) { return { label: String(f && f.label || ''), value: String(f && f.value != null ? f.value : '') }; });
  var steps = (Array.isArray(o.steps) ? o.steps : []).slice(0, 8).map(String);
  var d = o.draft && typeof o.draft === 'object' ? o.draft : null;
  if (d) d = { channel: String(d.channel || 'Message'), to: String(d.to || ''), subject: d.subject ? String(d.subject) : '', body: String(d.body || '') };
  if (d && !d.body) d = null;
  return { headline: String(o.headline || agent.name + ' finished'), facts: facts, steps: steps, draft: d,
    needs_approval: !!o.needs_approval || !!agent.force, approval_reason: String(o.approval_reason || (agent.force ? agent.rule : '')) };
}

async function runAgent(agent, memory, input) {
  var key = crypto.createHash('sha1').update(agent.id + '\n' + agent.prompt + '\n' + memory + '\n' + input).digest('hex'), last = null;
  var messages = [{ role: 'system', content: PREAMBLE + '\n\n' + agent.prompt }, { role: 'user', content: 'Company memory:\n' + memory + '\n\nInput:\n' + input }];
  for (var i = 0; i < settings.providers.length; i++) {
    var p = settings.providers[i], t0 = Date.now();
    try {
      var out = normalize(parseJSON(await callProvider(p, messages)), agent);
      var r = { data: out, ms: Date.now() - t0, model: p.model, provider: p.name, cached: false };
      cache[key] = { data: out, ms: r.ms, model: p.model, provider: p.name, at: new Date().toISOString() }; saveCache();
      return { ok: true, result: r };
    } catch (e) { last = e; }
  }
  if (cache[key]) { var c = cache[key]; return { ok: true, result: { data: c.data, ms: c.ms, model: c.model, provider: c.provider, cached: true, cachedAt: c.at } }; }
  var hint = !settings.providers.length ? 'No model connected yet. Add one under Connections.' :
    last && last.status === 401 ? 'The API key was rejected. Check it under Connections.' :
    last && (last.status === 404 || /model/i.test(last.message || '')) ? 'The model name was not accepted. Fix it under Connections.' :
    last && /fetch failed|timeout|abort|ECONN/i.test(last.message || '') ? 'Could not reach the model. Check the network or the base URL.' : '';
  return { ok: false, error: last ? last.message : 'No model connected.', hint: hint };
}

/* ---------- tasks ---------- */
function addEvent(task, who, textLine) { task.events.push({ t: new Date().toISOString(), who: who, text: textLine }); }
const routeFor = function (agent) {
  var id = settings.routes[agent.id] || settings.defaultRoute;
  if (!id || id === 'none') return null;
  return settings.integrations.find(function (i) { return i.id === id; }) || null;
};
async function deliver(task, approvedBy) {
  var agent = findAgent(task.agent) || { id: task.agent, name: task.agentName, role: task.agentRole };
  var d = task.result.data, integration = routeFor(agent);
  if (!integration) { task.action = { ok: true, via: 'none', detail: 'No destination is connected for this agent, so nothing was sent.' }; return; }
  task.action = await actions.dispatch(integration, { agent: { id: agent.id, name: agent.name, role: agent.role }, draft: d.draft, headline: d.headline, facts: d.facts, taskId: task.id, replyTo: task.replyTo, approvedBy: approvedBy, at: new Date().toISOString() });
}
async function createTask(agent, input, source, replyTo) {
  var r = await runAgent(agent, settings.memory, input);
  var task = { id: uid(), agent: agent.id, agentName: agent.name, agentRole: agent.role, color: agent.color, source: source, input: input.slice(0, 2000), replyTo: replyTo || '', at: new Date().toISOString(), events: [], status: 'error', result: null, action: null };
  if (!r.ok) { task.error = { error: r.error, hint: r.hint }; addEvent(task, 'system', 'Run failed: ' + r.error); }
  else {
    task.result = r.result; var d = r.result.data;
    addEvent(task, 'agent', agent.name + ' ran' + (r.result.cached ? ' (cached result)' : '') + ': ' + d.headline);
    if (!d.draft) task.status = 'info';
    else if (!d.needs_approval && settings.autoSend) {
      await deliver(task, 'auto'); task.status = 'auto';
      addEvent(task, 'system', 'Sent automatically, inside the rules. ' + task.action.detail);
    } else { task.status = 'pending'; addEvent(task, 'agent', d.needs_approval ? 'Waiting for your approval.' : 'Ready to send. Inside the rules.'); }
  }
  tasks.unshift(task); saveTasks();
  return task;
}

/* ---------- http ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
function readBody(req) {
  return new Promise(function (resolve, reject) {
    var s = '';
    req.on('data', function (c) { s += c; if (s.length > 100000) { reject(new Error('Request too large')); req.destroy(); } });
    req.on('end', function () { try { resolve(JSON.parse(s || '{}')); } catch (e) { reject(new Error('Bad JSON')); } });
  });
}
const send = function (res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const maskUrl = function (u) { try { return new URL(u).origin + '/…' + String(u).slice(-4); } catch (e) { return '…'; } };
const publicSettings = function () {
  return {
    providers: settings.providers.map(function (p) { return { id: p.id, name: p.name, base: p.base, model: p.model, hasKey: !!p.key }; }),
    integrations: settings.integrations.map(function (i) { return { id: i.id, name: i.name, type: i.type, target: i.type === 'telegram' ? 'chat ' + i.chatId : maskUrl(i.url) }; }),
    types: Object.keys(actions.TYPES).map(function (k) { return { id: k, label: actions.TYPES[k].label, fields: actions.TYPES[k].fields }; }),
    routes: settings.routes, defaultRoute: settings.defaultRoute, autoSend: settings.autoSend, memory: settings.memory,
    api: { enabled: !!apiToken(), fromEnv: !!process.env.INHERIQ_API_TOKEN }
  };
};
const safeEq = function (a, b) { var x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const isLocal = function (req) { return LOOPBACK.indexOf(req.socket.remoteAddress) > -1 && ['localhost', '127.0.0.1', '[::1]'].indexOf((req.headers.host || '').replace(/:\d+$/, '')) > -1; };
const slug = function (s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'agent'; };
const clip = function (s, n) { return String(s == null ? '' : s).slice(0, n).trim(); };

async function handle(req, res) {
  var url = req.url.split('?')[0], m;

  /* Public API: token protected, works from any address so n8n, Zapier or a form can call it. */
  if ((m = url.match(/^\/api\/inbound\/([a-z0-9-]+)$/)) && req.method === 'POST') {
    var tok = apiToken();
    if (!tok) return send(res, 403, { error: 'The inbound API is off. Set INHERIQ_API_TOKEN or generate a token under Connections.' });
    if (!safeEq((req.headers.authorization || '').replace(/^Bearer\s+/i, ''), tok)) return send(res, 401, { error: 'Bad or missing bearer token.' });
    var ia = findAgent(m[1]); if (!ia) return send(res, 404, { error: 'Unknown agent.' });
    var ib = await readBody(req), iin = clip(ib.input, 6000);
    if (!iin) return send(res, 400, { error: 'Send {"input": "..."}' });
    return send(res, 200, await createTask(ia, iin, 'api', clip(ib.replyTo, 200)));
  }
  if ((m = url.match(/^\/api\/inbound\/tasks\/([a-f0-9]+)$/)) && req.method === 'GET') {
    if (!apiToken() || !safeEq((req.headers.authorization || '').replace(/^Bearer\s+/i, ''), apiToken())) return send(res, 401, { error: 'Bad or missing bearer token.' });
    var it = tasks.find(function (t) { return t.id === m[1]; }); return it ? send(res, 200, it) : send(res, 404, { error: 'No such task.' });
  }

  /* Everything below is the local console. */
  if (!isLocal(req)) { res.writeHead(403); return res.end('The console is local only. Use /api/inbound/* from other machines.'); }
  if (req.method === 'POST' && req.headers['x-inheriq'] !== '1') return send(res, 403, { error: 'Forbidden' });

  if (req.method === 'GET' && url === '/api/agents') return send(res, 200, allAgents().map(publicAgent));
  if (req.method === 'GET' && url === '/api/settings') return send(res, 200, publicSettings());
  if (req.method === 'GET' && url === '/api/tasks') return send(res, 200, tasks.slice(0, 100));

  if (req.method === 'POST') {
    var b = await readBody(req);
    if (url === '/api/run') {
      var agent = findAgent(b.agent); if (!agent) return send(res, 400, { error: 'Unknown agent' });
      var input = clip(b.input, 6000); if (!input) return send(res, 400, { error: 'Add some input first.' });
      if (typeof b.memory === 'string' && b.memory !== settings.memory) { settings.memory = b.memory.slice(0, 6000); saveSettings(); }
      return send(res, 200, await createTask(agent, input, 'ui', ''));
    }
    if ((m = url.match(/^\/api\/tasks\/([a-f0-9]+)\/(decision|retry)$/))) {
      var task = tasks.find(function (t) { return t.id === m[1]; }); if (!task) return send(res, 404, { error: 'No such task.' });
      if (m[2] === 'retry') {
        if (!task.action || task.action.ok) return send(res, 409, { error: 'Nothing to retry.' });
        await deliver(task, 'human'); addEvent(task, 'system', 'Retried. ' + task.action.detail); saveTasks(); return send(res, 200, task);
      }
      if (task.status !== 'pending') return send(res, 409, { error: 'This task was already decided.' });
      if (b.decision === 'reject') { task.status = 'rejected'; addEvent(task, 'you', 'You rejected the draft. Nothing was sent.'); }
      else if (b.decision === 'approve') {
        if (typeof b.body === 'string' && b.body.trim() && b.body !== task.result.data.draft.body) { task.result.data.draft.body = b.body.slice(0, 8000); task.edited = true; }
        await deliver(task, 'human'); task.status = 'approved';
        addEvent(task, 'you', 'You approved the draft' + (task.edited ? ' with edits' : '') + '. ' + task.action.detail);
      } else return send(res, 400, { error: 'decision must be approve or reject' });
      saveTasks(); return send(res, 200, task);
    }
    if (url === '/api/memory') { settings.memory = clip(b.memory, 6000); saveSettings(); return send(res, 200, { ok: true }); }
    if (url === '/api/providers') {
      var base = clip(b.base, 300), model = clip(b.model, 120);
      try { var pu = new URL(base); if (pu.protocol !== 'https:' && pu.protocol !== 'http:') throw 0; } catch (e) { return send(res, 400, { error: 'Enter a valid base URL, for example https://api.groq.com/openai/v1' }); }
      if (!model) return send(res, 400, { error: 'Enter a model name.' });
      settings.providers.push({ id: uid(), name: clip(b.name, 40) || pu.hostname, base: base, model: model, key: clip(b.key, 400) }); saveSettings(); return send(res, 200, publicSettings());
    }
    if (url === '/api/providers/delete') { settings.providers = settings.providers.filter(function (p) { return p.id !== b.id; }); saveSettings(); return send(res, 200, publicSettings()); }
    if (url === '/api/providers/primary') {
      var pi = settings.providers.findIndex(function (p) { return p.id === b.id; });
      if (pi > 0) { settings.providers.unshift(settings.providers.splice(pi, 1)[0]); saveSettings(); } return send(res, 200, publicSettings());
    }
    if (url === '/api/providers/test') {
      var tp = settings.providers.find(function (p) { return p.id === b.id; }); if (!tp) return send(res, 404, { error: 'No such provider.' });
      var t0 = Date.now();
      try { await callProvider(tp, [{ role: 'user', content: 'Reply with the JSON {"ok": true}' }], 20); return send(res, 200, { ok: true, ms: Date.now() - t0 }); }
      catch (e) { return send(res, 200, { ok: false, error: e.message, status: e.status || 0 }); }
    }
    if (url === '/api/integrations') {
      var it2 = { id: uid(), name: clip(b.name, 40) || 'Destination', type: b.type, url: clip(b.url, 600), token: clip(b.token, 400), chatId: clip(b.chatId, 80) };
      var why = actions.validate(it2); if (why) return send(res, 400, { error: why });
      settings.integrations.push(it2); saveSettings(); return send(res, 200, publicSettings());
    }
    if (url === '/api/integrations/delete') {
      settings.integrations = settings.integrations.filter(function (i) { return i.id !== b.id; });
      Object.keys(settings.routes).forEach(function (k) { if (settings.routes[k] === b.id) delete settings.routes[k]; });
      if (settings.defaultRoute === b.id) settings.defaultRoute = ''; saveSettings(); return send(res, 200, publicSettings());
    }
    if (url === '/api/integrations/test') {
      var ti = settings.integrations.find(function (i) { return i.id === b.id; }); if (!ti) return send(res, 404, { error: 'No such destination.' });
      return send(res, 200, await actions.dispatch(ti, { agent: { id: 'test', name: 'Inheriq', role: 'Connection test' }, draft: { channel: 'Test', to: '', subject: '', body: 'This is a test message from Inheriq. Your destination works.' }, headline: 'Connection test', facts: [], taskId: 'test', replyTo: '', approvedBy: 'test', at: new Date().toISOString() }));
    }
    if (url === '/api/routing') {
      if (b.routes && typeof b.routes === 'object') settings.routes = b.routes;
      if (typeof b.defaultRoute === 'string') settings.defaultRoute = b.defaultRoute;
      if (typeof b.autoSend === 'boolean') settings.autoSend = b.autoSend;
      saveSettings(); return send(res, 200, publicSettings());
    }
    if (url === '/api/token') { settings.apiToken = crypto.randomBytes(24).toString('hex'); saveSettings(); return send(res, 200, { token: settings.apiToken }); }
    if (url === '/api/agents/custom') {
      var name = clip(b.name, 30), prompt = clip(b.prompt, 4000);
      if (!name || !prompt) return send(res, 400, { error: 'An agent needs a name and instructions.' });
      var id = slug(name); while (findAgent(id)) id += '-' + uid().slice(0, 2);
      var na = { id: id, name: name, role: clip(b.role, 40) || 'Custom AI', tagline: clip(b.tagline, 120) || 'Your own agent', rule: clip(b.rule, 200) || 'Set your own approval rule in the instructions',
        force: !!b.force, prompt: prompt, sample: clip(b.sample, 2000) || 'Paste some input for this agent here.', color: PALETTE[custom.length % PALETTE.length] };
      custom.push(na); writeJSON('agents.custom.json', custom); return send(res, 200, publicAgent(Object.assign({ group: 'Your agents', on: '#17123A', custom: true }, na)));
    }
    if (url === '/api/agents/custom/delete') { custom = custom.filter(function (a) { return a.id !== b.id; }); writeJSON('agents.custom.json', custom); return send(res, 200, { ok: true }); }
    return send(res, 404, { error: 'Not found' });
  }

  if (req.method === 'GET') {
    var file = path.normalize(path.join(ROOT, 'public', url === '/' ? 'index.html' : url));
    if (file.indexOf(path.join(ROOT, 'public')) !== 0) { res.writeHead(403); return res.end(); }
    return fs.readFile(file, function (err, buf) {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(buf);
    });
  }
  res.writeHead(404); res.end();
}

const server = http.createServer(function (req, res) { handle(req, res).catch(function (e) { if (!res.headersSent) send(res, 500, { error: e.message }); else res.end(); }); });
module.exports = { server };
if (require.main === module) {
  const PORT = +process.env.PORT || 3000;
  server.listen(PORT, HOST, function () {
    console.log('Inheriq running at http://localhost:' + PORT + (HOST !== '127.0.0.1' ? '  (listening on ' + HOST + ')' : ''));
    console.log(settings.providers.length ? 'Model: ' + settings.providers.map(function (p) { return p.name + ' ' + p.model; }).join(', ') : 'No model yet. Open the page and add one under Connections.');
    console.log(allAgents().length + ' agents loaded. Inbound API ' + (apiToken() ? 'on' : 'off') + '.');
  });
}
