# codex-provider-sync

`codex-provider-sync` keeps Codex history visible after switching between providers by rewriting both storage layers that Codex uses for thread listing:

- `~/.codex/sessions` and `~/.codex/archived_sessions`
- `~/.codex/state_5.sqlite`

It does not replace the official `codex` command. You keep using official Codex and the official app/app-server; this tool only normalizes historical session metadata to the provider you choose.

## Commands

```bash
codex-provider status
codex-provider sync
codex-provider sync --provider apigather
codex-provider switch openai
codex-provider restore C:\Users\you\.codex\backups_state\provider-sync\20260319T123456789Z
```

## Notes

- `sync` defaults to the provider currently selected in `~/.codex/config.toml`. If the config has no explicit `model_provider`, it falls back to `openai`.
- `switch <provider>` updates the root-level `model_provider` in `config.toml`, then runs `sync`.
- Every sync creates a backup under `~/.codex/backups_state/provider-sync/<timestamp>`.
- The tool is Windows-friendly first, but the core logic is plain Node.js and should work anywhere Node 24 with `node:sqlite` is available.

## Development

```bash
npm test
node ./src/cli.js status --codex-home C:\path\to\.codex
```
