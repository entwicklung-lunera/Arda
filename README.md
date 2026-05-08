# Arda · 600km · Live Tracker

Live-Tracker für Arda Saatçis 600km-Lauf. Single-Page-HTML mit Live-Viewer-Zahlen für Twitch + YouTube und einer Watchparty-Liste, die über Supabase verwaltet wird.

## Stack

- Single-File HTML/CSS/JS (Frontend)
- Supabase (Postgres, Edge Functions, Realtime)
- Twitch Helix API + YouTube Data API v3

## Lokal laufen lassen

```bash
npx serve -p 3000
```

Dann `http://localhost:3000` aufrufen.

`file://` geht **nicht** — Twitch-Embed braucht einen Hostname und der referrer-restricted YouTube-Key blockt sonst.

## Struktur

- `index.html` — Frontend
- `supabase/migrations/` — DB-Schema
- `supabase/functions/poll-viewers/` — Cron, fragt Twitch + YouTube ab
- `supabase/functions/submit-watchparty/` — Public Submit-Endpoint

## Konfiguration im Frontend

Im `<script>`-Block oben:

```js
const CONFIG = {
  twitchChannel: 'ardasaatci1',
  youtubeVideoId: '...',           // Live-Stream-ID
  youtubeApiKey: '...',            // referrer-restricted
  supabaseUrl: '...',
  supabaseAnonKey: '...',
  pollMs: 15000,
};
```
