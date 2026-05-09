// Cron-Function: fragt für alle approved Watchparties den Live-Status +
// Viewer-Count ab (Twitch Helix + YouTube Data API v3) und schreibt das Ergebnis
// zurück in die Tabelle. Geplant alle 30s via pg_cron.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TWITCH_CLIENT_ID = Deno.env.get('TWITCH_CLIENT_ID');
const TWITCH_CLIENT_SECRET = Deno.env.get('TWITCH_CLIENT_SECRET');
const YOUTUBE_API_KEY = Deno.env.get('YOUTUBE_API_KEY');

// Hauptkanäle (für Total-Peak-Tracking) — fix verdrahtet, weil sie pro Event sind.
const MAIN_TWITCH_CHANNEL = Deno.env.get('MAIN_TWITCH_CHANNEL') ?? 'ardasaatci1';
const MAIN_YOUTUBE_VIDEO = Deno.env.get('MAIN_YOUTUBE_VIDEO') ?? 'l0X5R1hRw8g';

// In-Memory Cache für Twitch App-Token (~60d Lifetime)
let twitchToken: { token: string; expiresAt: number } | null = null;

async function getTwitchToken(): Promise<string | null> {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) return null;
  if (twitchToken && twitchToken.expiresAt > Date.now() + 60_000) return twitchToken.token;

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) {
    console.error('twitch token error', await res.text());
    return null;
  }
  const data = await res.json();
  twitchToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return twitchToken.token;
}

type Row = { id: number; platform: string; channel: string };
type Update = {
  id: number;
  status: 'live' | 'offline' | 'error';
  last_viewers: number | null;
  display_name?: string | null;
};

