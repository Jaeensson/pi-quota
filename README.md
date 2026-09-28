# pi-quota

A [pi](https://pi.dev) extension that displays quota for the **currently selected model provider** in the bottom-right of the TUI footer. Provider-specific APIs are normalized into a shared display; if the active provider has no matching quota adapter or credential, the extension renders nothing.

## Supported providers

| Provider | What is shown | Auth requirement | API status |
| --- | --- | --- | --- |
| Z.ai (`zai`) | Coding-plan quota windows | Pi provider auth, or `$ZAI_API_KEY` / `$Z_AI_API_KEY` | Unofficial usage endpoint |
| OpenAI Codex (`openai-codex`) | Rate-limit windows and reset countdowns | Pi ChatGPT OAuth / subscription auth | Private ChatGPT backend endpoint |

Codex usage is only shown for `openai-codex` OAuth/subscription auth. An OpenAI API key uses a different billing system and is not represented as a Codex subscription quota. Codex window labels come from their reported durations, not assumed primary/secondary positions.

## Display and commands

- Footer example: `Codex 5h 16% (3h) · 1w 3% (6d 22h)`.
- Percentages are usage percentages, colored warning at ≥70% and error at ≥90%; reset countdowns are dim.
- The built-in footer is preserved; quota text is right-aligned on its last line, or given its own line if needed.
- Refreshes on session start, provider/model switch, after each turn (throttled), and every 5 minutes while quota data is available. Responses are cached for 60 seconds.
- `/quota` shows detailed usage for the active provider. `/zai-quota` remains as an alias for existing users.

## Installation

```sh
pi install /path/to/pi-quota
```

Then restart pi or run `/reload`.

## API notes

- Z.ai calls `GET https://api.z.ai/api/monitor/usage/quota/limit` using the active provider's credential (or the Z.ai environment fallback).
- Codex calls `GET https://chatgpt.com/backend-api/wham/usage` with the OAuth bearer token and `ChatGPT-Account-Id` extracted from the token claims. This is a private backend endpoint, not a documented OpenAI API.

No provider credential is stored by this extension. It asks pi's model registry for the active provider's auth.

## Development and tests

The provider parser/request tests use mocked responses and do not call provider APIs:

```sh
node --test test/provider-test.mjs
```

For a local test setup, make pi's runtime packages and `jiti` resolvable under `node_modules/@earendil-works` and `node_modules/jiti` as symlinks to your pi installation. No live API key is needed for the unit tests.
