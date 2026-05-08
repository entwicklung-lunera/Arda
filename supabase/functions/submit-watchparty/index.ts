// Public Submit-Endpoint für Watchparties.
// Akzeptiert eine Twitch- oder YouTube-URL und legt einen approved=false Eintrag an.
// Rate-Limit: max 5 Submits pro IP / Stunde.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Parsed = { platform: 'twitch' | 'youtube'; channel: string } | null;

function parseUrl(raw: string): Parsed {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  const host = url.hostname.replace(/^www\./, '').toLowerCase();

  if (host === 'twitch.tv') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    const channel = parts[0].toLowerCase();
    if (!/^[a-z0-9_]{3,25}$/.test(channel)) return null;
    return { platform: 'twitch', channel };
  }

  if (host === 'youtube.com' || host === 'm.youtube.com') {
    const v = url.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return { platform: 'youtube', channel: v };
    // /live/<id>
    const m = url.pathname.match(/^\/live\/([A-Za-z0-9_-]{11})/);
    if (m) return { platform: 'youtube', channel: m[1] };
    return null;
  }

  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return { platform: 'youtube', channel: id };
    return null;
  }

  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let body: { url?: string };
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!body.url || typeof body.url !== 'string') {
    return new Response(JSON.stringify({ error: 'missing_url' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const parsed = parseUrl(body.url);
  if (!parsed) {
    return new Response(JSON.stringify({ error: 'unsupported_url' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const supa = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Rate-Limit: max 5 Submits pro IP / Stunde
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: recentCount } = await supa
    .from('watchparties')
    .select('id', { count: 'exact', head: true })
    .eq('submitted_ip', ip)
    .gte('submitted_at', oneHourAgo);

  if ((recentCount ?? 0) >= 5) {
    return new Response(JSON.stringify({ error: 'rate_limited' }), {
      status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Insert (Upsert auf platform+channel — wenn schon eingereicht, idempotent)
  const { data, error } = await supa
    .from('watchparties')
    .upsert(
      {
        platform: parsed.platform,
        channel: parsed.channel,
        approved: false,
        status: 'unknown',
        submitted_ip: ip,
      },
      { onConflict: 'platform,channel', ignoreDuplicates: true }
    )
    .select('id, platform, channel, approved')
    .maybeSingle();

  if (error) {
    console.error('insert error', error);
    return new Response(JSON.stringify({ error: 'db_error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(
    JSON.stringify({ ok: true, duplicate: !data, entry: data ?? null }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