async function pollTwitch(rows: Row[]): Promise<Update[]> {
  if (rows.length === 0) return [];
  const token = await getTwitchToken();
  if (!token || !TWITCH_CLIENT_ID) {
    return rows.map((r) => ({ id: r.id, status: 'error', last_viewers: null }));
  }

  // Helix erlaubt bis zu 100 user_login pro Request
  const updates: Update[] = [];
  const chunks: Row[][] = [];
  for (let i = 0; i < rows.length; i += 100) chunks.push(rows.slice(i, i + 100));

  for (const chunk of chunks) {
    const params = new URLSearchParams();
    for (const r of chunk) params.append('user_login', r.channel);
    const res = await fetch(`https://api.twitch.tv/helix/streams?${params}`, {
      headers: {
        'Client-ID': TWITCH_CLIENT_ID,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) {
      console.error('twitch helix error', res.status, await res.text());
      for (const r of chunk) updates.push({ id: r.id, status: 'error', last_viewers: null });
      continue;
    }
    const data = await res.json();
    const liveByLogin = new Map<string, { viewers: number; display: string }>();
    for (const s of data.data ?? []) {
      liveByLogin.set(String(s.user_login).toLowerCase(), {
        viewers: Number(s.viewer_count ?? 0),
        display: s.user_name,
      });
    }
    for (const r of chunk) {
      const hit = liveByLogin.get(r.channel.toLowerCase());
      if (hit) {
        updates.push({
          id: r.id,
          status: 'live',
          last_viewers: hit.viewers,
          display_name: hit.display,
        });
      } else {
        updates.push({ id: r.id, status: 'offline', last_viewers: 0 });
      }
    }
  }
  return updates;
}

async function pollYoutube(rows: Row[]): Promise<Update[]> {
  if (rows.length === 0) return [];
  if (!YOUTUBE_API_KEY) {
    return rows.map((r) => ({ id: r.id, status: 'error', last_viewers: null }));
  }

  // videos.list erlaubt bis zu 50 IDs pro Request
  const updates: Update[] = [];
  const chunks: Row[][] = [];
  for (let i = 0; i < rows.length; i += 50) chunks.push(rows.slice(i, i + 50));

  for (const chunk of chunks) {
    const ids = chunk.map((r) => r.channel).join(',');
    const url = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails,snippet&id=${encodeURIComponent(ids)}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error('youtube api error', res.status, await res.text());
      for (const r of chunk) updates.push({ id: r.id, status: 'error', last_viewers: null });
      continue;
    }
    const data = await res.json();
    const byId = new Map<string, any>();
    for (const item of data.items ?? []) byId.set(item.id, item);
    for (const r of chunk) {
      const item = byId.get(r.channel);
      if (!item) {
        updates.push({ id: r.id, status: 'offline', last_viewers: 0 });
        continue;
      }
      const cv = item.liveStreamingDetails?.concurrentViewers;
      const display = item.snippet?.channelTitle ?? null;
      if (cv != null) {
        updates.push({
          id: r.id,
          status: 'live',
          last_viewers: parseInt(cv, 10),
          display_name: display,
        });
      } else {
        updates.push({ id: r.id, status: 'offline', last_viewers: 0, display_name: display });
      }
    }
  }
  return updates;
}

Deno.serve(async (_req) => {
  const supa = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: rows, error } = await supa
    .from('watchparties')
    .select('id, platform, channel')
    .eq('approved', true);

  if (error) {
    console.error('select error', error);
    return new Response(JSON.stringify({ error: 'db_error' }), { status: 500 });
  }

  const twRows = (rows ?? []).filter((r) => r.platform === 'twitch') as Row[];
  const ytRows = (rows ?? []).filter((r) => r.platform === 'youtube') as Row[];

  // Hauptkanäle als virtuelle Rows (negative IDs → fließen nicht in DB-Updates)
  const mainTwRow: Row = { id: -1, platform: 'twitch', channel: MAIN_TWITCH_CHANNEL };
  const mainYtRow: Row = { id: -2, platform: 'youtube', channel: MAIN_YOUTUBE_VIDEO };

  const [twUpdates, ytUpdates, mainTwResult, mainYtResult] = await Promise.all([
    pollTwitch(twRows),
    pollYoutube(ytRows),
    pollTwitch([mainTwRow]),
    pollYoutube([mainYtRow]),
  ]);

  const updates = [...twUpdates, ...ytUpdates];
  const now = new Date().toISOString();

  // Watchparty-Updates (nur positive IDs)
  await Promise.all(
    updates.map((u) =>
      supa
        .from('watchparties')
        .update({
          status: u.status,
          last_viewers: u.last_viewers,
          last_check: now,
          ...(u.display_name !== undefined ? { display_name: u.display_name } : {}),
        })
        .eq('id', u.id)
    )
  );

  // Peak-Tracking
  // - main_twitch_peak / main_youtube_peak: max der Live-Werte über Zeit
  // - main_total_peak: SUMME der beiden Plattform-Peaks (nicht live snapshot)
  const liveOf = (u?: Update) => (u && u.status === 'live' ? (u.last_viewers ?? 0) : 0);
  const mainTwLive = liveOf(mainTwResult[0]);
  const mainYtLive = liveOf(mainYtResult[0]);
  const wpLiveSum = updates.reduce((s, u) => s + liveOf(u), 0);
  const currentTotalLive = mainTwLive + mainYtLive + wpLiveSum;

  const { data: storedRows } = await supa
    .from('event_stats')
    .select('key, value_int')
    .in('key', ['main_twitch_peak', 'main_youtube_peak', 'main_total_peak']);
  const stored = new Map<string, number>();
  for (const r of storedRows ?? []) stored.set(r.key, Number(r.value_int ?? 0));

  const oldTwPeak = stored.get('main_twitch_peak') ?? 0;
  const oldYtPeak = stored.get('main_youtube_peak') ?? 0;
  const oldTotalPeak = stored.get('main_total_peak') ?? 0;

  const newTwPeak = Math.max(oldTwPeak, mainTwLive);
  const newYtPeak = Math.max(oldYtPeak, mainYtLive);
  const newTotalPeak = newTwPeak + newYtPeak;

  const writes: Promise<unknown>[] = [];
  const peakUpdates: string[] = [];
  if (newTwPeak > oldTwPeak) {
    writes.push(supa.from('event_stats').upsert({ key: 'main_twitch_peak', value_int: newTwPeak, updated_at: now }));
    peakUpdates.push('main_twitch_peak');
  }
  if (newYtPeak > oldYtPeak) {
    writes.push(supa.from('event_stats').upsert({ key: 'main_youtube_peak', value_int: newYtPeak, updated_at: now }));
    peakUpdates.push('main_youtube_peak');
  }
  if (newTotalPeak !== oldTotalPeak) {
    writes.push(supa.from('event_stats').upsert({ key: 'main_total_peak', value_int: newTotalPeak, updated_at: now }));
    peakUpdates.push('main_total_peak');
  }
  await Promise.all(writes);

  return new Response(
    JSON.stringify({
      ok: true,
      polled: updates.length,
      twitch: twRows.length,
      youtube: ytRows.length,
      main: { twitch: mainTwLive, youtube: mainYtLive, wp_sum: wpLiveSum, total_live: currentTotalLive },
      peaks: { twitch: newTwPeak, youtube: newYtPeak, total: newTotalPeak },
      peaks_updated: peakUpdates,
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
});
