# gif-agent

Returns a visual how-to GIF for technical questions, with optional authenticated browsing sessions.

## Setup

```bash
npm install
npm run setup
cp .env.example .env
npm run keygen  # paste into MASTER_KEY
# add ANTHROPIC_API_KEY and/or OPENAI_API_KEY in .env (optional; safe fallback planner works without them)
npm run dev
```

You also need `ffmpeg` on your `PATH`.

## Database (SQLite vs Supabase / Postgres)

- **Default:** SQLite file at `DATA_DIR/gif-agent.sqlite` (same as before).
- **Supabase / Postgres:** Set `DATABASE_URL` (or `SUPABASE_DATABASE_URL`) to your Postgres connection string, run the SQL in `supabase/migrations/20250509140000_gif_agent_core.sql` and `supabase/migrations/20260513000000_auth_tunnel.sql` once (Supabase **SQL Editor** or `supabase db reset`), then start the app. See `supabase/README.md` for step-by-step setup.

## API

- `POST /connections/login` with `{ name, startUrl }` (requires `ENABLE_HEADFUL_BROWSER=true`; use the Chrome extension on hosted backends)
- `POST /connections/login/:loginId/finish`
- `GET /connections` (signed-in user; lists connections imported for your account)
- `POST /connections/pair/start` — returns `{ code, expiresInSec }` (requires session cookie)
- `POST /connections/pair/exchange` with `{ code }` — returns `{ extensionToken }` (for the extension)
- `POST /connections/import` with `{ name, startUrl, storageState, extraHosts? }` — Bearer extension token **or** session cookie; returns `{ connectionId }`
- `POST /tasks` with `{ question, connectionId?, apiKey?, llmProvider?, manualAssist? }` — `llmProvider` is `anthropic` (default) or `openai`
- `POST /ui/tasks` multipart with `description`, optional `screenshot`, optional `connectionId`, optional `apiKey`, optional `llmProvider`, optional `manualAssist`
- `POST /auth/request-link` with `{ email }`
- `GET /auth/verify?token=...`
- `GET /auth/me`
- `POST /auth/api-key` with `{ apiKey, llmProvider? }`
- `POST /auth/logout`
- `GET /tasks/:id`
- `GET /files/recordings/:taskId/video.gif`

## Frontend

Open `http://localhost:3000` and use the built-in UI to:

- Drag-and-drop or upload a screenshot.
- Enter a description of the problem.
- Sign in/create account with magic link email and save BYOK (toggle Claude/Anthropic vs ChatGPT/OpenAI for which API key you use).
- For authenticated sites: load the Chrome extension from `extension/` (Chrome → Extensions → Load unpacked), generate a pairing code in the UI, paste it in the extension, then capture while on the logged-in tab.
- Generate and preview a walkthrough GIF that shows a cursor-guided browser flow.

## Notes

- Without a BYOK key or env keys, planner falls back to a safe placeholder walkthrough. With `llmProvider: openai`, set `OPENAI_API_KEY` (or pass an OpenAI key in the request).
- Clicks that look destructive (`create|delete|submit|send|charge|publish`) are automatically blocked and converted to hover-only behavior.
- Walkthroughs are captured as real Playwright screen recordings (`.webm`) and then transcoded to `video.gif`.
- If SMTP is not configured, magic links are printed in server logs (console delivery mode).

## Hosted frontend + remote backend

The static frontend can run on Vercel, but the GIF generation backend needs a long-running
Node service because it launches Playwright/Chromium, records video, runs ffmpeg, and writes
uploaded/generated files. Deploy the backend with the included `Dockerfile` to a container host
such as Railway, Render, Fly.io, or Google Cloud Run.

Set these backend env vars in the container host:

- `MASTER_KEY`
- `DATABASE_URL` or `SUPABASE_DATABASE_URL`
- `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY`
- `APP_ORIGIN` to the backend public URL, for magic links
- `FRONTEND_ORIGIN` or `ALLOWED_ORIGINS` to your Vercel frontend URL

Then point the Vercel frontend at that backend by setting this before the UI script loads:

```html
<script>
  window.GIF_AGENT_API_BASE_URL = "https://your-backend.example.com";
</script>
```

For quick browser testing, you can also set local storage on the Vercel frontend:

```js
localStorage.setItem("gif_agent_api_base_url", "https://your-backend.example.com");
location.reload();
```
