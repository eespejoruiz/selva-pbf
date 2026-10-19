// Análisis ampliado para las reuniones post-feria (PBF 2026).
// Uso (dentro del contenedor): node /app/tools/amp.js <jobId> [<jobId> ...]
// Lee /data/jobs/<job>.json + el input de /data/leads.jsonl y escribe /data/amp/<token>.json y .html
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const DATA = process.env.DATA_DIR || '/data';
const DFS = 'Basic ' + Buffer.from((process.env.DATAFORSEO_LOGIN || '') + ':' + (process.env.DATAFORSEO_PASSWORD || '')).toString('base64');
const AKEY = process.env.ANTHROPIC_API_KEY || '', AMODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const GPT = process.env.GPT_MODEL || 'gpt-6-luna', GEM = process.env.GEMINI_MODEL || 'gemini-3.5-flash', PPLX = 'sonar';
const CAL = process.env.CAL_URL || '';
const OUT = path.join(DATA, 'amp'); fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
function domainOf(u) { try { if (!u) return ''; if (!/^https?:/i.test(u)) u = 'https://' + u; return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } }
const withTimeout = (p, ms, l) => Promise.race([p, new Promise((_, ko) => setTimeout(() => ko(new Error('timeout ' + l)), ms))]);
async function dfs(p, task, ms = 120000) {
  const r = await withTimeout(fetch('https://api.dataforseo.com' + p, { method: 'POST', headers: { Authorization: DFS, 'Content-Type': 'application/json' }, body: JSON.stringify([task]) }), ms, p);
  const j = await r.json(); const t = j.tasks && j.tasks[0];
  if (!t || !t.result || t.status_code >= 30000) throw new Error('dfs ' + p + ' ' + (t ? t.status_message : j.status_message));
  return t.result || [];
}
async function claude(system, user, max = 1800) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await withTimeout(fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': AKEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: AMODEL, max_tokens: max, system, messages: [{ role: 'user', content: user }] }) }), 120000, 'claude');
      const j = await r.json(); if (!j.content) throw new Error(JSON.stringify(j).slice(0, 200));
      const txt = j.content.map(c => c.text || '').join(''); const m = txt.match(/\{[\s\S]*\}/); return JSON.parse(m ? m[0] : txt);
    } catch (e) { log('claude retry', e.message); await new Promise(r => setTimeout(r, 2000)); }
  }
  throw new Error('claude falló');
}
async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; log('err', e.message); } } })); return out; }
function inputOf(job) {
  for (const l of fs.readFileSync(path.join(DATA, 'leads.jsonl'), 'utf8').split('\n')) { if (!l.includes(job)) continue; try { const r = JSON.parse(l); if (r.type === 'result' && r.job === job) return { input: r.input, lead: r.lead }; } catch { } }
  return null;
}
async function askEngine(engine, q, loc) {
  if (engine === 'google') {
    const r = await dfs('/v3/serp/google/ai_mode/live/advanced', { keyword: q, location_code: 2604, language_code: 'es', device: 'mobile' }, 90000);
    const it = (r[0] && r[0].items) || []; let text = '', urls = [];
    const walk = o => { if (!o || typeof o !== 'object') return; if (typeof o.text === 'string') text += o.text + '\n'; if (typeof o.markdown === 'string') text += o.markdown + '\n'; if (typeof o.url === 'string') urls.push(o.url); for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v); };
    walk(it); return { text: text.trim().slice(0, 6000), urls };
  }
  const P = { chatgpt: '/v3/ai_optimization/chat_gpt/llm_responses/live', gemini: '/v3/ai_optimization/gemini/llm_responses/live', perplexity: '/v3/ai_optimization/perplexity/llm_responses/live' }[engine];
  const task = { user_prompt: q, model_name: engine === 'chatgpt' ? GPT : engine === 'gemini' ? GEM : PPLX };
  if (engine === 'gemini') task.max_output_tokens = 1400;
  if (engine !== 'perplexity') task.web_search = true;
  if (engine === 'chatgpt') { task.web_search_country_iso_code = 'PE'; task.web_search_city = loc; }
  const r = await dfs(P, task, 120000);
  const items = (r[0] && r[0].items) || []; let text = '', urls = [];
  items.filter(i => i.type === 'message').forEach(i => (i.sections || []).forEach(s => { text += (s.text || '') + '\n'; (s.annotations || []).forEach(a => urls.push(a.url)); }));
  return { text: text.trim(), urls };
}
const ENG = ['chatgpt', 'gemini', 'perplexity', 'google'];
const ENGN = { chatgpt: 'ChatGPT', gemini: 'Gemini', perplexity: 'Perplexity', google: 'IA de Google' };

