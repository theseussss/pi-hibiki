# Hibiki · Model Workbench for Pi

[简体中文](README.zh-CN.md)

A third-party [Pi](https://pi.dev) extension for selecting models, managing custom providers/models, and choosing a session Fast request policy. The interface is primarily Chinese.

## Install

Install with Pi:

```sh
pi install git:github.com/theseussss/pi-hibiki
```

For local testing, use `pi install /absolute/path/to/pi-hibiki`. Review the source before installing. Start a new Pi process, then run `/hibiki` or `/models`. No build or source-restoration step is needed.

Do not load it alongside the old standalone model picker/Fast extension, or load `extensions/model-pick.ts` separately. The package has one entry: `extensions/hibiki-models.ts`.

Tested integration: Node.js 24 and Pi 1.4.0. Other host versions are not guaranteed.

## Use

- Search and navigate the provider/model matrix; Enter switches models, Tab toggles favorites.
- Alt+N adds, Alt+X removes with confirmation, Alt+Z undoes an applicable removal, Alt+D saves the default, Alt+T changes colors.
- Alt+M opens contextual actions. `/hibiki manage` and `/hibiki providers` open management actions.
- `/hibiki fast` opens session Fast controls. `/fast [on|off|ultrafast|status|check]` is the shortcut.

Ctrl+L conflicts with Pi's built-in selector. To give it to Hibiki, merge `"app.model.select": []` into your existing Pi `keybindings.json`; do not replace the file. Slash commands work without changing keys.

Fast only applies to the implemented OpenAI-compatible provider/API/model paths. It is a request policy, not a promise of speed or price. `status`/`check` send no probe. Ultrafast is opt-in through `~/.pi/agent/pi-hibiki.json`:

```json
{ "fast": { "enableUltrafast": false } }
```

## Important limits

- **Protected management writes require Windows DPAPI, tested under WSL.** Linux/macOS credential backends are not implemented; operations needing protection fail closed. A native Windows path exists but full native Windows acceptance is not established.
- Management currently uses `HOME/.pi/agent`; a different Pi agent directory does not fully isolate these writes.
- Add new credentials by environment-variable name/reference, not by pasting API keys. Existing Pi configuration and old backups are not automatically encrypted or migrated.
- Archives are Windows-account-bound; copying encrypted files alone does not guarantee recovery on another machine. Back up your configuration before management changes.
- Upstream model-list/text checks require confirmation and may incur cost. Small text success does not prove complete model specifications.
- Extensions have the host's OS permissions. This is not a sandbox against malicious extensions or same-user processes.

## Development

Edit the TypeScript source directly. With Pi and TypeScript already installed:

```sh
export HIBIKI_PI_ROOT=/path/to/pi-coding-agent
export HIBIKI_TYPESCRIPT_ROOT=/path/to/typescript
npm run verify
```

The full suite uses temporary synthetic profiles, denied network access and fresh synthetic DPAPI data; it currently needs WSL with Windows DPAPI. It does not use real credentials or make real provider requests. Dependencies are not installed automatically. Tests are not universal platform or physical IME certification.

## License

[MIT](LICENSE) · Copyright (c) 2026 Wang Jiacong (theseussss).

Thanks to Pi, pi-sakura-cyberdeck and its pi-zentui upstream. See [NOTICE](NOTICE.md) for exact scope and the original licenses.
