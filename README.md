# pi-zai-quota

A small [pi](https://pi.dev) coding-agent extension that shows your **Z.ai coding-plan quotas** —
the 5-hour rolling window and the weekly window — as a compact element in the **bottom-right
corner of the TUI footer**:

```
z.ai 5h 9% · 1w 1%
```

The percentages are color-coded once usage gets high (warning at ≥70%, error at ≥90%),
and each window shows a dim short reset countdown — `(37m)` under an hour, `(4h)` or
`(6d 22h)` above it.
All built-in footer information (cwd, token stats, context usage, model) is preserved.

## Features

- Reads the Z.ai API key already configured in pi (provider `zai`, via `/login` or `auth.json`).
  `$ZAI_API_KEY` is honored as a fallback.
- **Renders nothing when no API key is available** (or when the key is rejected with 401).
- Wraps pi's built-in footer component, so the default footer keeps working — the quota is
  appended right-aligned on the footer's last line (or as its own right-aligned line if
  there is no room, e.g. when no extension status line exists).
- Refresh policy: on session start, after each agent turn (throttled to at most once per 30s),
  and every 5 minutes while idle. Responses are cached for 60s.
- `/zai-quota` command for a detailed view (credits used / limit, reset countdown, plan level).

## Installation

From this directory (global install into `~/.pi/agent`):

```sh
pi install /path/to/pi-zai-quota
```

or from git:

```sh
pi install git:github.com/<you>/pi-zai-quota
```

Then restart pi or run `/reload`.

## How it works

The Z.ai quota API is not officially documented. This extension calls:

```
GET https://api.z.ai/api/monitor/usage/quota/limit
Authorization: Bearer <api key>
```

Example response:

```json
{
  "code": 200,
  "msg": "Operation successful",
  "data": {
    "limits": [
      { "type": "CREDIT_LIMIT", "unit": 3, "number": 5, "usage": 2000,  "currentValue": 194, "remaining": 1805, "percentage": 9, "nextResetTime": 1787937355569 },
      { "type": "CREDIT_LIMIT", "unit": 6, "number": 1, "usage": 10000, "currentValue": 194, "remaining": 9805, "percentage": 1, "nextResetTime": 1788523947998 }
    ],
    "level": "lite"
  },
  "success": true
}
```

`unit: 3` = hours, `unit: 6` = weeks — i.e. the first entry is the 5-hour window, the second
the weekly window. `usage` is the credit limit, `currentValue` what you used, `percentage`
the usage percentage.

## Notes

- The footer is only replaced in TUI mode; print/JSON/RPC modes are untouched.
- If another extension also installs a custom footer (e.g. a powerline), the last one wins —
  this extension then stays invisible rather than fighting over the footer.
- If you switch themes via `/theme`, the quota line's colors refresh on the next `/reload`.

## Development

`test/render-test.mjs` drives the extension with a mocked `pi`/`ctx`, hits the real quota API
and renders the footer. It needs `jiti` resolvable and expects a Z.ai key in
`~/.pi/agent/auth.json` (provider `zai`); symlink pi's packages first:

```sh
pi_pkg=$(dirname $(readlink -f $(which pi)))/../lib/node_modules/pi-monorepo  # adjust to your install
mkdir -p node_modules/@earendil-works
ln -sfn "$pi_pkg" node_modules/@earendil-works/pi-coding-agent
ln -sfn "$pi_pkg/node_modules/@earendil-works/pi-tui" node_modules/@earendil-works/pi-tui
ln -sfn "$pi_pkg/node_modules/jiti" node_modules/jiti
node test/render-test.mjs 110            # normal render
TEST_KEY=none node test/render-test.mjs  # no key -> must render nothing
TEST_KEY=bad  node test/render-test.mjs  # rejected key -> must render nothing
TEST_STATUS=1 node test/render-test.mjs  # quota right-aligned on an existing status line
```
