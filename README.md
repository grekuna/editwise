# Proofs

A Rails port of a TSX/Claude-Artifact prototype: paste an essay, pick one of
eight "editor persona" writing-craft critics, get inline AI revisions you
accept/decline/edit one at a time, and optionally discuss any revision with
that editor in a short chat.

No React, no TypeScript, no frontend build step. Standard Rails views +
ERB + vanilla JavaScript (served via importmap-rails) + plain CSS.

## Setup

```
bundle install
cp .env.example .env   # then edit .env and set ANTHROPIC_API_KEY
bin/rails server
```

Visit http://localhost:3000.

## Claude API key

This app calls the Anthropic Messages API from the **Rails backend**, never
from the browser, so the key is never exposed to client-side JavaScript.

1. Get a key from https://console.anthropic.com/settings/keys
2. `cp .env.example .env` and paste it in as `ANTHROPIC_API_KEY=...`
3. `dotenv-rails` (development/test only) loads `.env` automatically.
   In production, set `ANTHROPIC_API_KEY` as a real environment variable
   on whatever platform you deploy to (Heroku config var, systemd
   EnvironmentFile, Docker `-e`, etc.) — `.env` files are not used in
   production.

If the key is missing or invalid, `POST /passes` and `POST /discussions`
return a JSON `{ "error": "..." }` with a `502` status, and the frontend
shows that message in the error banner instead of crashing.

## Architecture

- **No database.** Editor personas, their prompts, and primer-page content
  are hardcoded Ruby data in `app/models/editor.rb` (ported from the TSX
  `EDITORS` / `EDITOR_PROMPTS` / `EDITOR_DETAILS` / `EDITOR_VOICES`
  constants). The essay text and revision state live entirely in the
  browser's JS state, same as the original React `useState` calls — Rails
  endpoints are stateless JSON APIs.
- **Custom prompt overrides** (the one persisted thing in the original,
  via the Artifact's `window.storage`) live in `app/models/prompt_store.rb`,
  an in-memory `Hash` for the life of the server process. See the comment
  there for how to upgrade to a real `CustomPrompt` model later.
- **Claude API calls** go through `app/services/claude_client.rb`, a thin
  `Net::HTTP` wrapper (no Anthropic gem is installed; there's no official
  Ruby SDK dependency added here, just a direct HTTP call to
  `api.anthropic.com/v1/messages`).
- **Frontend** is one `app/javascript/application.js` that owns the
  input → reading → reviewing phase state machine and renders into
  `<template>` elements declared in the ERB views, plus a small second
  half for the editor-primer page's prompt editor.

## Where this differs from the prototype

- Custom prompts reset when the Rails server restarts (in-memory only).
  The original persisted them via the Artifact sandbox's storage API.
- Otherwise this aims for behavioral parity: same editors, same prompts,
  same demo essay, same accept/decline/edit/discuss/keyboard-shortcut
  flow.
