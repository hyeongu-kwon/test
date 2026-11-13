// Supabase Edge Function "quote" — looks up public market prices on the server,
// so the browser never has to talk to the quote sites directly (they block CORS).
//
// Read-only and stateless: it only receives a market kind and a public symbol
// (e.g. BTC, 005930, VOO) and never sees or stores any user data.
// It only contacts the three hosts below, selected by `kind`, so it cannot be used as an open proxy.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const TTL_MS = 60 * 1000; // cache each symbol for a minute to keep upstream traffic low
const cache = new Map();

const SOURCES = {
  // Upbit public ticker (KRW market)
  crypto: {
    valid: /^[A-Z0-9]{2,10}$/,
    async get(sym, signal) {
      const r = await fetch('https://api.upbit.com/v1/ticker?markets=KRW-' + sym, { signal });
      const j = await r.json();
      return Number(j[0].trade_price);
    },
  },
  // Naver Finance realtime (KRX 6-digit codes)
  kr: {
    valid: /^\d{6}$/,
    async get(sym, signal) {
      const r = await fetch('https://polling.finance.naver.com/api/realtime?query=SERVICE_ITEM:' + sym, { signal });
      const j = await r.json();
      return Number(j.result.areas[0].datas[0].nv);
    },
  },
  // Stooq CSV (US tickers, USD)
  us: {
    valid: /^[A-Z.]{1,8}$/,
    async get(sym, signal) {
      const r = await fetch('https://stooq.com/q/l/?s=' + sym.toLowerCase() + '.us&f=sd2t2ohlcv&h&e=csv', { signal });
      const lines = (await r.text()).trim().split(/\r?\n/);
      return Number(lines[1].split(',')[6]);
    },
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function handle(req) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'GET') return json({ ok: false, error: 'method' }, 405);

  const url = new URL(req.url);
  const kind = url.searchParams.get('kind') || '';
  const sym = (url.searchParams.get('sym') || '').trim().toUpperCase();
  const src = Object.prototype.hasOwnProperty.call(SOURCES, kind) ? SOURCES[kind] : null;
  if (!src || !src.valid.test(sym)) return json({ ok: false, error: 'bad_request' }, 400);

  const key = kind + ':' + sym;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return json({ ok: true, p: hit.p, t: hit.t });

  try {
    const p = await src.get(sym, AbortSignal.timeout(8000));
    if (!(p > 0)) throw new Error('no price');
    const t = Date.now();
    cache.set(key, { p, t, at: t });
    return json({ ok: true, p, t });
  } catch (e) {
    return json({ ok: false, error: 'unavailable' }, 502);
  }
}

// Supabase Edge Runtime (Deno) entry point
if (typeof Deno !== 'undefined') Deno.serve(handle);
