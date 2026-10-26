import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

// Server-side weather proxy for the story "temperature" sticker. The client sends only
// COARSE coordinates and this fetches the current temperature from open-meteo (free,
// keyless) server-side — so the user's device and IP are never exposed directly to a
// third-party weather service, keeping the app's on-device-location promise intact. The
// coordinates are rounded again here (~11km), never logged and never stored. Returns
// { temp } in °F, or { temp: null } on any error so the sticker just doesn't appear.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const { lat, lng } = await req.json();
    const la = Number(lat), lo = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return json({ temp: null });
    // Coarsen to ~11km before the outbound call (defence in depth).
    const rla = Math.round(la * 10) / 10, rlo = Math.round(lo * 10) / 10;
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${rla}&longitude=${rlo}&current=temperature_2m&temperature_unit=fahrenheit`);
    const temp = Math.round((await res.json())?.current?.temperature_2m);
    return json({ temp: Number.isFinite(temp) ? temp : null });
  } catch {
    return json({ temp: null });
  }
});
