// SPDX-License-Identifier: AGPL-3.0-only
// Outbound integrations. An approved draft is delivered to a destination the user configured.
// Every type uses plain HTTPS requests, so there is nothing to install.

const TYPES = {
  webhook: { label: 'Generic webhook (n8n, Zapier, Make, your own API)', fields: ['url', 'token'] },
  slack: { label: 'Slack incoming webhook', fields: ['url'] },
  discord: { label: 'Discord webhook', fields: ['url'] },
  telegram: { label: 'Telegram bot', fields: ['token', 'chatId'] }
};

function text(p) {
  var d = p.draft || {};
  var head = '*' + p.agent.name + ' (' + p.agent.role + ')*';
  var meta = [d.to ? 'To: ' + d.to : '', d.subject ? 'Subject: ' + d.subject : '', p.replyTo ? 'Reply to: ' + p.replyTo : ''].filter(Boolean).join('\n');
  return head + (meta ? '\n' + meta : '') + '\n\n' + (d.body || p.headline || '');
}

function validate(i) {
  if (!TYPES[i.type]) return 'Unknown integration type.';
  if (i.type === 'telegram') { if (!i.token || !i.chatId) return 'Telegram needs a bot token and a chat id.'; return ''; }
  try { var u = new URL(i.url); if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'The URL must start with http:// or https://.'; } catch (e) { return 'Enter a valid URL.'; }
  return '';
}

async function post(url, body, headers) {
  var res = await fetch(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  var t = ''; try { t = (await res.text()).slice(0, 200); } catch (e) {}
  if (!res.ok) throw new Error('The destination answered ' + res.status + (t ? ': ' + t : ''));
}

// payload: { agent:{id,name,role}, draft, headline, facts, taskId, replyTo, approvedBy, at }
async function dispatch(integration, payload) {
  try {
    var msg = text(payload);
    if (integration.type === 'slack') await post(integration.url, { text: msg });
    else if (integration.type === 'discord') await post(integration.url, { content: msg.slice(0, 1990) });
    else if (integration.type === 'telegram') await post('https://api.telegram.org/bot' + encodeURIComponent(integration.token) + '/sendMessage', { chat_id: integration.chatId, text: msg.slice(0, 4000) });
    else if (integration.type === 'webhook') {
      await post(integration.url, { event: 'inheriq.draft.approved', taskId: payload.taskId, agent: payload.agent, headline: payload.headline, facts: payload.facts, draft: payload.draft, replyTo: payload.replyTo || null, approvedBy: payload.approvedBy, at: payload.at },
        integration.token ? { Authorization: 'Bearer ' + integration.token } : {});
    } else throw new Error('Unknown integration type.');
    return { ok: true, via: integration.name, detail: 'Delivered to ' + integration.name + '.' };
  } catch (e) {
    return { ok: false, via: integration.name, detail: (e && e.message || 'Request failed').replace(/bot[0-9]+:[A-Za-z0-9_-]+/g, 'bot…') };
  }
}

module.exports = { TYPES, validate, dispatch };
