# pi-quota

A [pi](https://pi.dev) extension that displays quota for the **currently selected model provider** in the bottom-right of the TUI footer. Provider-specific APIs are normalized into a shared display; if the active provider has no matching quota adapter or credential, the extension renders nothing.

## Supported providers

| Provider | What is shown | Auth requirement | API status |
| --- | --- | --- | --- |
| Z.ai (`zai`) | Coding-plan quota windows | Pi provider auth, or `$ZAI_API_KEY` / `$Z_AI_API_KEY` | Unofficial usage endpoint |
| OpenAI Codex (`openai-codex`) | Rate-limit windows and reset countdowns | Pi ChatGPT OAuth / subscription auth | Private ChatGPT backend endpoint |
| GitHub Copilot (`github-copilot`) | Monthly premium interactions quota | Pi GitHub Copilot auth | Undocumented endpoint; best effort |

Codex usage is only shown for `openai-codex` OAuth/subscription auth. An OpenAI API key uses a different billing system and is not represented as a Codex subscription quota. Codex window labels come from their reported durations, not assumed primary/secondary positions.

The GitHub Copilot adapter uses `GET https://api.github.com/copilot_internal/user`. This endpoint is undocumented and may change. Pi's resolved Copilot API token is not accepted by this endpoint, so the adapter reads the original GitHub OAuth token from the active Pi `auth.json` entry (using Pi's configured agent directory) and sends it only to GitHub's API host. It is never logged or persisted by this extension. The adapter is best effort and retains the last successful display if a later refresh fails.

## Display and commands

- Footer examples: `Codex 5h 16% (3h) · 1w 3% (6d 22h)` and `GitHub Copilot 1mo 54% (12d)`. The Copilot display omits chat and code-completion quotas.
- Percentages are usage percentages, colored warning at ≥70% and error at ≥90%; reset countdowns are dim.
- The built-in footer is preserved; quota text is right-aligned on its last line, or given its own line if needed.
- Refreshes on session start, provider/model switch, after each turn (throttled), and every 5 minutes while quota data is available. Responses are cached for 60 seconds.
- `/quota` shows detailed usage for the active provider. `/zai-quota` remains as an alias for existing users.

## Installation

```sh
pi install /path/to/pi-quota
```

Then restart pi or run `/reload`.

## Provider adapter structure

Shared results and the `QuotaProvider` contract live in `quota-types.ts`; common HTTP/auth/normalization helpers are in `quota-utils.ts`. Each provider implements the contract in its own `providers/<provider>.ts` module, and `quota-providers.ts` selects the adapter by the active model provider. To add a provider, implement `QuotaProvider` and register it there.

## API notes

- Z.ai calls `GET https://api.z.ai/api/monitor/usage/quota/limit` using the active provider's credential (or the Z.ai environment fallback).
- Codex calls `GET https://chatgpt.com/backend-api/wham/usage` with the OAuth bearer token and `ChatGPT-Account-Id` extracted from the token claims. This is a private backend endpoint, not a documented OpenAI API.
- GitHub Copilot calls `GET https://api.github.com/copilot_internal/user` with the original OAuth token from Pi's active `github-copilot` auth entry. It displays only `quota_snapshots.premium_interactions`, labeled `1mo` to identify its monthly window.

No provider credential is copied or persisted by this extension. It asks Pi's model registry for active-provider auth and, for the GitHub Copilot endpoint only, reads the existing OAuth token from the auth file Pi uses for the active agent directory.

## Development and tests

The provider parser/request tests use mocked responses and do not call provider APIs:

```sh
node --test test/provider-test.mjs
```

For a local test setup, make pi's runtime packages and `jiti` resolvable under `node_modules/@earendil-works` and `node_modules/jiti` as symlinks to your pi installation. No live API key is needed for the unit tests.
