// Supabase Edge Function "insight" — 자산UP의 AI 데일리 브리핑.
//
// 하루에 한 번(한국 시간 기준) Claude가 웹 검색으로 최근 뉴스를 찾아 시장 동향, 주식 아이디어, 부동산 동향을
// 정리하고, 결과를 `briefings` 테이블에 저장해 모든 사용자가 같은 결과를 씁니다.
//
// - 사용자의 자산 정보는 이 함수로 보내지 않습니다. 브리핑은 공통 내용이고, 개인화는 앱(기기)에서 합니다.
// - 필요한 비밀 값: ANTHROPIC_API_KEY (Supabase 대시보드 → Edge Functions → Secrets 에 직접 등록)
// - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 는 Supabase가 함수에 자동으로 넣어 줍니다.
// - 생성은 오래 걸릴 수 있어 백그라운드에서 실행하고, 그동안에는 status: "pending" 과 가장 최근 브리핑을 돌려줍니다.

import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const MODEL = 'claude-opus-5-5';
const PENDING_STALE_MS = 10 * 60 * 1000; // a generation that has not finished in 10 minutes is retried
const ERROR_RETRY_MS = 30 * 60 * 1000;   // after a failure, wait 30 minutes before trying again

const SYSTEM = `당신은 한국 개인 투자자를 위한 시장 브리핑 작성자입니다.
웹 검색으로 최근 3일 이내의 한국·미국 증시, 금리·환율, 산업 동향, 한국 부동산 뉴스를 찾아 읽고 정리합니다.

원칙
- 검색으로 확인한 사실만 쓰고, 출처를 남깁니다. 확인하지 못한 수치는 쓰지 않습니다.
- 미래 전망은 근거와 함께 가능성으로만 표현합니다. 확정적인 표현("반드시 오른다")을 쓰지 않습니다.
- 종목·지역 아이디어마다 근거, 확인할 촉매, 주요 위험을 함께 씁니다. 매수·매도 지시가 아니라 검토 후보로 씁니다.
- 한국어로, 짧고 구체적으로 씁니다.

출력: 다른 말 없이 아래 형식의 JSON 하나만 출력합니다.
{
  "headline": "오늘의 한 줄 요약",
  "market": [{"title": "", "summary": "2~3문장", "source": "URL"}],
  "trends": [{"theme": "", "why": "", "horizon": "단기|장기"}],
  "stocks": [{"name": "", "ticker": "국내는 6자리 코드, 미국은 티커", "market": "KR|US", "thesis": "", "catalysts": "", "risks": "", "horizon": "단기|장기", "confidence": "낮음|보통|높음"}],
  "realestate": [{"area": "지역", "type": "아파트|오피스텔|리츠 등", "thesis": "", "risks": "", "horizon": "단기|장기"}],
  "outlook": "앞으로 1~3개월 시나리오와 확인할 지표",
  "sources": [{"title": "", "url": ""}]
}
market 4~6개, trends 3~5개, stocks 5~6개(국내·미국 섞어서), realestate 3~4개.`;

const kstDay = (d = new Date()) => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

// Pull the JSON object out of the model's final text (it may be surrounded by whitespace or a code fence).
export function parseBriefing(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON in response');
  const data = JSON.parse(text.slice(a, b + 1));
  for (const k of ['market', 'trends', 'stocks', 'realestate']) if (!Array.isArray(data[k])) data[k] = [];
  if (!Array.isArray(data.sources)) data.sources = [];
  return data;
}

// Ask Claude (with web search) for today's briefing. Handles pause_turn by sending the paused turn back.
export async function generateBriefing(client, day) {
  const messages = [{ role: 'user', content: `오늘은 ${day} (한국 시간)입니다. 최신 뉴스를 검색해서 오늘의 브리핑을 작성해 주세요.` }];
  for (let round = 0; round < 4; round++) {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system: SYSTEM,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8, user_location: { type: 'approximate', country: 'KR', timezone: 'Asia/Seoul' } }],
      messages,
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: msg.content }); continue; }
    if (msg.stop_reason === 'refusal') throw new Error('refused: ' + (msg.stop_details?.category ?? 'unknown'));
    if (msg.stop_reason === 'max_tokens') throw new Error('response cut off at max_tokens');
    const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const data = parseBriefing(text);
    data.day = day;
    data.model = msg.model;
    data.generated_at = new Date().toISOString();
    return data;
  }
  throw new Error('web search did not finish');
}

export async function handle(req, deps) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'GET') return json({ ok: false, error: 'method' }, 405);
  const { db, makeClient, background, now = () => Date.now() } = deps;
  const day = kstDay(new Date(now()));

  const today = await db.get(day);
  const latest = today?.status === 'ready' ? today : await db.latestReady();
  if (today?.status === 'ready') return json({ ok: true, status: 'ready', briefing: today.data });

  const age = today ? now() - new Date(today.updated_at).getTime() : Infinity;
  const busy = today?.status === 'pending' && age < PENDING_STALE_MS;
  const coolingDown = today?.status === 'error' && age < ERROR_RETRY_MS;
  if (!busy && !coolingDown) {
    const claimed = await db.claim(day, today);
    if (claimed) {
      background((async () => {
        try {
          const data = await generateBriefing(makeClient(), day);
          await db.finish(day, 'ready', data, null);
        } catch (e) {
          await db.finish(day, 'error', null, String(e && e.message || e).slice(0, 300));
        }
      })());
    }
  }
  return json({ ok: true, status: coolingDown ? 'error' : 'pending', briefing: latest ? latest.data : null });
}

// ---- Supabase wiring (Deno runtime only) ----
if (typeof Deno !== 'undefined') {
  const sb = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const db = {
    async get(day) {
      const { data } = await sb.from('briefings').select('*').eq('day', day).maybeSingle();
      return data;
    },
    async latestReady() {
      const { data } = await sb.from('briefings').select('*').eq('status', 'ready').order('day', { ascending: false }).limit(1).maybeSingle();
      return data;
    },
    // Only one request starts a generation: insert if absent, or update only if the row is unchanged since we read it.
    async claim(day, prev) {
      const row = { day, status: 'pending', data: prev?.data ?? null, error: null, updated_at: new Date().toISOString() };
      if (!prev) {
        const { error } = await sb.from('briefings').insert(row);
        return !error;
      }
      const { data } = await sb.from('briefings').update(row).eq('day', day).eq('updated_at', prev.updated_at).select('day');
      return !!(data && data.length);
    },
    async finish(day, status, data, error) {
      await sb.from('briefings').update({ status, data, error, updated_at: new Date().toISOString() }).eq('day', day);
    },
  };
  const makeClient = () => new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });
  const background = p => (globalThis.EdgeRuntime?.waitUntil ? globalThis.EdgeRuntime.waitUntil(p) : p);
  Deno.serve(req => handle(req, { db, makeClient, background }));
}
