# Inheriq

**Open-source AI employees that work with your own model, your own endpoints and your own tools, with a person approving what matters.**

Twelve ready-made agents (sales, support, HR, finance, marketing, meetings, reviews, inbox, contracts, procurement, IT helpdesk, onboarding) run on one small engine. Each agent reads your company memory, does its job, and returns a summary, key facts and a draft message. If a rule says a person must decide, the draft waits in your inbox. When you approve it, Inheriq delivers it to the destination you connected.

No accounts. No database. No dependencies. Node 18 or newer is all you need.

> Status: early (v0.1). It is a single-user console you run yourself, not a hosted multi-tenant product. See [What it is not](#what-it-is-not).

## Quick start

```bash
git clone https://github.com/0xmyst3ry/inheriq-app.git
cd inheriq-app
node server.js
```

Open <http://localhost:3000>, go to **Connections**, add a model, and press **Run all agents** to see what each one does.

You can skip the page and use environment variables instead:

```bash
GROQ_API_KEY=your-key node server.js
```

## Bring your own model

Any OpenAI-compatible chat API works. In **Connections → Model** pick a preset or enter your own base URL:

| Provider | Base URL |
| --- | --- |
| Groq | `https://api.groq.com/openai/v1` |
| OpenAI | `https://api.openai.com/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Together | `https://api.together.xyz/v1` |
| Ollama (local, free) | `http://localhost:11434/v1` |
| LM Studio (local) | `http://localhost:1234/v1` |
| Anything else | your gateway's `/v1` URL |

Type the model name from your provider's list and press **Test**. Add more than one model: the first is used first and the rest are automatic backups if it fails or is rate limited. Results are cached, so if every model is unreachable you still see your last answer for the same input, clearly labelled as cached.

Small models can return broken JSON. If an agent fails with "did not return valid JSON", try a larger model.

## Send approved drafts anywhere

In **Connections → Where approved drafts go**, add a destination and choose a default. You can also pick a different destination per agent from its page.

| Type | What it does |
| --- | --- |
| Generic webhook | POSTs JSON to any URL, with an optional bearer token. Use it to reach n8n, Zapier, Make, or your own API, and from there WhatsApp, email, a CRM or a helpdesk. |
| Slack | Posts to an incoming webhook. |
| Discord | Posts to a webhook. |
| Telegram | Sends through a bot to a chat id. |

The generic webhook body looks like this:

```json
{
  "event": "inheriq.draft.approved",
  "taskId": "bede556bc9",
  "agent": { "id": "priya", "name": "Priya", "role": "Support AI" },
  "headline": "Refund approved for order #89291",
  "facts": [{ "label": "Amount", "value": "$75" }],
  "draft": { "channel": "Email", "to": "Maria Lopez", "subject": "Your refund", "body": "Hi Maria, ..." },
  "replyTo": "+15551234567",
  "approvedBy": "human",
  "at": "2026-10-31T09:00:00.000Z"
}
```

If delivery fails, the task shows the error and a **Retry** button. If no destination is connected, approving only records your decision, and the page says so.

## Let other tools hand work to an agent

Turn on the inbound API by setting `INHERIQ_API_TOKEN` or pressing **Generate a token** in Connections.

```bash
curl -X POST http://localhost:3000/api/inbound/priya \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input": "Hi, can I get a refund for order 1234?", "replyTo": "+15551234567"}'
```

The response is the finished task. It also appears in your **Inbox** for approval, and `replyTo` is passed through to your webhook so your automation knows who to answer. Poll `GET /api/inbound/tasks/:id` with the same token to read a task later.

## Rules and approvals

Each agent has an approval rule written in its prompt, such as "refunds above $50 need the support manager". The model flags `needs_approval`, and some agents are set to **always** require approval in code (`force: true`), so a model mistake cannot skip the gate. Drafts that are inside the rules still wait for you unless you turn on **auto-send** in Connections. It is off by default.

Everything that happens is written to the audit trail and saved in `data/tasks.json`.

## Add your own agent

From the page: **+ New agent**, then fill in a name, instructions and a sample input. Or edit `agents.js` and add an entry:

```js
{ id: 'zara', name: 'Zara', role: 'Booking AI', group: 'More staff', color: '#FFC629', on: '#17123A', force: false,
  tagline: 'Confirms and reschedules appointments',
  rule: 'Changes within 24 hours wait for your OK',
  prompt: 'You are Zara, the Booking AI. Find the requested time and draft a short confirmation. Changes within 24 hours need approval.',
  sample: 'Hi, can I move my appointment from Tuesday to Thursday afternoon?' }
```

The shared engine adds the output format and your company memory, so prompts only describe the job.

## Where your data lives

Everything is in `data/` next to the server (change it with `INHERIQ_DATA`): settings and keys (`settings.json`, mode 600), custom agents, the audit trail and a result cache. Nothing is sent anywhere except to the model and the destinations you connected. Read [SECURITY.md](SECURITY.md) before exposing anything beyond your own machine.

## What it is not

- Not multi-user or multi-tenant. There is no login. The console is local only.
- Not a WhatsApp, email or CRM client. It hands approved drafts to a destination you control and leaves delivery to that tool.
- Not a replacement for professional advice. The contracts agent in particular is a first read, not legal advice.
- Not tuned for any one model. Quality depends on the model you connect.

## Develop

```bash
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[GNU AGPL-3.0](LICENSE). You may use, study, change and share Inheriq. If you run a modified version as a network service, you must offer your users the source of your changes.
