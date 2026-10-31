// SPDX-License-Identifier: AGPL-3.0-only
// Run with: npm test   (Node 18 or newer, no dependencies)
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.INHERIQ_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'inheriq-test-'));
process.env.INHERIQ_API_TOKEN = 'test-token';
process.env.GROQ_API_KEY = '';
process.env.LLM_BASE_URL = '';
const { server } = require('../server');

/* A fake OpenAI-compatible model and a fake destination, so tests never touch the network. */
function listen(handler) {
  return new Promise(function (resolve) {
    var s = http.createServer(handler); s.listen(0, '127.0.0.1', function () { resolve({ s: s, url: 'http://127.0.0.1:' + s.address().port }); });
  });
}
const modelReply = { headline: 'Handled it', facts: [{ label: 'Check', value: 'ok' }], steps: ['one', 'two'], draft: { channel: 'Email', to: 'Sam', subject: 'Hi', body: 'Hello Sam' }, needs_approval: true, approval_reason: 'Test rule' };
var model, hook, received = [], hookStatus = 200, base;

test.before(async function () {
  model = await listen(function (req, res) {
    var b = ''; req.on('data', function (c) { b += c; }); req.on('end', function () {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(modelReply) } }] }));
    });
  });
  hook = await listen(function (req, res) {
    var b = ''; req.on('data', function (c) { b += c; }); req.on('end', function () {
      received.push({ headers: req.headers, body: JSON.parse(b || '{}') }); res.writeHead(hookStatus); res.end('x');
    });
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(function () { server.close(); model.s.close(); hook.s.close(); });

const H = { 'Content-Type': 'application/json', 'X-Inheriq': '1' };
const post = function (p, body, headers) { return fetch(base + p, { method: 'POST', headers: headers || H, body: JSON.stringify(body || {}) }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); }); };
const get = function (p) { return fetch(base + p).then(function (r) { return r.json(); }); };

test('ships twelve built-in agents', async function () {
  var agents = await get('/api/agents'); assert.ok(agents.length >= 12); assert.ok(agents.find(function (a) { return a.id === 'priya'; }));
});

test('running without a model fails with a helpful hint', async function () {
  var r = await post('/api/run', { agent: 'priya', input: 'hello' });
  assert.equal(r.body.status, 'error'); assert.match(r.body.error.hint, /model/i);
});

test('adds a model, runs an agent and forces approval where the rule says so', async function () {
  var add = await post('/api/providers', { name: 'Mock', base: model.url + '/v1', model: 'm', key: 'k' }); assert.equal(add.body.providers.length, 1);
  var t = await post('/api/run', { agent: 'kavya', input: 'rank these' });
  assert.equal(t.body.status, 'pending'); assert.equal(t.body.result.data.needs_approval, true);
});

test('approving delivers the draft to the configured webhook, with edits', async function () {
  var integ = await post('/api/integrations', { type: 'webhook', name: 'Hook', url: hook.url + '/in', token: 'secret' });
  assert.equal(integ.body.integrations.length, 1);
  await post('/api/routing', { defaultRoute: integ.body.integrations[0].id });
  var t = (await post('/api/run', { agent: 'priya', input: 'refund please' })).body;
  received.length = 0;
  var d = await post('/api/tasks/' + t.id + '/decision', { decision: 'approve', body: 'Edited body' });
  assert.equal(d.body.status, 'approved'); assert.equal(d.body.action.ok, true); assert.equal(d.body.edited, true);
  assert.equal(received.length, 1); assert.equal(received[0].body.draft.body, 'Edited body'); assert.equal(received[0].body.event, 'inheriq.draft.approved');
  assert.equal(received[0].headers.authorization, 'Bearer secret');
});

test('rejecting sends nothing, and a task can only be decided once', async function () {
  var t = (await post('/api/run', { agent: 'priya', input: 'again' })).body; received.length = 0;
  var r = await post('/api/tasks/' + t.id + '/decision', { decision: 'reject' }); assert.equal(r.body.status, 'rejected'); assert.equal(received.length, 0);
  var again = await post('/api/tasks/' + t.id + '/decision', { decision: 'approve' }); assert.equal(again.status, 409);
});

test('a failed delivery can be retried', async function () {
  var t = (await post('/api/run', { agent: 'priya', input: 'retry me' })).body; hookStatus = 500;
  var d = await post('/api/tasks/' + t.id + '/decision', { decision: 'approve' }); assert.equal(d.body.action.ok, false);
  hookStatus = 200; var r = await post('/api/tasks/' + t.id + '/retry'); assert.equal(r.body.action.ok, true);
});

test('slack destinations receive a text message', async function () {
  var s = await post('/api/integrations', { type: 'slack', name: 'Slack', url: hook.url + '/slack' });
  var id = s.body.integrations.find(function (i) { return i.name === 'Slack'; }).id;
  var routes = {}; routes.priya = id; await post('/api/routing', { routes: routes });
  var t = (await post('/api/run', { agent: 'priya', input: 'slack me' })).body; received.length = 0;
  await post('/api/tasks/' + t.id + '/decision', { decision: 'approve' });
  assert.equal(received.length, 1); assert.match(received[0].body.text, /Hello Sam/);
});

test('the console rejects requests without the custom header and with a foreign Host', async function () {
  var noHeader = await post('/api/run', { agent: 'priya', input: 'x' }, { 'Content-Type': 'application/json' }); assert.equal(noHeader.status, 403);
  var status = await new Promise(function (resolve) {
    var req = http.request(base + '/api/agents', { headers: { Host: 'evil.example.com' } }, function (res) { resolve(res.statusCode); res.resume(); }); req.end();
  });
  assert.equal(status, 403);
});

test('the inbound API needs the bearer token and tags tasks with replyTo', async function () {
  var bad = await post('/api/inbound/priya', { input: 'hi' }, { 'Content-Type': 'application/json' }); assert.equal(bad.status, 401);
  var ok = await post('/api/inbound/priya', { input: 'hi', replyTo: '+15551234567' }, { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' });
  assert.equal(ok.status, 200); assert.equal(ok.body.source, 'api'); assert.equal(ok.body.replyTo, '+15551234567');
  var routes = {}; routes.priya = 'none'; await post('/api/routing', { routes: routes });
  var d = await post('/api/tasks/' + ok.body.id + '/decision', { decision: 'approve' }); assert.equal(d.body.action.via, 'none');
});

test('custom agents can be created, run and deleted', async function () {
  var c = await post('/api/agents/custom', { name: 'Zara', role: 'Booking AI', prompt: 'You are Zara. Confirm bookings.', force: true });
  assert.equal(c.status, 200); assert.equal(c.body.custom, true);
  var t = await post('/api/run', { agent: c.body.id, input: 'move me to Thursday' }); assert.equal(t.body.status, 'pending');
  await post('/api/agents/custom/delete', { id: c.body.id });
  assert.ok(!(await get('/api/agents')).find(function (a) { return a.id === c.body.id; }));
});