async function seo(jobId, J, inp) {
  const R = J.result, L = J.lead; const emp = inp.empresa || L.empresa; const dom = domainOf(inp.web);
  const loc = /peru|perú|nacional|todo/i.test(inp.ciudad || '') ? 'Lima' : (inp.ciudad || 'Lima').split(',')[0];
  log(emp, 'preguntas');
  const QF = path.join(OUT, 'q_' + jobId + '.json'); let P0 = null; try { P0 = JSON.parse(fs.readFileSync(QF, 'utf8')); } catch { }
  const P = P0 || await claude('Eres analista de GEO (visibilidad en asistentes de IA) en Perú. Responde SOLO JSON válido.',
    `Negocio: "${emp}". Vende: "${inp.servicio}". Mercado: "${inp.ciudad}". Web: "${inp.web || 'sin web'}".
Escribe 20 preguntas distintas y naturales, como las haría un cliente real en Perú a ChatGPT o a Google, buscando DÓNDE comprar o A QUIÉN contratar lo que vende este negocio (no preguntes por el negocio por su nombre). Varía: producto o servicio específico, ciudad o "en Perú", precio, calidad, envío o atención, "mejores", "recomiéndame", "dónde compro". Si vende varias cosas, repártelas.
Además da 2 a 4 variantes del nombre del negocio para detectarlo en un texto y 3 búsquedas semilla de 1 a 3 palabras (sin ciudad) que agrupen lo que vende.
JSON: {"preguntas":["..."],"marca":["..."],"semillas":["..."]}`, 1600);
  try { fs.writeFileSync(QF, JSON.stringify(P)); } catch { }
  const qs = (P.preguntas || []).slice(0, 20);
  const GEN = new Set('sac eirl srl sa peru lima empresa empresas grupo tienda shop store servicios servicio de del la las los el y en para con por al the'.split(' '));
  norm(inp.servicio + ' ' + inp.ciudad).split(' ').forEach(w => GEN.add(w));
  const toks = [...new Set(norm([emp, ...(P.marca || [])].join(' ')).split(' ').filter(w => w.length >= 4 && !GEN.has(w)))];
  const domRoot = dom ? dom.split('.')[0] : '';
  const has = (t, urls) => { const w = ' ' + norm(t) + ' '; if (dom && ((t || '').toLowerCase().includes(dom) || (urls || []).some(u => (u || '').includes(dom)))) return true; if (domRoot.length >= 5 && w.includes(' ' + domRoot + ' ')) return true; if (!toks.length) return false; return toks.filter(d => w.includes(' ' + d + ' ')).length >= Math.max(1, Math.ceil(toks.length / 2)); };
  log(emp, 'consultando', qs.length * 4, 'respuestas');
  const jobs = []; qs.forEach((q, qi) => ENG.forEach(e => jobs.push({ q, qi, e })));
  const CF = path.join(OUT, 'cache_' + jobId + '.json'); let cache = {}; try { cache = JSON.parse(fs.readFileSync(CF, 'utf8')); } catch { }
  const ans = await pool(jobs, 14, async j => { const ck = j.e + '|' + j.q; let r = cache[ck]; if (!r) { r = await askEngine(j.e, j.q, loc); cache[ck] = r; try { fs.writeFileSync(CF, JSON.stringify(cache)); } catch { } } return Object.assign({}, j, r, { yo: has(r.text, r.urls) }); });
  log(emp, 'respuestas ok', ans.filter(Boolean).length);
  // competidores por pregunta
  const comp = await pool(qs, 6, async (q, qi) => {
    const parts = ENG.map(e => { const a = ans.find(x => x && x.qi === qi && x.e === e); return `### ${e}\n${a ? clip(a.text, 1600) : '(sin respuesta)'}`; }).join('\n\n');
    return claude('Extraes nombres de empresas o tiendas concretas recomendadas en un texto. Responde SOLO JSON válido.', `Pregunta: "${q}"\n${parts}\n\nPara cada motor lista las empresas, tiendas o marcas CONCRETAS que recomienda como lugar donde comprar o contratar (no marketplaces genéricos como "Mercado Libre" salvo que los recomiende explícitamente; no incluyas "${emp}"). Nombre corto, como lo escribiría el cliente. JSON: {"chatgpt":[],"gemini":[],"perplexity":[],"google":[]}`, 700);
  });
  const cnt = {}; const per = {};
  comp.forEach(c => { if (!c) return; ENG.forEach(e => (c[e] || []).forEach(n => { const k = n.trim(); if (!k) return; const key = norm(k); if (!cnt[key]) cnt[key] = { n: k, t: 0, e: {} }; cnt[key].t++; cnt[key].e[e] = (cnt[key].e[e] || 0) + 1; })); });
  const rivales = Object.values(cnt).sort((a, b) => b.t - a.t).slice(0, 10);
  ENG.forEach(e => { const xs = ans.filter(x => x && x.e === e); per[e] = { ok: xs.length, yo: xs.filter(x => x.yo).length }; });
  const matrix = qs.map((q, qi) => ({ q, r: Object.fromEntries(ENG.map(e => { const a = ans.find(x => x && x.qi === qi && x.e === e); return [e, a ? (a.yo ? 1 : 0) : null]; })) }));
  // búsquedas
  log(emp, 'búsquedas');
  let kws = [];
  try {
    const KQ = await claude('Eres analista SEO en Perú. Responde SOLO JSON válido.', `Negocio: "${emp}". Vende: "${inp.servicio}". Mercado: "${inp.ciudad}".
Escribe 30 búsquedas CORTAS (2 a 5 palabras, minúsculas, sin tildes) que escribe en Google Perú alguien que quiere COMPRAR o CONTRATAR exactamente lo que vende este negocio. Solo intención comercial o local (precio, comprar, donde, venta, tienda, servicio, cerca de mi, lima, mayor, delivery, etc.). Nada informativo, nada de otras marcas, nada de productos que el negocio no vende. Si vende varias cosas, repártelas.
JSON: {"k":["..."]}`, 1200);
    const cand = [...new Set([...(KQ.k || []), ...((R.volumen || []).map(k => k.k))].map(norm).filter(Boolean))].slice(0, 40);
    const vol = await dfs('/v3/keywords_data/google_ads/search_volume/live', { keywords: cand, location_code: 2604, language_code: 'es' }, 90000);
    kws = vol.map(k => ({ k: k.keyword, v: k.search_volume || 0, cpc: k.cpc || 0, kd: null })).filter(k => k.v >= 10);
    try {
      const kd = await dfs('/v3/dataforseo_labs/google/bulk_keyword_difficulty/live', { keywords: kws.map(k => k.k), location_code: 2604, language_code: 'es' }, 60000);
      const m = {}; ((kd[0] && kd[0].items) || []).forEach(i => { m[i.keyword] = i.keyword_difficulty; });
      kws.forEach(k => { if (m[k.k] != null) k.kd = m[k.k]; });
    } catch (e) { log('kd', e.message); }
  } catch (e) { log('kw', e.message); }
  kws = kws.sort((a, b) => b.v - a.v).slice(0, 25);
  // plan y ficha
  log(emp, 'plan');
  const hechos = { indice: R.indice, sinWeb: !inp.web, web: R.web, maps: R.maps, google: R.google, demanda: R.total, apariciones: per, rivales: rivales.slice(0, 6).map(x => x.n + ' (' + x.t + ')'), busquedas_faciles: kws.filter(k => k.kd != null && k.kd < 30).slice(0, 8).map(k => k.k + ' ' + k.v + '/mes'), veredicto: R.veredicto, por_que: R.por_que, primero: R.primero };
  const PL = await claude('Eres consultor sénior de SEO y GEO de Selva (agencia en Lima, equipo propio de desarrollo). Escribes para el dueño de una PYME peruana: claro, concreto, sin jerga y sin prometer posiciones. Responde SOLO JSON válido.',
    `Negocio: ${emp}. Vende: ${inp.servicio}. Mercado: ${inp.ciudad}. Web: ${inp.web || 'NO TIENE'}.
HECHOS MEDIDOS (no inventes otros): ${JSON.stringify(hechos)}
Devuelve JSON:
{"resumen":"2 frases: dónde está hoy y qué está perdiendo",
"web_prioridades":[{"t":"qué arreglar o crear","por_que":"impacto en una frase","prioridad":"alta|media|baja"}] (4 a 7, basadas en los hechos; si no tiene web, qué web necesita),
"plan":[{"mes":"Mes 1","foco":"...","acciones":["3-4 acciones concretas"],"entregable":"qué ve el cliente al final del mes"},{"mes":"Mes 2",...},{"mes":"Mes 3",...}],
"ficha":{"gancho":"cómo abrir la reunión en una frase usando su dato más fuerte","dolor":"lo que más le está costando hoy","primer_paso":"qué le proponemos contratar primero y por qué","objeciones":[{"o":"objeción probable","r":"respuesta breve"}],"cierre":"pregunta de cierre"}}`, 2600);
  return { tipo: 'seo', emp, nombre: L.nombre, web: inp.web, servicio: inp.servicio, ciudad: inp.ciudad, R, qs, matrix, per, rivales, kws, PL, informe: `https://selvagencia.com/pbf-seo?r=${jobId}` };
}
async function dev(jobId, J, inp) {
  const R = J.result, L = J.lead; const emp = inp.empresa || L.empresa;
  log(emp, 'dev plan');
  const PL = await claude('Eres líder de producto de Selva (agencia en Lima con equipo propio de desarrollo: webs, apps, automatizaciones y Selva Boost, nuestro CRM con WhatsApp, agenda y seguimiento automático). Escribes para el dueño de una PYME peruana: claro, concreto, sin jerga, sin prometer plazos irreales. Responde SOLO JSON válido.',
    `Negocio: ${emp}. Rubro: ${inp.rubro}. Equipo: ${inp.equipo}. Lo que les quita tiempo: ${(inp.dolores || []).join(', ')}. Hoy usan: ${(inp.hoy || []).join(', ')}. En sus palabras: "${inp.frase || ''}".
Diagnóstico que ya recibió: ${JSON.stringify({ diagnostico: R.diagnostico, propuestas: R.propuestas, casos: R.casos }).slice(0, 3500)}
Devuelve JSON:
{"resumen":"2 frases: cómo trabajan hoy y cuánto les cuesta",
"procesos":[{"proceso":"...","hoy":"cómo lo hacen hoy (deducido, prudente)","con_selva":"cómo quedaría","ahorro":"qué ganan (tiempo, ventas, errores), sin cifras inventadas"}] (3 a 5),
"etapas":[{"etapa":"Etapa 1","nombre":"...","incluye":["3-5 entregables"],"duracion":"en semanas, realista"},{"etapa":"Etapa 2",...},{"etapa":"Etapa 3",...}],
"boost":"si Selva Boost (CRM + WhatsApp + agenda + seguimiento) resuelve parte, cómo; si no aplica, cadena vacía",
"ficha":{"gancho":"cómo abrir la reunión en una frase","dolor":"lo que más les está costando","primer_paso":"qué proponemos contratar primero y por qué","objeciones":[{"o":"...","r":"..."}],"cierre":"pregunta de cierre"}}`, 2600);
  return { tipo: 'dev', emp, nombre: L.nombre, inp, R, PL, informe: `https://selvagencia.com/pbf-dev?r=${jobId}` };
}
// ---------- HTML ----------
const CSS = `:root{--bg:#07120d;--card:#0e1f17;--line:#1f3a2c;--ink:#F2F6EE;--mut:#9fb3a6;--lime:#BFF14A;--red:#FF8A6B;--amber:#FFC266}*{box-sizing:border-box;margin:0}body{background:var(--bg);color:var(--ink);font-family:Geist,system-ui,sans-serif;line-height:1.55;padding:28px max(18px,env(safe-area-inset-right)) 60px max(18px,env(safe-area-inset-left))}main{max-width:980px;margin:0 auto;display:grid;gap:22px}.eyb{font-family:'Geist Mono',monospace;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--lime)}h1{font-size:clamp(30px,5vw,46px);letter-spacing:-.03em;line-height:1.05;margin-top:8px}h2{font-size:22px;letter-spacing:-.02em;margin-bottom:12px}p.lead{color:var(--mut);font-size:17px;margin-top:10px;max-width:70ch}section{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:22px}.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}.kpi{border:1px solid var(--line);border-radius:14px;padding:14px}.kpi b{display:block;font-size:30px;color:var(--lime);letter-spacing:-.02em;font-variant-numeric:tabular-nums}.kpi span{color:var(--mut);font-size:13px}.tw{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:9px 8px;border-top:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--mut);font-weight:500;font-size:12.5px;text-transform:uppercase;letter-spacing:.06em;border-top:0}td.c{text-align:center}td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.y{color:var(--lime);font-weight:700}.x{color:#5d7466}.bar{height:8px;border-radius:9px;background:#1b3427;overflow:hidden;margin-top:6px}.bar i{display:block;height:100%;background:var(--lime)}.pill{display:inline-block;padding:3px 9px;border-radius:99px;font-size:12px;font-weight:600}.alta{background:#3a1d14;color:var(--red)}.media{background:#3a2e12;color:var(--amber)}.baja{background:#16301f;color:var(--lime)}.facil{background:#16301f;color:var(--lime)}.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px}.mes{border:1px solid var(--line);border-radius:16px;padding:16px}.mes h3{font-size:17px;margin:4px 0 8px}ul{padding-left:18px;color:#d7e2d9}li{margin:4px 0}.mut{color:var(--mut)}.cta{display:inline-block;margin-top:14px;padding:14px 20px;border-radius:14px;background:var(--lime);color:#0a1206;font-weight:700;text-decoration:none}.cta:focus-visible{outline:3px solid #fff}footer{color:var(--mut);font-size:13px;text-align:center}`;
const head = t => `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex"><title>${esc(t)}</title><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet"><style>${CSS}</style></head><body><main>`;
const foot = `<footer>Selva Ecomarketing · selvagencia.com · Preparado para nuestra reunión. Las respuestas de las IA cambian con el tiempo: esta es la foto de hoy.</footer></main></body></html>`;
function htmlSeo(A) {
  const R = A.R, PL = A.PL || {}; const tot = A.qs.length;
  const pct = e => A.per[e] && A.per[e].ok ? Math.round(A.per[e].yo / A.per[e].ok * 100) : 0;
  const yoTot = ENG.reduce((a, e) => a + (A.per[e] ? A.per[e].yo : 0), 0), okTot = ENG.reduce((a, e) => a + (A.per[e] ? A.per[e].ok : 0), 0);
  let h = head(`${A.emp} · Análisis ampliado · Selva`);
  h += `<header><div class="eyb">Análisis ampliado · ${esc(new Date().toLocaleDateString('es-PE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Lima' }))}</div><h1>${esc(A.emp)}</h1><p class="lead">${esc(PL.resumen || R.veredicto || '')}</p></header>`;
  h += `<section><div class="kpis"><div class="kpi"><b>${okTot ? Math.round(yoTot / okTot * 100) : 0}%</b><span>de las respuestas de las IA te mencionan (${yoTot} de ${okTot})</span></div><div class="kpi"><b>${R.indice}/100</b><span>índice de visibilidad de tu diagnóstico</span></div><div class="kpi"><b>${(R.total || 0).toLocaleString('es-PE')}</b><span>búsquedas al mes en Google Perú de lo que vendes</span></div><div class="kpi"><b>${R.maps && R.maps.pos ? '#' + R.maps.pos : '—'}</b><span>${R.maps && R.maps.pos ? 'tu puesto en Google Maps' : 'no apareces en los 10 primeros de Google Maps'}</span></div></div></section>`;
  h += `<section><h2>1. Tu ranking frente a la competencia en ${tot} preguntas a las IA</h2><p class="mut">Hicimos ${tot} preguntas reales de compra a ChatGPT, Gemini, Perplexity y la IA de Google, sin mencionar tu nombre.</p><div class="kpis" style="margin-top:14px">${ENG.map(e => `<div class="kpi"><span>${ENGN[e]}</span><b>${A.per[e] ? A.per[e].yo : 0}/${A.per[e] ? A.per[e].ok : 0}</b><div class="bar"><i style="width:${pct(e)}%"></i></div></div>`).join('')}</div>`;
  if (A.rivales.length) h += `<h2 style="margin-top:20px;font-size:18px">A quién recomiendan en tu lugar</h2><div class="tw"><table><tr><th>Empresa</th><th>Menciones</th>${ENG.map(e => `<th class="c">${ENGN[e]}</th>`).join('')}</tr>${A.rivales.map(r => `<tr><td>${esc(r.n)}</td><td class="n">${r.t}</td>${ENG.map(e => `<td class="c">${r.e[e] || '·'}</td>`).join('')}</tr>`).join('')}</table></div>`;
  h += `<details style="margin-top:16px"><summary class="mut" style="cursor:pointer">Ver las ${tot} preguntas y en cuáles apareces</summary><div class="tw" style="margin-top:10px"><table><tr><th>Pregunta</th>${ENG.map(e => `<th class="c">${ENGN[e]}</th>`).join('')}</tr>${A.matrix.map(m => `<tr><td>${esc(m.q)}</td>${ENG.map(e => `<td class="c ${m.r[e] ? 'y' : 'x'}">${m.r[e] == null ? '—' : m.r[e] ? '✓' : '✗'}</td>`).join('')}</tr>`).join('')}</table></div></details></section>`;
  if (A.kws.length) h += `<section><h2>2. Las búsquedas con oportunidad</h2><p class="mut">Lo que tus clientes escriben en Google Perú cada mes. Las marcadas «fácil» tienen poca competencia: son las primeras que conviene ganar.</p><div class="tw"><table><tr><th>Búsqueda</th><th>Al mes</th><th>Dificultad</th></tr>${A.kws.map(k => `<tr><td>${esc(k.k)}</td><td class="n">${k.v.toLocaleString('es-PE')}</td><td>${k.kd == null ? '<span class="mut">—</span>' : k.kd < 30 ? `<span class="pill facil">fácil · ${k.kd}</span>` : k.kd < 60 ? `<span class="pill media">media · ${k.kd}</span>` : `<span class="pill alta">difícil · ${k.kd}</span>`}</td></tr>`).join('')}</table></div></section>`;
  if ((PL.web_prioridades || []).length) h += `<section><h2>3. ${A.web ? 'Lo que le falta a tu web, priorizado' : 'La web que necesitas'}</h2>${A.web && R.web ? `<p class="mut">Revisamos ${esc(A.web)}: puntaje técnico ${R.web.score}/100.</p>` : ''}<div class="tw"><table><tr><th>Qué hacer</th><th>Por qué importa</th><th>Prioridad</th></tr>${PL.web_prioridades.map(w => `<tr><td>${esc(w.t)}</td><td class="mut">${esc(w.por_que)}</td><td><span class="pill ${esc(w.prioridad)}">${esc(w.prioridad)}</span></td></tr>`).join('')}</table></div></section>`;
  if ((PL.plan || []).length) h += `<section><h2>4. El plan de 90 días</h2><div class="grid3">${PL.plan.map(m => `<div class="mes"><div class="eyb">${esc(m.mes)}</div><h3>${esc(m.foco)}</h3><ul>${(m.acciones || []).map(a => `<li>${esc(a)}</li>`).join('')}</ul><p class="mut" style="margin-top:8px"><b style="color:var(--ink)">Entregable:</b> ${esc(m.entregable)}</p></div>`).join('')}</div></section>`;
  h += `<section><h2>Siguiente paso</h2><p class="lead" style="margin-top:0">Lo revisamos contigo y te dejamos una propuesta por etapas, para empezar por lo que más rápido te trae clientes.</p><a class="cta" href="${esc(A.informe)}" target="_blank" rel="noopener">Ver tu diagnóstico inicial</a></section>`;
  return h + foot;
}
function htmlDev(A) {
  const PL = A.PL || {}; const R = A.R;
  let h = head(`${A.emp} · Propuesta por etapas · Selva`);
  h += `<header><div class="eyb">Análisis ampliado · ${esc(new Date().toLocaleDateString('es-PE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Lima' }))}</div><h1>${esc(A.emp)}</h1><p class="lead">${esc(PL.resumen || R.diagnostico || '')}</p></header>`;
  if ((PL.procesos || []).length) h += `<section><h2>1. Tus procesos hoy y cómo quedarían</h2><div class="tw"><table><tr><th>Proceso</th><th>Hoy</th><th>Con Selva</th><th>Qué ganas</th></tr>${PL.procesos.map(p => `<tr><td><b>${esc(p.proceso)}</b></td><td class="mut">${esc(p.hoy)}</td><td>${esc(p.con_selva)}</td><td class="mut">${esc(p.ahorro)}</td></tr>`).join('')}</table></div></section>`;
  if ((PL.etapas || []).length) h += `<section><h2>2. La propuesta por etapas</h2><div class="grid3">${PL.etapas.map(m => `<div class="mes"><div class="eyb">${esc(m.etapa)} · ${esc(m.duracion)}</div><h3>${esc(m.nombre)}</h3><ul>${(m.incluye || []).map(a => `<li>${esc(a)}</li>`).join('')}</ul></div>`).join('')}</div></section>`;
  if (PL.boost) h += `<section><h2>3. Lo que puedes usar desde la primera semana</h2><p>${esc(PL.boost)}</p></section>`;
  if ((R.casos || []).length) h += `<section><h2>Casos parecidos que ya construimos</h2><ul>${R.casos.map(c => `<li><b>${esc(c.t)}</b>${c.d ? ' · <span class="mut">' + esc(c.d) + '</span>' : ''}</li>`).join('')}</ul></section>`;
  h += `<section><h2>Siguiente paso</h2><p class="lead" style="margin-top:0">Empezamos por la etapa 1: algo que tu equipo use en semanas, no en meses.</p><a class="cta" href="${esc(A.informe)}" target="_blank" rel="noopener">Ver tu diagnóstico inicial</a></section>`;
  return h + foot;
}
(async () => {
  for (const jobId of process.argv.slice(2)) {
    try {
      const J = JSON.parse(fs.readFileSync(path.join(DATA, 'jobs', jobId + '.json'), 'utf8'));
      const x = inputOf(jobId); const inp = Object.assign({ empresa: J.lead.empresa }, x ? x.input : {});
      const A = J.flow === 'dev' ? await dev(jobId, J, inp) : await seo(jobId, J, inp);
      const token = crypto.createHash('sha256').update('amp:' + jobId + ':' + (process.env.ADMIN_TOKEN || '')).digest('base64url').slice(0, 16);
      A.token = token; A.job = jobId; A.t = new Date().toISOString();
      fs.writeFileSync(path.join(OUT, token + '.json'), JSON.stringify(A));
      fs.writeFileSync(path.join(OUT, token + '.html'), J.flow === 'dev' ? htmlDev(A) : htmlSeo(A));
      log('LISTO', A.emp, `https://selvagencia.com/pbf-${J.flow}?a=${token}`);
    } catch (e) { log('FALLO', jobId, e.stack || e.message); }
  }
})();
