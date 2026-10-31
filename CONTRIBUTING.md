# Contributing

Thanks for helping. The project is small on purpose: Node 18 or newer, no dependencies, no build step.

```bash
git clone https://github.com/0xmyst3ry/inheriq-app.git
cd inheriq-app
npm test        # 10 tests, no network needed
npm start       # http://localhost:3000
```

Good first contributions:

- **A new agent.** Add one entry to `agents.js`: a role prompt, a sample input and an approval rule. Keep prompts short and say plainly when a person must approve.
- **A new destination.** Add a type to `actions.js` (a plain HTTPS request) and a test in `test/engine.test.js`.
- **A fix.** Please include a test that fails before your change.

Guidelines: keep it dependency-free, never log or return API keys, and keep human approval as the default for anything that leaves the system. By contributing you agree your work is licensed under AGPL-3.0-only, the same as the project.
