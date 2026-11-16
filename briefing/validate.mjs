// Checks a daily briefing file before it is published.
// Usage: node briefing/validate.mjs path/to/briefing.json
// Exits with code 1 and prints the problems when the file is not valid.
import fs from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: node briefing/validate.mjs <briefing.json>'); process.exit(2); }

const problems = [];
let b;
try { b = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error('not valid JSON: ' + e.message); process.exit(1); }

const str = (v, path, max = 600) => {
  if (typeof v !== 'string' || !v.trim()) problems.push(`${path}: empty or not text`);
  else if (v.length > max) problems.push(`${path}: longer than ${max} characters`);
};
const oneOf = (v, allowed, path) => { if (!allowed.includes(v)) problems.push(`${path}: must be one of ${allowed.join(', ')}`); };
const url = (v, path) => { if (!/^https?:\/\/\S+$/.test(String(v || ''))) problems.push(`${path}: must be an http(s) URL`); };
const list = (v, path, min, max) => {
  if (!Array.isArray(v)) { problems.push(`${path}: must be a list`); return []; }
  if (v.length < min || v.length > max) problems.push(`${path}: needs ${min}-${max} items, has ${v.length}`);
  return v;
};

if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.day || ''))) problems.push('day: must be YYYY-MM-DD');
if (Number.isNaN(Date.parse(b.generated_at))) problems.push('generated_at: must be an ISO date-time');
str(b.headline, 'headline', 200);
str(b.outlook, 'outlook', 1200);
list(b.market, 'market', 3, 8).forEach((x, i) => { str(x.title, `market[${i}].title`, 120); str(x.summary, `market[${i}].summary`); url(x.source, `market[${i}].source`); });
list(b.trends, 'trends', 2, 6).forEach((x, i) => { str(x.theme, `trends[${i}].theme`, 60); str(x.why, `trends[${i}].why`); oneOf(x.horizon, ['단기', '장기'], `trends[${i}].horizon`); });
list(b.stocks, 'stocks', 3, 8).forEach((x, i) => {
  str(x.name, `stocks[${i}].name`, 60); oneOf(x.market, ['KR', 'US'], `stocks[${i}].market`);
  if (x.market === 'KR' && !/^\d{6}$/.test(String(x.ticker))) problems.push(`stocks[${i}].ticker: KR needs a 6-digit code`);
  if (x.market === 'US' && !/^[A-Z.]{1,8}$/.test(String(x.ticker))) problems.push(`stocks[${i}].ticker: US needs an upper-case symbol`);
  str(x.thesis, `stocks[${i}].thesis`); str(x.catalysts, `stocks[${i}].catalysts`); str(x.risks, `stocks[${i}].risks`);
  oneOf(x.horizon, ['단기', '장기'], `stocks[${i}].horizon`); oneOf(x.confidence, ['낮음', '보통', '높음'], `stocks[${i}].confidence`);
});
list(b.realestate, 'realestate', 2, 6).forEach((x, i) => { str(x.area, `realestate[${i}].area`, 60); str(x.type, `realestate[${i}].type`, 40); str(x.thesis, `realestate[${i}].thesis`); str(x.risks, `realestate[${i}].risks`); oneOf(x.horizon, ['단기', '장기'], `realestate[${i}].horizon`); });
list(b.sources, 'sources', 3, 30).forEach((x, i) => { str(x.title, `sources[${i}].title`, 200); url(x.url, `sources[${i}].url`); });

if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`ok: ${b.day} · market ${b.market.length} · stocks ${b.stocks.length} · real estate ${b.realestate.length} · sources ${b.sources.length}`);
