# Supabase for gif-agent

## Cloud (recommended)

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** → **New query**, paste the contents of `migrations/20250509140000_gif_agent_core.sql`, and run it.
3. In **Project Settings → Database**, copy the **URI** connection string (use the **Transaction** pooler if you deploy serverless; for this Node app, **Session** or **Direct** is fine).
4. In your app `.env`, set:

   ```env
   DATABASE_URL=postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres?sslmode=require
   ```

   You can use `SUPABASE_DATABASE_URL` instead of `DATABASE_URL` if you prefer.

5. Restart `npm run dev`. The process log should show `gif-agent data store: postgres (Supabase/DATABASE_URL)`.

## Local stack (optional)

From the repo root:

```bash
npx supabase init
npx supabase start
npx supabase db reset
```

Then set `DATABASE_URL` to the Postgres URL printed by `supabase status` (often port `54322`).
