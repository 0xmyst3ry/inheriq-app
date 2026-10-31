# Security

## Model of the system

Inheriq is a single-user console you run yourself.

- The console (the web page and every `/api/*` route except `/api/inbound/*`) only answers requests that come from the same machine with a `localhost` Host header. Other machines get a 403.
- The inbound API (`POST /api/inbound/:agent`) is off until you set `INHERIQ_API_TOKEN` or generate a token in the Connections tab. It needs `Authorization: Bearer <token>`.
- API keys and destination secrets are stored in `data/settings.json` (file mode 600) and are never sent back to the browser.

## Please know

- **Prompt injection is real.** Text that arrives through the inbound API or a pasted message is untrusted. A model can be tricked by it. That is why anything that needs approval waits for a person, and why auto-send is off by default. Keep it off unless you accept that risk.
- **Do not expose the console.** Expose only `/api/inbound/*` through a tunnel or reverse proxy, and rate limit it there.
- **Back up or delete `data/`** when you move or retire a machine. It holds your keys and the audit trail.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's "Report a vulnerability" under the Security tab of this repository.
