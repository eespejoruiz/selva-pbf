// Selva · PBF 2026 · landings /pbf-seo y /pbf-dev con diagnóstico en vivo
// Sin dependencias: Node 20 (fetch nativo).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3095;
const DATA = process.env.DATA_DIR || '/data';
const DFS = 'Basic ' + Buffer.from((process.env.DATAFORSEO_LOGIN || '') + ':' + (process.env.DATAFORSEO_PASSWORD || '')).toString('base64');
const AKEY = process.env.ANTHROPIC_API_KEY || '';
const AMODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const RESEND = process.env.RESEND_API_KEY || '';
const FROM = process.env.MAIL_FROM || 'Selva <hola@mail.selvagencia.com>';
const REPLY = process.env.MAIL_REPLY || 'hola@selvagencia.com';
const BOOST = process.env.BOOST_URL || 'http://10.0.1.5:8002';
const CAL = process.env.CAL_URL || '';
const WA = process.env.WA_NUMBER || '51913527489';
const ADMIN = process.env.ADMIN_TOKEN || '';
const GPT = process.env.GPT_MODEL || 'gpt-6-luna';
const GEM = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

fs.mkdirSync(DATA, { recursive: true });
const LEADS = path.join(DATA, 'leads.jsonl');
const PUB = path.join(__dirname, 'public');

const leads = new Map(); // id -> lead (memoria; respaldo en jsonl)
const jobs = new Map();  // id -> job
const hits = new Map();  // ip -> [timestamps]

// ---------- utilidades ----------
const now = () => new Date().toISOString();
const log = (...a) => console.log(now(), ...a);
function save(rec) { try { fs.appendFileSync(LEADS, JSON.stringify(rec) + '\n'); } catch (e) { log('save err', e.message); } }
function ipOf(req) { return (req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').trim(); }
function limited(ip, max = 8, win = 3600e3) {
  const t = Date.now(), a = (hits.get(ip) || []).filter(x => t - x < win);
  a.push(t); hits.set(ip, a); return a.length > max;
}
function send(res, code, obj, type = 'application/json') {
  const body = type === 'application/json' ? JSON.stringify(obj) : obj;
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  res.end(body);
}
function body(req) {
  return new Promise((ok, ko) => {
    let s = ''; req.on('data', c => { s += c; if (s.length > 2e4) { ko(new Error('big')); req.destroy(); } });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { ko(e); } });
  });
}
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function domainOf(u) { try { if (!u) return ''; if (!/^https?:/i.test(u)) u = 'https://' + u; return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } }
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, ko) => setTimeout(() => ko(new Error('timeout ' + label)), ms))]);

// ---------- proveedores ----------
async function dfs(pathname, task, ms = 90000) {
  const r = await withTimeout(fetch('https://api.dataforseo.com' + pathname, { method: 'POST', headers: { Authorization: DFS, 'Content-Type': 'application/json' }, body: JSON.stringify([task]) }), ms, pathname);
  const j = await r.json();
  const t = j.tasks && j.tasks[0];
  if (!t || !t.result || t.status_code >= 30000) throw new Error('dfs ' + pathname + ' ' + (t ? t.status_message : j.status_message));
  return t.result || [];
}
async function claude(system, user, maxTokens = 1500) {
  const r = await withTimeout(fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': AKEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: AMODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] })
  }), 60000, 'claude');
  const j = await r.json();
  if (!j.content) throw new Error('claude ' + JSON.stringify(j).slice(0, 200));
  const txt = j.content.map(c => c.text || '').join('');
  const m = txt.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : txt);
}
async function mail(to, subject, html, opt) {
  if (!RESEND) return false;
  const msg = Object.assign({ from: FROM, to: [to], reply_to: REPLY, subject, html }, opt || {});
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + RESEND, 'Content-Type': 'application/json' }, body: JSON.stringify(msg) });
  if (!r.ok) { log('mail err', r.status, (await r.text()).slice(0, 200)); return false; }
  return true;
}
async function boost(lead, extra) {
  const slug = lead.flow === 'seo' ? 'pbf-seo' : 'pbf-dev';
  const data = Object.assign({ first_name: lead.nombre, email: lead.email, phone: lead.whatsapp, company: lead.empresa }, extra || {});
  try {
    const r = await fetch(BOOST + '/api/v1/public/forms/' + slug + '/submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': lead.ip || '' },
      body: JSON.stringify({ data, source: 'pbf2026', metadata: Object.assign({ referrer: lead.ref || '', landing: '/' + slug }, lead.utm || {}) })
    });
    if (!r.ok) log('boost err', r.status, (await r.text()).slice(0, 200)); else log('boost ok', slug, lead.email);
  } catch (e) { log('boost fail', e.message); }
}

// ---------- flujo SEO / GEO ----------
async function runSeo(job) {
  const L = job.lead, inp = job.input;
  const step = (k, v) => { job.steps[k] = v; };
  // 1) Plan con IA: pregunta natural, keyword de Google, variantes para volumen
  const plan = await claude(
    'Eres analista SEO en Perú. Responde SOLO JSON válido.',
    `Negocio: "${inp.empresa}". Lo que vende (palabras del cliente; si hay varias cosas separadas por comas, considera todas y prioriza la primera): "${inp.servicio}". Mercado: "${inp.ciudad}". Web: "${inp.web || 'sin web'}".
Devuelve JSON: {"servicio":"el servicio principal en 2-5 palabras, como lo buscaría un cliente","pregunta":"pregunta natural a un asistente de IA pidiendo que recomiende empresas concretas de ese servicio en ${inp.ciudad} (máx 160 caracteres, en español peruano)","google":"búsqueda en Google de 2-5 palabras con la ciudad si aplica","semilla":"el término núcleo de 1 a 3 palabras que contienen casi todas las búsquedas de este servicio, sin ciudad (ej.: 'uniformes empresariales', 'clinica dental', 'agencia de marketing')","keywords":["6 búsquedas CORTAS (2 a 4 palabras) y frecuentes que hace un cliente en Google Perú, sin marcas ni tildes: si vende varias cosas reparte las búsquedas entre ellas; incluye el término genérico solo, el término + lima, y variantes comunes (ej.: 'ferreteria', 'ferreteria lima', 'ferreteria cerca de mi')"],"marca":["variantes del nombre del negocio para detectarlo en un texto, 1-3"]}`, 700);
  job.plan = plan; step('plan', 'ok');
  const loc = /peru|perú|nacional|todo/i.test(inp.ciudad) ? 'Lima' : inp.ciudad.split(',')[0];

  const askAI = async (engine) => {
    const p = engine === 'chatgpt' ? '/v3/ai_optimization/chat_gpt/llm_responses/live' : '/v3/ai_optimization/gemini/llm_responses/live';
    const task = { user_prompt: plan.pregunta, model_name: engine === 'chatgpt' ? GPT : GEM, web_search: true, max_output_tokens: 1400 };
    if (engine === 'chatgpt') { task.web_search_country_iso_code = 'PE'; task.web_search_city = loc; }
    const res = await dfs(p, task, 110000);
    const items = (res[0] && res[0].items) || [];
    let text = '', urls = [];
    items.filter(i => i.type === 'message').forEach(i => (i.sections || []).forEach(s => { text += (s.text || '') + '\n'; (s.annotations || []).forEach(a => urls.push(a.url)); }));
    return { text: text.trim(), urls };
  };
  const tasks = {
    chatgpt: askAI('chatgpt').then(r => (step('chatgpt', 'ok'), r)).catch(e => (log('gpt', e.message), step('chatgpt', 'err'), null)),
    gemini: askAI('gemini').then(r => (step('gemini', 'ok'), r)).catch(e => (log('gem', e.message), step('gemini', 'err'), null)),
    google: dfs('/v3/serp/google/organic/live/advanced', { keyword: plan.google, location_code: 2604, language_code: 'es', depth: 20, device: 'mobile' }, 60000)
      .then(r => { step('google', 'ok'); const it = (r[0] && r[0].items) || []; return it; })
      .catch(e => (log('serp', e.message), step('google', 'err'), null)),
    volume: dfs('/v3/keywords_data/google_ads/search_volume/live', { keywords: [...new Set((plan.keywords || []).map(k => norm(k)).filter(Boolean))].slice(0, 8), location_code: 2604, language_code: 'es' }, 60000)
      .then(r => { step('volume', 'ok'); return r.map(k => ({ k: k.keyword, v: k.search_volume || 0, cpc: k.cpc || 0 })).sort((a, b) => b.v - a.v); })
      .catch(e => (log('vol', e.message), step('volume', 'err'), null)),
    ideas: dfs('/v3/dataforseo_labs/google/keyword_suggestions/live', { keyword: norm(plan.semilla || (plan.keywords || [])[0] || plan.servicio), location_code: 2604, language_code: 'es', limit: 200, order_by: ['keyword_info.search_volume,desc'] }, 45000)
      .then(r => { const r0 = r[0] || {}; const it = (r0.items || []).filter(i => { const si = i.search_intent_info || {}; return si.main_intent !== 'navigational' && !(si.foreign_intent || []).includes('navigational'); }).map(i => ({ k: i.keyword, v: (i.keyword_info && i.keyword_info.search_volume) || 0, cpc: (i.keyword_info && i.keyword_info.cpc) || 0 })).filter(i => i.v > 0); it.totalCount = r0.total_count || it.length; return it; })
      .catch(e => (log('ideas', e.message), null)),
    maps: dfs('/v3/serp/google/maps/live/advanced', { keyword: (plan.servicio || inp.servicio) + ' ' + loc, location_code: 2604, language_code: 'es', depth: 10 }, 60000)
      .then(r => { step('maps', 'ok'); return ((r[0] && r[0].items) || []).filter(i => i.type === 'maps_search'); })
      .catch(e => (log('maps', e.message), step('maps', 'err'), null)),
    web: (async () => {
      const d = domainOf(inp.web); if (!d) { step('web', 'ok'); return null; }
      try {
        const r = await dfs('/v3/on_page/instant_pages', { url: 'https://' + d + '/', enable_javascript: false }, 45000);
        step('web', 'ok'); return (r[0] && r[0].items && r[0].items[0]) || null;
      } catch (e) { log('web', e.message); step('web', 'err'); return null; }
    })()
  };
  const [gpt, gem, serp, vol, ideas, maps, web] = await Promise.all([tasks.chatgpt, tasks.gemini, tasks.google, tasks.volume, tasks.ideas, tasks.maps, tasks.web]);

  // 2) Detección ESTRICTA de la marca: dominio o palabras distintivas del nombre (no genéricas)
  const dom = domainOf(inp.web);
  const domRoot = dom ? dom.split('.')[0] : '';
  const GEN = new Set(('sac eirl srl sa s a e i r l peru lima empresa empresas grupo corporacion compania cia negocio tienda servicios servicio inmobiliaria inmobiliarias ferreteria ferreterias clinica clinicas dental agencia marketing digital consultora consultores estudio abogados restaurante restaurant cafe hotel spa salon belleza academia colegio instituto distribuidora importadora exportadora comercial industrial industrias constructora inversiones soluciones the de del la las los el y e en para con por al').split(' '));
  norm(inp.servicio + ' ' + plan.servicio + ' ' + inp.ciudad).split(' ').forEach(w => GEN.add(w));
  const nameTok = norm([inp.empresa, ...(plan.marca || [])].join(' ')).split(' ').filter(w => w.length >= 4 && !GEN.has(w));
  const distinct = [...new Set(nameTok)];
  const generico = !distinct.length;
  const words = t => ' ' + norm(t) + ' ';
  const has = t => {
    if (!t) return false;
    if (dom && String(t).toLowerCase().includes(dom)) return true;
    if (domRoot && domRoot.length >= 5 && words(t).includes(' ' + domRoot + ' ')) return true;
    if (generico) return false;
    const w = words(t); const hit = distinct.filter(d => w.includes(' ' + d + ' ')).length;
    return hit >= Math.max(1, Math.ceil(distinct.length / 2));
  };
  let g = null;
  if (serp) {
    const org = serp.filter(i => i.type === 'organic');
    const pos = org.findIndex(i => (dom && (i.domain || '').replace(/^www\./, '') === dom) || has(i.title));
    g = { pos: pos >= 0 ? pos + 1 : null, top: org.slice(0, 5).map(i => ({ t: clip(i.title, 80), d: (i.domain || '').replace(/^www\./, '') })) };
  }
  let mp = null;
  if (maps) {
    const idx = maps.findIndex(i => has(i.title) || (dom && (i.domain || '').replace(/^www\./, '') === dom));
    const rt = i => ({ t: clip(i.title, 60), r: i.rating ? i.rating.value : null, n: i.rating ? i.rating.votes_count : 0 });
    mp = { pos: idx >= 0 ? idx + 1 : null, yo: idx >= 0 ? rt(maps[idx]) : null, top: maps.slice(0, 3).map(rt) };
  }
  const CHK = { is_http: 'La web no usa conexión segura (https)', no_title: 'Falta el título de la página', no_description: 'Falta la descripción que muestra Google', no_h1_tag: 'No tiene un título principal (H1) claro', title_too_long: 'El título es demasiado largo para Google', title_too_short: 'El título es demasiado corto', high_loading_time: 'La página tarda en cargar', has_render_blocking_resources: 'Hay archivos que frenan la carga', low_content_rate: 'Poco texto útil frente al código', low_readability_rate: 'Textos difíciles de leer', no_image_alt: 'Imágenes sin texto alternativo', no_favicon: 'No tiene ícono de pestaña', is_broken: 'La página da error', is_4xx_code: 'La página da error', is_5xx_code: 'El servidor da error', irrelevant_description: 'La descripción no coincide con el contenido', irrelevant_title: 'El título no coincide con el contenido', large_page_size: 'La página es muy pesada', duplicate_meta_tags: 'Etiquetas duplicadas', deprecated_html_tags: 'Código HTML anticuado', no_encoding_meta_tag: 'Falta la codificación de caracteres', has_misspelling: 'Hay faltas de ortografía' };
  let wb = null;
  if (web) {
    const ck = web.checks || {}; const issues = [...new Set(Object.keys(CHK).filter(k => ck[k]).map(k => CHK[k]))];
    const m = web.meta || {}; if (m.htags && (m.htags.h1 || []).length > 1) issues.push('Tiene varios títulos principales (H1)');
    if (!m.social_media_tags || !m.social_media_tags['og:image']) issues.push('No tiene imagen para compartir en redes');
    wb = { score: Math.round(web.onpage_score || 0), issues, title: clip(m.title, 90) };
  }
  const ai = r => r ? { aparece: has(r.text) || r.urls.some(u => (dom && u.includes(dom))), text: r.text } : null;
  const rc = ai(gpt), rg = ai(gem);
  // Demanda: las búsquedas elegidas (relevantes) mandan; las sugerencias solo suman al conteo
  const kw = (vol || []).filter(k => k.v > 0);
  let total = kw.reduce((a, b) => a + b.v, 0);
  const sug = (ideas || []).filter(i => !kw.some(k => k.k === i.k));
  if (!total && sug.length) { sug.slice(0, 5).forEach(i => kw.push(i)); total = kw.reduce((a, b) => a + b.v, 0); }
  const valor = Math.round(kw.reduce((a, k) => a + k.v * (k.cpc || 0), 0) * 0.3);
  const nMas = sug.length;
  const unoPct = Math.round(total * 0.01);

  // 3) Lectura con IA, atada a los hechos medidos
  const H = [];
  H.push(inp.web ? `Web: ${inp.web}${wb ? ', puntaje técnico ' + wb.score + '/100, problemas: ' + wb.issues.join('; ') : ' (no se pudo leer)'}` : 'NO TIENE WEB');
  if (generico) H.push(`El nombre "${inp.empresa}" es genérico: ni Google ni la IA pueden distinguirlo de otras empresas del rubro`);
  H.push(`ChatGPT: ${rc ? (rc.aparece ? 'SÍ lo menciona' : 'NO lo menciona') : 'sin dato'}`);
  H.push(`Gemini: ${rg ? (rg.aparece ? 'SÍ lo menciona' : 'NO lo menciona') : 'sin dato'}`);
  H.push(`Google "${plan.google}": ${g ? (g.pos ? 'puesto ' + g.pos : 'no aparece en el top 20') : 'sin dato'}`);
  H.push(`Google Maps: ${mp ? (mp.pos ? 'puesto ' + mp.pos + (mp.yo && mp.yo.r ? ' con ' + mp.yo.r + '★ y ' + mp.yo.n + ' reseñas' : '') : 'no aparece en los 10 primeros') : 'sin dato'}`);
  const read = await claude(
    'Eres consultor de SEO y GEO (visibilidad en asistentes de IA) de Selva, agencia en Lima. Tono directo, cercano, sin jerga, sin prometer posiciones ni resultados. Tu objetivo: que el dueño entienda lo que está perdiendo y quiera resolverlo. Responde SOLO JSON válido.',
    `Negocio: ${inp.empresa}. Vende: ${inp.servicio}. Mercado: ${inp.ciudad}.
HECHOS MEDIDOS (son la verdad; no los contradigas ni inventes otros: no menciones reseñas, posiciones ni web si no están aquí):
- ${H.join('\n- ')}
Búsquedas al mes en Google Perú: ${total || 'sin dato'}.
Pregunta hecha a las IA: "${plan.pregunta}"
Respuesta de ChatGPT: """${rc ? clip(rc.text, 2200) : 'no disponible'}"""
Respuesta de Gemini: """${rg ? clip(rg.text, 2200) : 'no disponible'}"""
Top de Google: ${g ? g.top.map(x => x.d).join(', ') : '-'}. Top de Maps: ${mp ? mp.top.map(x => x.t + ' ' + (x.r || '-') + '★ ' + x.n + ' reseñas').join('; ') : '-'}.
Devuelve JSON: {"chatgpt_recomienda":["hasta 5 empresas que recomendó ChatGPT, nombre corto"],"gemini_recomienda":["hasta 5"],"veredicto":"una frase corta, honesta y coherente con los HECHOS","por_que":["2-3 causas concretas basadas en los HECHOS"],"primero":["3 acciones concretas que haríamos primero, la primera la más urgente, en lenguaje simple"]}`, 1100);
  step('read', 'ok');
  let idx = 0;
  if (rc && rc.aparece) idx += 25; if (rg && rg.aparece) idx += 20;
  if (g && g.pos) idx += g.pos <= 3 ? 20 : g.pos <= 10 ? 14 : 7;
  if (mp && mp.pos) idx += mp.pos <= 3 ? 15 : 8;
  if (wb) idx += Math.round(wb.score / 100 * 20);
  job.result = { indice: idx, generico, sinWeb: !inp.web, maps: mp, web: wb, valor, unoPct, mas: nMas,
    servicio: inp.servicio, pregunta: plan.pregunta, busqueda: plan.google, ciudad: inp.ciudad,
    chatgpt: rc ? { aparece: rc.aparece, recomienda: read.chatgpt_recomienda || [] } : null,
    gemini: rg ? { aparece: rg.aparece, recomienda: read.gemini_recomienda || [] } : null,
    google: g, volumen: kw.sort((a, b) => b.v - a.v), total,
    veredicto: read.veredicto, por_que: read.por_que || [], primero: read.primero || []
  };
}

// ---------- flujo Desarrollo ----------
const CASOS = [
  { id: 'cotizador', t: 'Cotizador en línea conectado a WhatsApp', d: 'El cliente arma su pedido con medidas y acabados, ve un precio estimado y lo envía por WhatsApp. Para una empresa de impresión y publicidad.' },
  { id: 'tienda', u: 'https://palosantosacred.com/pe', t: 'Tienda online con panel de pedidos y posventa', d: 'Catálogo, pagos, panel de pedidos, stock y correos automáticos que piden reseñas y recuerdan recomprar. Para marcas de productos naturales.' },
  { id: 'boost', u: 'https://boost.selvagencia.com', t: 'Selva Boost: CRM con WhatsApp e IA', d: 'Contactos, embudo de ventas, formularios, WhatsApp con IA, correos y campañas en una sola plataforma. Herramienta propia de Selva.' },
  { id: 'licitaciones', u: 'https://agency.selvagencia.com/es', t: 'Agente de IA para licitaciones del Estado', d: 'Revisa compras públicas varias veces al día, lee las bases con IA y avisa solo las oportunidades viables con sus requisitos.' },
  { id: 'idiomas', u: 'https://inglesb2.com/', t: 'Plataforma educativa con IA por voz', d: 'Los alumnos practican conversando con una IA, con registro, demo gratuita y seguimiento de avance.' },
  { id: 'corporativo', u: 'https://presentes-pe.netlify.app/', t: 'Pedidos corporativos guiados por WhatsApp', d: 'Una empresa encarga regalos para su equipo; cada colaborador elige el suyo en un flujo guiado y la empresa recibe todo consolidado.' },
  { id: 'b2b', u: 'https://amazon-andes.com/', t: 'Catálogo B2B multimarca para distribuidores', d: 'Varias marcas y más de 90 productos con fichas técnicas y solicitud de cotización para distribuidores en distintos países.' },
  { id: 'video', t: 'Estudio de video con IA', d: 'Producción de reels en serie con guion, voz e imágenes generadas, desde un panel propio.' },
  { id: 'ventas', u: 'https://agency.selvagencia.com/es', t: 'Agente de IA de ventas', d: 'Investiga prospectos, arma propuestas personalizadas y hace seguimiento automático.' },
  { id: 'mia', t: 'Panel de gestión con bitácora', d: 'Tareas, entregables, horas y avance de cada proyecto visibles para el cliente en tiempo real, con registro que no se puede editar.' }
];
async function runDev(job) {
  const inp = job.input;
  job.steps.plan = 'ok';
  const r = await claude(
    'Eres el líder de desarrollo de Selva, agencia en Lima que construye apps, sistemas a medida, tiendas online y automatizaciones con IA con equipo propio. Hablas simple, sin jerga, sin precios y sin prometer plazos ni resultados. Propones empezar con lo esencial y crecer por etapas. Responde SOLO JSON válido.',
    `Empresa: ${inp.empresa}. Rubro: ${inp.rubro}. Equipo: ${inp.equipo}.
Lo que más tiempo le quita: ${inp.dolores.join('; ')}.
Cómo lo maneja hoy: ${inp.hoy.join('; ')}.
En sus palabras: "${inp.frase || '-'}".
Proyectos que Selva YA construyó (usa solo estos como referencia, por id): ${JSON.stringify(CASOS.map(c => ({ id: c.id, t: c.t, d: c.d })))}
Devuelve JSON: {"diagnostico":"2 frases: qué está pasando en su operación y qué le cuesta","casos":[{"id":"id de un proyecto parecido","por_que":"una frase de por qué se parece a su caso"}],"propuestas":[{"titulo":"nombre simple de la herramienta","resuelve":"qué problema suyo resuelve","como":"cómo funcionaría en su día a día, 1-2 frases","empieza":"qué tendría en la primera etapa"}],"primer_paso":"una frase invitando al diagnóstico de 30 minutos"}
Reglas: "casos" de 0 a 2 elementos, solo si de verdad se parecen. "propuestas" de 2 a 3.`, 1500);
  job.steps.match = 'ok'; job.steps.design = 'ok';
  r.casos = (r.casos || []).map(c => { const k = CASOS.find(x => x.id === c.id); return k ? { t: k.t, d: k.d, u: k.u || '', por_que: c.por_que } : null; }).filter(Boolean);
  job.result = r;
}

// ---------- correos ----------
const BASE = 'https://selvagencia.com';
const REFS = [
  { t: 'Selva Boost', d: 'Nuestro CRM con WhatsApp e IA', u: 'https://boost.selvagencia.com' },
  { t: 'Sistema de agentes de IA', d: 'Agentes que investigan, redactan y avisan solos', u: 'https://agency.selvagencia.com/es' },
  { t: 'palosantosacred.com', d: 'Tienda online con panel y posventa', u: 'https://palosantosacred.com/pe' },
  { t: 'amazon-andes.com', d: 'Exportación B2B multimarca', u: 'https://amazon-andes.com/' },
  { t: 'inglesb2.com', d: 'Plataforma educativa con IA por voz', u: 'https://inglesb2.com/' },
  { t: 'presentes.pe', d: 'Pedidos guiados por WhatsApp', u: 'https://presentes-pe.netlify.app/' }
];
function shell(title, inner) {
  const refs = REFS.map(r => `<tr><td style="padding:7px 0;border-top:1px solid #eef0ea"><a href="${r.u}" style="color:#1a2a0c;font-weight:700;text-decoration:none">${r.t} ›</a><br><span style="color:#6b7064;font-size:13px">${r.d}</span></td></tr>`).join('');
  return `<!doctype html><html><body style="margin:0;background:#eef0ea;font-family:Helvetica,Arial,sans-serif;color:#18200f">
<div style="max-width:600px;margin:0 auto;padding:24px 14px">
<div style="background:#fff;border-radius:20px 20px 0 0;padding:22px 26px 10px;text-align:center"><img src="${BASE}/pbf-api/logo.png" width="72" alt="Selva Ecomarketing" style="display:inline-block"></div>
<div style="background:#000;padding:22px 26px;color:#fff"><div style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#BFF14A">Clínica de diagnóstico digital · PBF 2026 · Stand S92</div>
<div style="font-size:24px;font-weight:700;margin-top:8px;line-height:1.2">${title}</div></div>
<div style="background:#fff;border-radius:0 0 20px 20px;padding:24px 26px;font-size:15px;line-height:1.55">${inner}
<div style="margin-top:24px">${CAL ? `<a href="${CAL}" style="display:inline-block;background:#BFF14A;color:#0A1206;text-decoration:none;font-weight:700;border-radius:99px;padding:13px 20px;margin:0 8px 8px 0">Agendar 30 minutos sin costo</a>` : ''}<a href="https://wa.me/${WA}" style="display:inline-block;border:1px solid #000;color:#000;text-decoration:none;font-weight:700;border-radius:99px;padding:12px 20px">Escribir por WhatsApp</a></div>
<div style="margin-top:28px;padding-top:18px;border-top:2px solid #000"><div style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#6b7064">Lo que construimos con equipo propio</div>
<table style="width:100%;border-collapse:collapse;font-size:15px;margin-top:6px">${refs}</table>
<p style="font-size:13px;color:#4b5145;margin-top:12px">No tercerizamos: diseñamos, desarrollamos y posicionamos con nuestro propio equipo. Somos Software Partner de Amazon.com.</p></div>
<p style="color:#6b7064;font-size:12px;margin-top:18px">Selva Ecomarketing · <a href="${BASE}" style="color:#6b7064">selvagencia.com</a> · WhatsApp +51 913 527 489 · hola@selvagencia.com<br>Recibes este correo porque hiciste tu diagnóstico en nuestro stand del Perú Business Fest 2026.</p></div></div></body></html>`;
}
const li = a => (a || []).map(x => `<li style="margin:6px 0">${esc(x)}</li>`).join('');
const h3 = t => `<p style="margin:22px 0 4px;font-size:16px"><b>${t}</b></p>`;
function compOf(R) { return [...new Set([...(R.chatgpt ? R.chatgpt.recomienda : []), ...(R.gemini ? R.gemini.recomienda : [])])].filter(Boolean).slice(0, 6); }
function mailSeo(L, R, link) {
  const row = (n, ok, txt) => `<tr><td style="padding:9px 0;border-top:1px solid #eee">${n}</td><td style="padding:9px 0;border-top:1px solid #eee;text-align:right;font-weight:700;color:${ok ? '#2f7a12' : '#b4400c'}">${txt}</td></tr>`;
  let rows = '';
  if (R.chatgpt) rows += row('ChatGPT', R.chatgpt.aparece, R.chatgpt.aparece ? 'Te menciona' : 'No te menciona');
  if (R.gemini) rows += row('Gemini', R.gemini.aparece, R.gemini.aparece ? 'Te menciona' : 'No te menciona');
  if (R.google) rows += row('Google', !!R.google.pos, R.google.pos ? 'Puesto ' + R.google.pos : 'Fuera del top 20');
  if (R.maps) rows += row('Google Maps', !!R.maps.pos, R.maps.pos ? 'Puesto ' + R.maps.pos : 'Fuera del top 10');
  rows += R.web ? row('Tu web', R.web.score >= 80, R.web.score + '/100') : row('Tu web', false, 'No tiene');
  const comp = compOf(R);
  const locked = [];
  if (R.mas > 0) locked.push(`${R.mas} búsquedas relacionadas más y cuáles son más fáciles de ganar`);
  if (R.web && R.web.issues.length > 2) locked.push(`Los otros ${R.web.issues.length - 2} problemas técnicos de tu web, priorizados`);
  locked.push('Tu ranking frente a la competencia en 20 preguntas a ChatGPT, Gemini, Perplexity y la IA de Google');
  locked.push('El plan de 90 días para que te encuentren y te recomienden');
  const inner = `<p>Hola ${esc(L.nombre)}, gracias por pasar por nuestro stand. Este es el diagnóstico de <b>${esc(L.empresa)}</b> que hicimos en vivo.</p>
<div style="background:#000;color:#fff;border-radius:14px;padding:16px 18px"><div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#BFF14A">Índice de visibilidad</div><div style="font-size:46px;font-weight:700;line-height:1.1">${R.indice}<span style="font-size:20px;color:#86868B">/100</span></div><div style="font-size:15px;margin-top:4px">${esc(R.veredicto || '')}</div></div>
${R.generico ? `<p style="background:#fff4e5;border-radius:12px;padding:12px 14px;margin-top:14px"><b>Ojo con tu nombre:</b> «${esc(L.empresa)}» es un nombre genérico. Ni Google ni la IA pueden distinguirte de otras empresas del rubro, así que hoy no tienes una marca que te puedan recomendar.</p>` : ''}
${h3('1. Lo que escucha tu cliente cuando pregunta')}
<p style="margin:0">Le preguntamos a la IA: <i>«${esc(R.pregunta)}»</i></p>
${comp.length ? `<p>Y recomendó a: <b>${comp.map(esc).join(', ')}</b>.</p>` : ''}
<table style="width:100%;border-collapse:collapse;font-size:15px">${rows}</table>
${R.total ? `${h3('2. Lo que estás dejando pasar')}<p style="margin:0"><b>${R.total.toLocaleString('es-PE')} búsquedas al mes</b> en Google Perú de lo que vendes.${R.valor ? ` Comprar ese tráfico en Google Ads costaría unos <b>US$ ${R.valor.toLocaleString('es-PE')} al mes</b>.` : ''} Cada 1% de esas búsquedas son ${R.unoPct.toLocaleString('es-PE')} visitas al mes que hoy se van a otros.</p>` : ''}
${R.maps && R.maps.top.length ? `${h3('3. Quién gana en Google Maps')}<ul style="padding-left:18px;margin-top:4px">${R.maps.top.map(x => `<li>${esc(x.t)}${x.r ? ` · ${x.r}★ · ${x.n} reseñas` : ''}</li>`).join('')}<li style="color:${R.maps.pos ? '#2f7a12' : '#b4400c'}">Tú: ${R.maps.pos ? 'puesto ' + R.maps.pos + (R.maps.yo && R.maps.yo.r ? ` · ${R.maps.yo.r}★ · ${R.maps.yo.n} reseñas` : '') : 'no apareces en los 10 primeros'}</li></ul>` : ''}
${R.web && R.web.issues.length ? `${h3('Tu web hoy · ' + R.web.score + '/100')}<ul style="padding-left:18px;margin-top:4px">${li(R.web.issues.slice(0, 2))}</ul>` : ''}
${R.por_que.length ? `${h3('Por qué pasa esto')}<ul style="padding-left:18px;margin-top:4px">${li(R.por_que)}</ul>` : ''}
${R.primero.length ? `${h3('Lo primero que haríamos')}<ul style="padding-left:18px;margin-top:4px">${li(R.primero.slice(0, 1))}</ul>` : ''}
<div style="margin-top:18px;border:1px dashed #b9c2ad;border-radius:12px;padding:14px 16px;background:#fafbf7"><b>🔒 En tu análisis ampliado (30 min, sin costo)</b><ul style="padding-left:18px;margin:8px 0 0">${li(locked)}</ul></div>
<p style="margin-top:16px"><a href="${link}" style="color:#2f7a12;font-weight:700">Ver tu diagnóstico en línea ›</a></p>`;
  return shell('¿La IA recomienda tu negocio?', inner);
}
function mailDev(L, R, link) {
  const inner = `<p>Hola ${esc(L.nombre)}, gracias por pasar por nuestro stand. Esta es la propuesta inicial para <b>${esc(L.empresa)}</b>.</p>
<p style="background:#f0f7dc;border-radius:12px;padding:12px 14px">${esc(R.diagnostico || '')}</p>
${(R.casos || []).length ? `${h3('Ya construimos algo parecido')}${(R.casos || []).map(c => `<div style="border:1px solid #e3e6dc;border-radius:12px;padding:12px 14px;margin-top:8px"><b>${esc(c.t)}</b><br><span style="color:#4b5145">${esc(c.por_que)}</span>${c.u ? `<br><a href="${c.u}" style="color:#2f7a12;font-weight:700">Verlo funcionando ›</a>` : ''}</div>`).join('')}` : ''}
${h3('Lo que te proponemos')}
${(R.propuestas || []).map(p => `<div style="border:1px solid #e3e6dc;border-radius:12px;padding:12px 14px;margin-top:8px"><b>${esc(p.titulo)}</b><br><span style="color:#4b5145">${esc(p.resuelve)}</span><br>${esc(p.como)}<br><span style="color:#2f7a12">Primera etapa: ${esc(p.empieza)}</span></div>`).join('')}
<div style="margin-top:18px;border:1px dashed #b9c2ad;border-radius:12px;padding:14px 16px;background:#fafbf7"><b>🔒 En tu diagnóstico de 30 minutos</b><ul style="padding-left:18px;margin:8px 0 0"><li>El mapa de tu operación: dónde se pierde tiempo y plata hoy</li><li>Cómo se vería tu herramienta, pantalla por pantalla</li><li>La demo de un proyecto parecido</li><li>Qué construir primero y cómo crecer por etapas</li></ul></div>
<p style="margin-top:16px">${esc(R.primer_paso || 'Agendemos un diagnóstico de 30 minutos para aterrizarlo a tu operación.')}</p>
<p><a href="${link}" style="color:#2f7a12;font-weight:700">Ver tu propuesta en línea ›</a></p>`;
  return shell('Tu negocio crece. ¿Tus herramientas también?', inner);
}



// Resumen para el CRM (nota del deal en Selva Boost)
async function resumenCRM(lead, flow, input, R) {
  try {
    const datos = flow === 'seo'
      ? `Flujo: diagnóstico SEO/GEO. Empresa: ${lead.empresa}. Vende: ${input.servicio}. Mercado: ${input.ciudad}. Web: ${input.web || 'no tiene'}. Índice: ${R.indice}/100. ChatGPT: ${R.chatgpt && R.chatgpt.aparece ? 'lo menciona' : 'no lo menciona'}. Google: ${R.google && R.google.pos ? 'puesto ' + R.google.pos : 'fuera del top 20'}. Búsquedas/mes: ${R.total}. Veredicto: ${R.veredicto}. La IA recomienda a: ${compOf(R).slice(0, 4).join(', ')}.`
      : `Flujo: desarrollo de apps y sistemas. Empresa: ${lead.empresa}. Rubro: ${input.rubro}. Equipo: ${input.equipo}. Lo que le quita tiempo: ${input.dolores.join(', ')}. Hoy usa: ${input.hoy.join(', ')}. En sus palabras: ${input.frase || '-'}. Diagnóstico: ${R.diagnostico}. Propuestas: ${(R.propuestas || []).map(p => p.titulo).join(' | ')}.`;
    const r = await withTimeout(fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': AKEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: AMODEL, max_tokens: 450, system: 'Eres asistente comercial de Selva (agencia en Lima). Escribes notas internas para el CRM, en español, claras y breves, sin markdown.',
        messages: [{ role: 'user', content: 'Con estos datos de un lead captado en el Perú Business Fest 2026 (stand S92), escribe exactamente 4 líneas, sin asteriscos ni títulos extra:\nNegocio: qué hace la empresa, a quién vende y dónde (1 frase).\nLe interesa: qué servicio de Selva le interesa y por qué (1 frase).\nHallazgos: lo más relevante del diagnóstico (1-2 frases con datos).\nSiguiente paso: la acción comercial recomendada (1 frase).\n\nDatos: ' + datos }] }) }), 40000, 'resumen');
    const j = await r.json(); const t = (j.content || []).map(c => c.text || '').join('').replace(/\*\*/g, '').trim();
    const lines = t.split('\n').map(x => x.trim()).filter(x => /^(Negocio|Le interesa|Hallazgos|Siguiente paso):/.test(x));
    return lines.length ? `Resumen PBF 2026 · ${lead.empresa}\n` + lines.join('\n') : '';
  } catch (e) { log('resumen', e.message); return ''; }
}
// ---------- WhatsApp (notificador de Selva Boost) ----------
const EVO_URL = process.env.EVO_URL || '', EVO_KEY = process.env.EVO_KEY || '', EVO_INST = process.env.EVO_INSTANCE || '';
function waNum(t) { let d = String(t || '').replace(/\D/g, ''); if (d.startsWith('00')) d = d.slice(2); if (d.length === 9 && d[0] === '9') d = '51' + d; return d; }
async function waSend(to, text) {
  if (!EVO_URL || !EVO_KEY || !EVO_INST) return false;
  const num = waNum(to); if (num.length < 10) return false;
  try {
    const r = await fetch(`${EVO_URL}/message/sendText/${EVO_INST}`, { method: 'POST', headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ number: num, text }) });
    if (!r.ok) { log('wa err', r.status, (await r.text()).slice(0, 160)); return false; }
    log('wa ok', num.slice(0, 5) + '…'); return true;
  } catch (e) { log('wa fail', e.message); return false; }
}

// ---------- jobs ----------
const JOBS = path.join(DATA, 'jobs'); fs.mkdirSync(JOBS, { recursive: true });
function persist(job) { try { fs.writeFileSync(path.join(JOBS, job.id + '.json'), JSON.stringify({ flow: job.flow, status: job.status, steps: job.steps, result: job.result || null, error: job.error || null, mailed: !!job.mailed, lead: { nombre: job.lead.nombre, empresa: job.lead.empresa, email: job.lead.email } })); } catch (e) { log('persist', e.message); } }
function loadJob(id) { if (jobs.has(id)) { const j = jobs.get(id); return { flow: j.flow, status: j.status, steps: j.steps, result: j.status === 'done' ? j.result : null, error: j.error || null, mailed: !!j.mailed, lead: { nombre: j.lead.nombre, empresa: j.lead.empresa, email: j.lead.email } }; } const f = path.join(JOBS, id + '.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; }
async function startJob(lead, flow, input) {
  const id = crypto.randomBytes(9).toString('base64url');
  const job = { id, flow, lead, input, steps: {}, status: 'run', t0: Date.now() };
  jobs.set(id, job);
  lead.started = true;
  (async () => {
    try {
      if (flow === 'seo') await runSeo(job); else await runDev(job);
      job.status = 'done'; persist(job);
      const R = job.result;
      const link = `${BASE}/pbf-${flow}?r=${id}`;
      save({ t: now(), type: 'result', lead: lead.id, job: id, flow, input, result: R, ms: Date.now() - job.t0 });
      const comp = flow === 'seo' ? compOf(R) : [];
      const extra = flow === 'seo' ? {
        pbf_servicio: input.servicio, pbf_ciudad: input.ciudad, website: input.web || '',
        pbf_chatgpt: R.chatgpt ? (R.chatgpt.aparece ? 'aparece' : 'no aparece') : 'sin dato',
        pbf_gemini: R.gemini ? (R.gemini.aparece ? 'aparece' : 'no aparece') : 'sin dato',
        pbf_google: R.google ? (R.google.pos ? 'puesto ' + R.google.pos : 'fuera top 20') : 'sin dato',
        pbf_busquedas_mes: String(R.total || ''),
        pbf_informe: link,
        notes: `PBF 2026 · SEO/GEO · Índice ${R.indice}/100${R.generico ? ' · NOMBRE GENÉRICO' : ''}\nMaps: ${R.maps && R.maps.pos ? 'puesto ' + R.maps.pos : 'no aparece'} · Web: ${R.web ? R.web.score + '/100, ' + R.web.issues.length + ' problemas' : 'sin web'} · ${R.total || 0} búsquedas/mes · ~US$ ${R.valor}/mes en Ads\nVende: ${input.servicio} (${input.ciudad})\n${R.veredicto || ''}\nLa IA recomienda: ${comp.join(', ')}\nPrimero: ${(R.primero || []).join(' | ')}\nInforme: ${link}`
      } : {
        pbf_informe: link,
        pbf_rubro: input.rubro, pbf_equipo: input.equipo, pbf_dolores: input.dolores.join(', '), pbf_hoy: input.hoy.join(', '),
        notes: `PBF 2026 · Desarrollo\n${input.frase || ''}\n${R.diagnostico || ''}\nPropuestas: ${(R.propuestas || []).map(p => p.titulo).join(' | ')}\nCasos parecidos: ${(R.casos || []).map(c => c.t).join(' | ')}\nInforme: ${link}`
      };
      try { waDone(lead, flow, R, link); } catch (e) { log('waDone', e.message); }
      extra.pbf_resumen = await resumenCRM(lead, flow, input, R);
      await boost(lead, extra);
      await sendResult(flow, lead, R, link);
      job.mailed = true; persist(job);
      const nombre = (lead.nombre || '').split(' ')[0];
      const txt = flow === 'seo'
        ? `Hola ${nombre}, te escribimos de Selva. Gracias por hacer tu diagnóstico en nuestro stand S92 del Perú Business Fest.\n\nResultado de ${lead.empresa}: índice de visibilidad *${R.indice}/100*.${comp.length ? `\nHoy la IA recomienda a: ${comp.slice(0, 3).join(', ')}.` : ''}\n\nAquí lo ves completo: ${link}\nTambién te lo enviamos a ${lead.email}.${CAL ? `\n\nSi quieres el análisis ampliado (30 min, sin costo), agenda aquí: ${CAL}` : ''}\nO respóndenos por aquí.`
        : `Hola ${nombre}, te escribimos de Selva. Gracias por contarnos cómo trabaja ${lead.empresa} en nuestro stand S92 del Perú Business Fest.\n\nTu propuesta inicial está aquí: ${link}\nTambién te la enviamos a ${lead.email}.${CAL ? `\n\nPara aterrizarla a tu operación (30 min, sin costo), agenda aquí: ${CAL}` : ''}\nO respóndenos por aquí.`;
      job.wa = await waSend(lead.whatsapp, txt);
    } catch (e) {
      log('job err', flow, e.message); if (lead.keys) { lead.keys.forEach(k => used.delete(k)); save({ type: 'release', t: now(), keys: lead.keys }); } job.status = 'error'; job.error = 'No pudimos completar el análisis.'; persist(job);
      save({ t: now(), type: 'error', lead: lead.id, flow, err: e.message });
      await boost(lead, { notes: `PBF 2026 · ${flow} · análisis con error: ${input.servicio || input.frase || ''}` });
    }
  })();
  return id;
}



// ---------- correo corto y personal (14-oct): el HTML largo caía en Promociones de Gmail ----------
const FROM_PERSON = process.env.MAIL_FROM_PERSON || 'Enrique de Selva <enrique@mail.selvagencia.com>';
function shortMail(flow, L, R, link) {
  const n = (L.nombre || '').split(' ')[0] || 'Hola';
  const waTxt = '+' + WA.replace(/^51/, '51 ').replace(/(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3');
  const linea = flow === 'seo'
    ? `Ya está listo el diagnóstico de ${L.empresa}: tu índice de visibilidad es ${R && R.indice != null ? R.indice : '-'}/100.`
    : `Te dejo lo que armamos para ${L.empresa} con las tareas que nos contaste.`;
  const subject = flow === 'seo' ? `Tu diagnóstico de ${L.empresa}` : `${L.empresa}: lo que conversamos en el stand`;
  const text = `Hola ${n}:\n\nGracias por pasar por nuestro stand S92 en el Perú Business Fest. ${linea}\n\n${flow === 'seo' ? 'Aquí lo ves completo' : 'Aquí lo ves'}: ${link}\n\nSi quieres que lo revisemos juntos, responde este correo o escríbenos por WhatsApp al ${waTxt}.\n\nEnrique\nSelva Ecomarketing`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#1d1d1f;max-width:560px">` +
    `<p>Hola ${esc(n)}:</p><p>Gracias por pasar por nuestro stand S92 en el Perú Business Fest. ${esc(linea)}</p>` +
    `<p>${flow === 'seo' ? 'Aquí lo ves completo' : 'Aquí lo ves'}: <a href="${link}">${link.replace(/^https:\/\//, '')}</a></p>` +
    `<p>Si quieres que lo revisemos juntos, responde este correo o escríbenos por WhatsApp al ${esc(waTxt)}.</p><p>Enrique<br>Selva Ecomarketing</p></div>`;
  return { subject, html, text };
}
async function sendResult(flow, L, R, link) { const m = shortMail(flow, L, R, link); return mail(L.email, m.subject, m.html, { text: m.text, from: FROM_PERSON }); }

// ---------- candados (14-oct): código por correo + 1 análisis por correo, WhatsApp y web cada 30 días ----------
const WINDOW = 30 * 864e5;
const STAND_KEY = (() => { if (process.env.STAND_KEY) return process.env.STAND_KEY; try { return fs.readFileSync(path.join(DATA, 'stand.key'), 'utf8').trim(); } catch { return ''; } })();
const DISPOSABLE = new Set(['mailinator.com', 'yopmail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'guerrillamail.com', 'sharklasers.com', 'trashmail.com', 'getnada.com', 'dispostable.com', 'maildrop.cc', 'fakeinbox.com', 'mohmal.com', 'emailondeck.com', 'throwawaymail.com', 'mintemail.com', 'tempail.com', 'moakt.com', 'burnermail.io', 'mail.tm']);
const used = new Map(); // clave -> último uso (ms)
function normEmail(e) {
  let [u, d] = String(e || '').toLowerCase().trim().split('@'); if (!d) return '';
  u = u.split('+')[0]; if (d === 'gmail.com' || d === 'googlemail.com') { u = u.replace(/\./g, ''); d = 'gmail.com'; }
  return u + '@' + d;
}
const normWa = w => String(w || '').replace(/\D/g, '').slice(-9);
function keysOf(flow, email, wa, dom) {
  const k = [];
  if (email) k.push(flow + '|e|' + normEmail(email));
  if (normWa(wa).length >= 7) k.push(flow + '|w|' + normWa(wa));
  if (dom) k.push(flow + '|d|' + dom.replace(/^www\./, ''));
  return k;
}
function usedKey(keys) { const t = Date.now(); return keys.find(k => used.has(k) && t - used.get(k) < WINDOW) || null; }
function markUsed(keys, ts) { keys.forEach(k => { if (!used.has(k) || used.get(k) < ts) used.set(k, ts); }); }
(function seedUsed() {
  try {
    if (!fs.existsSync(LEADS)) return;
    const byId = new Map();
    for (const l of fs.readFileSync(LEADS, 'utf8').split('\n')) {
      if (!l.trim()) continue; let r; try { r = JSON.parse(l); } catch { continue; }
      const ts = Date.parse(r.t) || Date.now();
      if (r.type === 'lead') byId.set(r.id, r);
      else if (r.type === 'start') markUsed(keysOf(r.flow, r.email, r.wa, r.dom), ts);
      else if (r.type === 'release') (r.keys || []).forEach(k => { if ((used.get(k) || 0) <= ts) used.delete(k); });
      else if (r.type === 'result') { const L = byId.get(r.lead); if (L) markUsed(keysOf(r.flow, L.email, L.whatsapp, r.input && r.input.web ? domainOf(r.input.web) : ''), ts); }
    }
    log('candados: claves usadas', used.size);
  } catch (e) { log('seedUsed', e.message); }
})();
const REPEAT = (flow, key) => (key && key.includes('|d|')) ? `Esa web ya tuvo un diagnóstico en los últimos 30 días. Si es tuya, escríbenos por WhatsApp al +${WA} y te lo reenviamos.` : `Ya hiciste tu diagnóstico ${flow === 'seo' ? 'de visibilidad' : 'de desarrollo'} con estos datos: revisa tu correo. Si quieres otro, escríbenos por WhatsApp al +${WA} y lo vemos contigo.`;
const MASTER = (() => { try { return fs.readFileSync(path.join(DATA, 'master.code'), 'utf8').trim(); } catch { return ''; } })(); // código maestro del equipo (se lee al iniciar)
const preverified = new Set(); // correos que el equipo habilitó a mano (código rebotado)
(function reloadLeads() {
  try {
    if (!fs.existsSync(LEADS)) return; const lim = Date.now() - 12 * 3600e3; const ver = new Set();
    const rows = fs.readFileSync(LEADS, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    for (const r of rows) { if (r.type === 'verified') ver.add(r.lead); if (r.type === 'preverify' && r.email) preverified.add(normEmail(r.email)); }
    for (const r of rows) if (r.type === 'lead' && Date.parse(r.t) > lim && !leads.has(r.id)) {
      const L = Object.assign({}, r); delete L.type; L.verified = ver.has(r.id) || preverified.has(normEmail(r.email));
      L.started = rows.some(x => x.type === 'start' && x.lead === r.id); leads.set(L.id, L);
    }
    log('leads recargados', leads.size, 'preverificados', preverified.size);
  } catch (e) { log('reloadLeads', e.message); }
})();
const hashCode = (id, c) => crypto.createHash('sha256').update(id + ':' + c).digest('hex');
async function sendCode(lead) {
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  lead.code = hashCode(lead.id, code); lead.codeExp = Date.now() + 10 * 60e3; lead.tries = 0;
  lead.sends = (lead.sends || 0) + 1; lead.lastSend = Date.now();
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#13140f"><p style="font-size:15px">Hola ${esc(lead.nombre.split(' ')[0])}, este es tu código para ver tu diagnóstico de Selva:</p><p style="font-size:34px;letter-spacing:.3em;font-weight:700;margin:18px 0;color:#013A2B">${code}</p><p style="font-size:13px;color:#4b5145">Vence en 10 minutos. Si no lo pediste tú, ignora este correo.</p><p style="font-size:12px;color:#6b7064;margin-top:24px">Selva Ecomarketing · Stand S92 · Perú Business Fest 2026</p></div>`;
  const text = `Hola ${lead.nombre.split(' ')[0]}, tu código para ver tu diagnóstico de Selva es: ${code}\n\nVence en 10 minutos. Si no lo pediste tú, ignora este correo.\n\nSelva Ecomarketing · Stand S92 · Perú Business Fest 2026`;
  return mail(lead.email, 'Tu código para ver tu diagnóstico', html, { text });
}

// ---------- WhatsApp del stand (PBF 2026): el visitante escanea un QR, nos escribe y el bot le manda su enlace ----------
// Los mensajes entran por el webhook de Selva Boost (inbox), que le consulta a este servicio si los atiende.
const WAST = path.join(DATA, 'wa.json');
const wast = new Map(); // clave (teléfono o lid:xxx) -> estado de la conversación
try { for (const s of JSON.parse(fs.readFileSync(WAST, 'utf8'))) wast.set(s.key, s); } catch { }
let wastT = null;
function wastSave() { clearTimeout(wastT); wastT = setTimeout(() => { try { fs.writeFileSync(WAST + '.tmp', JSON.stringify([...wast.values()])); fs.renameSync(WAST + '.tmp', WAST); } catch (e) { log('wast', e.message); } }, 300); }
const HOOK_KEY = (() => { try { return fs.readFileSync(path.join(DATA, 'hook.key'), 'utf8').trim(); } catch { return ''; } })();
const isTrig = t => /stand\s*s?\s*92/i.test(t) || (/\bpbf\b|business\s*fest/i.test(t) && /vengo|quiero saber|informaci|m[aá]s info/i.test(t));
const RESPONSABLE = (process.env.PBF_WA_RESPONSABLE || 'enrique@selvagencia.com,enriqueespejoruiz78@gmail.com').split(','); // Enrique Espejo atiende estos leads desde su WhatsApp 913 (16-oct)
const LIMA = 5 * 3600e3; // Lima = UTC-5, sin horario de verano
function limaAt(ts, daysAhead, hh, mm) { const d = new Date(ts - LIMA); d.setUTCDate(d.getUTCDate() + daysAhead); d.setUTCHours(hh, mm, 0, 0); return d.getTime() + LIMA; }
const limaMin = ts => { const d = new Date(ts - LIMA); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
function cleanName(n) { n = String(n || '').replace(/[^\p{L}\p{M}\s'.-]/gu, '').trim(); if (!n || n.length > 40) return ''; return n; }
const firstOf = s => { const f = (s.name || '').split(/\s+/)[0] || ''; return f ? f[0].toUpperCase() + f.slice(1).toLowerCase() : ''; };
const waLink = (s, flow) => `${BASE}/pbf-${flow}?w=${s.id}`;
const WA_MSG = {
  menu: s => `¡Hola${firstOf(s) ? ' ' + firstOf(s) : ''}! Gracias por pasar por el stand de Selva en el Perú Business Fest. Te dejo todo aquí para que lo revises con calma.\n\n¿Qué te interesa más? Responde con el número:\n\n*1.* Que tu negocio aparezca en Google y en ChatGPT\n*2.* Una web, app o automatización para tu negocio\n*3.* Solo conocer qué hace Selva\n\nSolo te escribiremos sobre esto. Si no quieres más mensajes, responde *BAJA*.`,
  seo: s => `Perfecto. Aquí tienes tu *diagnóstico gratuito de visibilidad*: en 3 minutos ves cómo te encuentran Google, ChatGPT y Gemini frente a tu competencia.\n\n${waLink(s, 'seo')}\n\nHazlo cuando tengas un momento: el resultado te llega a este WhatsApp y a tu correo.`,
  dev: s => `Perfecto. Aquí tienes tu *diagnóstico gratuito de procesos*: nos cuentas en 3 minutos qué te quita tiempo y te devolvemos qué se puede resolver con una web, app o automatización, con casos parecidos.\n\n${waLink(s, 'dev')}\n\nEl resultado te llega a este WhatsApp y a tu correo.`,
  info: s => `Selva es una agencia de marketing digital y desarrollo: hacemos que las empresas aparezcan en Google y en las IA (SEO/GEO) y construimos webs, apps y automatizaciones a medida, con equipo propio.\n\nQuiénes somos: ${BASE}/nosotros/\nProyectos y clientes: ${BASE}/portafolio/\n\n${isClosed() ? `Si quieres revisar tu caso, agenda 30 minutos sin costo con Enrique Barraza: ${CAL}` : 'Si quieres un diagnóstico gratuito de tu negocio, responde *1* (Google e IA) o *2* (web, app o automatización).'}`,
  closed: s => `¡Hola${firstOf(s) ? ' ' + firstOf(s) : ''}! Gracias por escribirnos. Las auditorías gratuitas del Perú Business Fest estuvieron disponibles hasta el 17 de octubre, pero igual queremos ayudarte.\n\nAgenda 30 minutos sin costo con Enrique Barraza y revisamos juntos tu caso:\n${CAL}\n\nSi prefieres, cuéntanos por aquí qué necesitas.`,
  baja: () => `Listo, no te volveremos a escribir. Si más adelante necesitas algo, aquí estamos.`,
  remindLink: s => `Hola${firstOf(s) ? ' ' + firstOf(s) : ''}, te dejo el enlace a la mano por si hoy tienes 3 minutos:\n\n${waLink(s, s.choice === 'dev' ? 'dev' : 'seo')}\n\nSi prefieres verlo con alguien del equipo, respóndenos por aquí.`,
  remindMenu: s => `Hola${firstOf(s) ? ' ' + firstOf(s) : ''}, ¿te mando tu diagnóstico gratuito? Responde *1* (que te encuentren en Google e IA) o *2* (web, app o automatización).`
};
function waChoice(t, menu) {
  const m = String(t || '').trim().match(/^\*?\s*([123])\s*\*?[.)]?\s*$/); if (m) return ({ 1: 'seo', 2: 'dev', 3: 'info' })[m[1]];
  if (!menu || t.length > 60) return null;
  if (/google|chat\s*gpt|\bseo\b|\bgeo\b|aparecer|visibilidad|posicion/i.test(t)) return 'seo';
  if (/\bweb\b|\bapp|automati|desarroll|sistema|software/i.test(t)) return 'dev';
  if (/conocer|informaci|qu[eé] hacen|selva/i.test(t)) return 'info';
  return null;
}
function waById(id) { for (const s of wast.values()) if (s.id === id) return s; return null; }
function waHook(b) {
  const text = String(b.text || '').trim(); if (!text) return { handled: false };
  const key = String(b.phone || '').replace(/\D/g, '') || (b.lid ? 'lid:' + String(b.lid).replace(/\D/g, '') : ''); if (!key) return { handled: false };
  let s = wast.get(key);
  if (isTrig(text) && text.length < 220) {
    const nuevo = !s;
    if (!s) { s = { key, id: crypto.randomBytes(8).toString('base64url'), t: Date.now() }; wast.set(key, s); }
    Object.assign(s, { dest: b.dest || s.dest || key, phone: String(b.phone || s.phone || '').replace(/\D/g, ''), lid: b.lid || s.lid || '', name: cleanName(b.name) || s.name || '', conv: b.conv || s.conv, contact: b.contact || s.contact, tMenu: Date.now() });
    s.stage = s.done ? 'done' : 'menu'; delete s.reminded;
    save({ type: 'wa', t: now(), ev: nuevo ? 'scan' : 'rescan', key }); wastSave();
    if (isClosed()) return { handled: true, replies: [WA_MSG.closed(s)], crm: { origen: 'pbf2026-wa', nuevo, nombre: s.name } };
    return { handled: true, replies: [WA_MSG.menu(s)], crm: { origen: 'pbf2026-wa', nuevo, nombre: s.name } };
  }
  if (!s || Date.now() - s.t > 21 * 864e5) return { handled: false };
  if (/^\s*\*?(baja|stop|ya no|no quiero m[aá]s)\b/i.test(text) && text.length < 40) {
    s.stage = 'baja'; save({ type: 'wa', t: now(), ev: 'baja', key }); wastSave();
    return { handled: true, replies: [WA_MSG.baja()], optout: true };
  }
  if (!['menu', 'link', 'info'].includes(s.stage)) return { handled: false };
  const c = waChoice(text, s.stage === 'menu'); if (!c) return { handled: false };
  if (isClosed() && c !== 'info') { s.choice = c; wastSave(); save({ type: 'wa', t: now(), ev: 'choice_closed', key, c }); return { handled: true, replies: [WA_MSG.closed(s)], crm: { fields: { pbf_interes: c } } }; }
  if (c === 'info') { if (s.stage === 'menu') s.stage = 'info'; }
  else { s.choice = c; s.stage = s.done ? 'done' : 'link'; s.tLink = Date.now(); }
  s.choices = (s.choices || []).concat(c).slice(-5);
  save({ type: 'wa', t: now(), ev: 'choice', key, c }); wastSave();
  return { handled: true, replies: [WA_MSG[c](s)], crm: { fields: { pbf_interes: s.choice || c } } };
}
async function waSendTo(dest, text) {
  if (!EVO_URL || !EVO_KEY || !EVO_INST || !dest) return false;
  const num = String(dest).includes('@') ? dest : waNum(dest);
  try {
    const r = await fetch(`${EVO_URL}/message/sendText/${EVO_INST}`, { method: 'POST', headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ number: num, text }) });
    if (!r.ok) { log('wa err', r.status, (await r.text()).slice(0, 160)); return false; } return true;
  } catch (e) { log('wa fail', e.message); return false; }
}
// Cuando termina un diagnóstico, se marca en su conversación de WhatsApp (por enlace o por número).
function waDone(lead, flow, R, link) {
  let s = lead.wst ? wast.get(lead.wst) : null;
  if (!s) { const w = normWa(lead.whatsapp); if (w.length >= 9) for (const x of wast.values()) if (x.phone && normWa(x.phone) === w) { s = x; break; } }
  if (!s) return;
  const comp = flow === 'seo' ? compOf(R) : [];
  s.done = true; s.stage = 'done'; s.flow = flow; s.link = link; s.email = lead.email; s.empresa = lead.empresa; s.nombreForm = lead.nombre;
  s.hallazgo = flow === 'seo'
    ? `el índice de visibilidad de ${lead.empresa} salió ${R.indice}/100${comp.length ? `, y cuando alguien le pregunta a la IA por lo que vende, recomienda a ${comp[0]}` : ''}`
    : `lo primero que haríamos en ${lead.empresa} es ${((R.propuestas || [])[0] || {}).titulo || 'automatizar la tarea que más tiempo les quita'}`;
  wastSave();
}
// Recordatorio único: 18:30 si escribió antes de las 17:30; si no, al día siguiente a las 10:00.
setInterval(async () => {
  const t = Date.now();
  for (const s of wast.values()) {
    if (isClosed()) break;
    if (s.reminded || s.done || !['menu', 'link'].includes(s.stage) || !s.dest) continue;
    const base = s.stage === 'link' ? s.tLink : (s.tMenu || s.t);
    const at = limaMin(base) < 17 * 60 + 30 ? limaAt(base, 0, 18, 30) : limaAt(base, 1, 10, 0);
    if (t < at) continue;
    s.reminded = t; wastSave();
    if (t - at > 3 * 3600e3) continue; // si el servicio estuvo caído, no se manda tarde
    const ok = await waSendTo(s.dest, s.stage === 'link' ? WA_MSG.remindLink(s) : WA_MSG.remindMenu(s));
    save({ type: 'wa', t: now(), ev: 'reminder', key: s.key, ok });
  }
}, 5 * 60e3);
// Correo para Enrique Espejo, días hábiles a las 9:00: a quién escribirle hoy desde su WhatsApp y qué decirle.
function sugerido(s) {
  const n = firstOf(s) || (s.nombreForm || '').split(' ')[0] || '';
  return s.done
    ? `Hola${n ? ' ' + n : ''}, soy Enrique Espejo de Selva. Pasaste por nuestro stand en la PBF y vi tu diagnóstico: ${s.hallazgo}. ¿Te muestro en 30 minutos cómo lo resolvemos? Elige el horario aquí: ${CAL}`
    : `Hola${n ? ' ' + n : ''}, soy Enrique Espejo de Selva. Pasaste por nuestro stand en la PBF y te mandamos la información por aquí. ¿Qué te gustaría resolver primero en tu negocio: que más clientes te encuentren en Google y en las IA, o ahorrar tiempo con una web, app o automatización?`;
}
async function digest(force) {
  const t = Date.now(); const dow = new Date(t - LIMA).getUTCDay();
  const hoy0 = limaAt(t, 0, 0, 0);
  const rows = [...wast.values()].filter(s => !s.digest && s.stage !== 'baja' && s.t < hoy0).sort((a, b) => a.t - b.t);
  if (!rows.length) return { n: 0 };
  if (!force && (dow === 0 || dow === 6)) return { n: 0 };
  const INT = { seo: 'Google e IA (SEO/GEO)', dev: 'Web, app o automatización', info: 'Conocer Selva' };
  const tel = s => s.phone ? '+' + s.phone.replace(/^(51)(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3 $4') : 'sin número visible';
  const cards = rows.map(s => `<div style="border:1px solid #d9dccf;border-radius:10px;padding:14px 16px;margin:0 0 14px">
<p style="margin:0 0 4px;font-size:16px"><b>${esc(s.nombreForm || s.name || 'Sin nombre')}</b>${s.empresa ? ' · ' + esc(s.empresa) : ''} · ${esc(tel(s))}</p>
<p style="margin:0 0 4px;font-size:13px;color:#4b5145">Interés: ${esc(INT[s.choice] || 'no eligió opción')} · ${s.done ? `Hizo su diagnóstico (<a href="${s.link}">ver informe</a>)` : 'Aún no hace el diagnóstico'}</p>
<p style="margin:10px 0 6px;font-size:13px;color:#4b5145">Mensaje sugerido:</p>
<p style="margin:0 0 10px;background:#f3f5ec;border-radius:8px;padding:10px 12px;font-size:14px">${esc(sugerido(s))}</p>
${s.phone ? `<a href="https://wa.me/${s.phone}?text=${encodeURIComponent(sugerido(s))}" style="display:inline-block;background:#013A2B;color:#fff;text-decoration:none;font-size:14px;font-weight:700;padding:9px 14px;border-radius:8px">Abrir chat en mi WhatsApp →</a>` : '<span style="font-size:13px;color:#a33">Sin número visible: respóndele desde Boost.</span>'}${s.conv ? ` <a href="https://app-saas.selvagencia.com/dashboard/inbox?conversation=${s.conv}" style="font-size:13px;color:#013A2B;margin-left:10px">Ver en Boost</a>` : ''}</div>`).join('');
  const html = `<div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;padding:20px;color:#13140f"><p style="font-size:15px">Hola Enrique, ${rows.length === 1 ? 'esta persona pidió' : `estas ${rows.length} personas pidieron`} información por WhatsApp en el stand S92. Escríbeles hoy desde tu WhatsApp (913 527 489): el botón abre el chat con el mensaje sugerido, que ya usa lo que hicieron. Después marca la etapa de la oportunidad en Boost para que el seguimiento automático se detenga.</p>${cards}<p style="font-size:12px;color:#6b7064">Si no responden, el sistema les manda dos recordatorios por WhatsApp (día 3 y día 7) y se detiene si contestan, si agendan o si la oportunidad se cierra.</p></div>`;
  const ok = await mail(RESPONSABLE[0], `Escríbeles hoy por WhatsApp: ${rows.length} ${rows.length === 1 ? 'visitante' : 'visitantes'} del stand`, html, { from: FROM_PERSON, to: RESPONSABLE });
  if (ok) { rows.forEach(s => s.digest = t); wastSave(); }
  save({ type: 'wa', t: now(), ev: 'digest', n: rows.length, ok });
  return { n: rows.length, ok };
}
setInterval(() => { const m = limaMin(Date.now()); if (m >= 9 * 60 && m < 9 * 60 + 10) digest(false).catch(e => log('digest', e.message)); }, 5 * 60e3);

// ---------- cierre de las auditorías (17-oct-2026, fin de la feria) ----------
const CLOSE_AT = Date.parse(process.env.PBF_CLOSE_AT || '2026-10-18T00:30:00Z'); // 17-oct 19:30 Lima (cierre pedido por Enrique)
const isClosed = () => Date.now() >= CLOSE_AT;
const CLOSED_MSG = `Las auditorías gratuitas estuvieron disponibles hasta el 17 de octubre. Igual queremos ayudarte: agenda 30 minutos sin costo con Enrique Barraza aquí: ${CAL}`;
const FLOWTXT = { seo: 'cómo te encuentran tus clientes en Google y en la IA, y qué harías primero para aparecer.', dev: 'qué se puede automatizar en tu negocio y por dónde conviene empezar.' };
// ---------- servidor ----------
const pages = { '/pbf-seo': 'seo.html', '/pbf-dev': 'dev.html' };
const NOWEB = /^(no|ninguna|ninguno|nop|na|n\/a|-+|\.+|sin web|no tengo|no tengo web|aun no|aún no)$/i;
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname.replace(/\/+$/, '') || '/';
  try {
    if (req.method === 'GET' && pages[p] && isClosed() && !u.searchParams.get('r')) {
      const h = fs.readFileSync(path.join(PUB, 'closed.html'), 'utf8').replace(/__CAL__/g, CAL).replace(/__FLOWTXT__/g, FLOWTXT[p === '/pbf-dev' ? 'dev' : 'seo']);
      return send(res, 200, h, 'text/html');
    }
    if (req.method === 'POST' && isClosed() && (p === '/pbf-api/lead' || p === '/pbf-api/verify' || p === '/pbf-api/resend' || p === '/pbf-api/seo/start' || p === '/pbf-api/dev/start')) {
      save({ type: 'closed_try', t: now(), p, ip: ipOf(req) });
      return send(res, 410, { error: CLOSED_MSG, closed: true, cal: CAL });
    }
    if (req.method === 'GET' && pages[p]) {
      let h = fs.readFileSync(path.join(PUB, pages[p]), 'utf8').replace(/__CAL__/g, CAL).replace(/__WA__/g, WA);
      return send(res, 200, h, 'text/html');
    }
    if (req.method === 'GET' && p === '/pbf-api/logo.png') { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' }); return res.end(fs.readFileSync(path.join(PUB, 'logo.png'))); }
    if (p === '/pbf-api/health') return send(res, 200, { ok: true, jobs: jobs.size, leads: leads.size, wa: !!(EVO_URL && EVO_KEY) });
    if (req.method === 'POST' && p === '/pbf-api/lead') {
      const b = await body(req);
      const ip = ipOf(req); const stand = !!(STAND_KEY && b.k && b.k === STAND_KEY);
      const ws = b.w ? waById(String(b.w)) : null; const viaWa = !!(ws && ws.phone && normWa(ws.phone) === normWa(b.whatsapp));
      if (!stand && !viaWa && limited(ip)) return send(res, 429, { error: 'Demasiados intentos. Inténtalo en unos minutos.' });
      if (b.hp) return send(res, 200, { id: 'x', verify: true });
      const lead = { id: crypto.randomBytes(9).toString('base64url'), flow: b.flow === 'dev' ? 'dev' : 'seo', nombre: clip(b.nombre, 80), empresa: clip(b.empresa, 100), email: clip(b.email, 120).toLowerCase(), whatsapp: clip(b.whatsapp, 30), consent: !!b.consent, ip, ref: clip(b.ref, 200), utm: b.utm && typeof b.utm === 'object' ? Object.fromEntries(Object.entries(b.utm).slice(0, 6).map(([k, v]) => [clip(k, 30), clip(v, 80)])) : {}, t: now() };
      if (!lead.nombre || !lead.empresa || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lead.email) || lead.whatsapp.replace(/\D/g, '').length < 7 || !lead.consent)
        return send(res, 400, { error: 'Revisa tus datos.' });
      if (DISPOSABLE.has(lead.email.split('@')[1])) return send(res, 400, { error: 'Usa un correo que revises: ahí te llega el código y el diagnóstico.' });
      const uk = usedKey(keysOf(lead.flow, lead.email, lead.whatsapp)); if (uk) { save({ type: 'blocked', t: now(), flow: lead.flow, email: lead.email, wa: lead.whatsapp, ip, why: uk }); return send(res, 409, { error: REPEAT(lead.flow, uk) }); }
      lead.stand = stand; if (stand) lead.utm = Object.assign({}, lead.utm, { utm_medium: 'stand' });
      leads.set(lead.id, lead); save(Object.assign({ type: 'lead' }, lead, { code: undefined }));
      if (viaWa) { lead.verified = true; lead.wst = ws.key; ws.lead = lead.id; lead.utm = Object.assign({}, lead.utm, { utm_source: 'whatsapp', utm_medium: 'stand' }); wastSave(); save({ type: 'verified', t: now(), lead: lead.id, email: lead.email, how: 'wa' }); return send(res, 200, { id: lead.id, verify: false }); }
      if (preverified.has(normEmail(lead.email))) { lead.verified = true; save({ type: 'verified', t: now(), lead: lead.id, email: lead.email, how: 'preverify' }); return send(res, 200, { id: lead.id, verify: false }); }
      if (!(await sendCode(lead))) return send(res, 502, { error: 'No pudimos enviarte el código. Revisa tu correo e inténtalo otra vez.' });
      setTimeout(() => { if (lead.verified && !lead.started) boost(lead, { notes: `PBF 2026 · ${lead.flow} · verificó su correo pero no completó el análisis` }); }, 10 * 60e3);
      return send(res, 200, { id: lead.id, verify: true });
    }
    if (req.method === 'POST' && p === '/pbf-api/verify') {
      const b = await body(req); const lead = leads.get(b.id);
      if (!lead) return send(res, 400, { error: 'Vuelve a escribir tus datos.' });
      if (lead.verified) return send(res, 200, { ok: true });
      const cod = String(b.code || '').replace(/\D/g, '');
      if ((lead.allTries = (lead.allTries || 0) + 1) > 10) return send(res, 429, { error: 'Demasiados intentos. Acércate al stand o escríbenos por WhatsApp.' });
      if (MASTER && cod === MASTER) { lead.verified = true; lead.code = null; save({ type: 'verified', t: now(), lead: lead.id, email: lead.email, how: 'master' }); return send(res, 200, { ok: true }); }
      if (!lead.code || Date.now() > lead.codeExp) return send(res, 400, { error: 'El código venció. Pide uno nuevo.' });
      if ((lead.tries = (lead.tries || 0) + 1) > 5) return send(res, 429, { error: 'Demasiados intentos. Pide un código nuevo.' });
      if (hashCode(lead.id, String(b.code || '').replace(/\D/g, '')) !== lead.code) return send(res, 400, { error: 'Ese código no coincide. Revisa el correo más reciente.' });
      lead.verified = true; lead.code = null; save({ type: 'verified', t: now(), lead: lead.id, email: lead.email });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/pbf-api/resend') {
      const b = await body(req); const lead = leads.get(b.id);
      if (!lead || lead.verified) return send(res, 400, { error: 'Vuelve a escribir tus datos.' });
      if ((lead.sends || 0) >= 4) return send(res, 429, { error: 'Ya te enviamos varios códigos. Revisa spam o escríbenos por WhatsApp.' });
      if (Date.now() - (lead.lastSend || 0) < 45e3) return send(res, 429, { error: 'Espera unos segundos antes de pedir otro código.' });
      if (!(await sendCode(lead))) return send(res, 502, { error: 'No pudimos enviarte el código. Inténtalo otra vez.' });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (p === '/pbf-api/seo/start' || p === '/pbf-api/dev/start')) {
      const b = await body(req); const lead = leads.get(b.id);
      if (!lead) return send(res, 400, { error: 'Primero completa tus datos.' });
      if (!lead.verified) return send(res, 403, { error: 'Primero confirma el código que te enviamos al correo.' });
      if (lead.started) return send(res, 409, { error: 'Ya iniciamos tu análisis.' });
      let input;
      if (p.includes('/seo/')) {
        let web = clip(b.web, 120); if (NOWEB.test(web.trim()) || !domainOf(web).includes('.')) web = '';
        input = { empresa: lead.empresa, servicio: clip(b.servicio, 160), ciudad: clip(b.ciudad, 60) || 'Lima', web };
        if (input.servicio.length < 3) return send(res, 400, { error: 'Cuéntanos qué vendes.' });
      } else {
        const arr = (a, n) => (Array.isArray(a) ? a : []).slice(0, n).map(x => clip(x, 80)).filter(Boolean);
        input = { empresa: lead.empresa, rubro: clip(b.rubro, 60), equipo: clip(b.equipo, 20), dolores: arr(b.dolores, 4), hoy: arr(b.hoy, 5), frase: clip(b.frase, 400) };
        if (!input.dolores.length && !input.frase) return send(res, 400, { error: 'Cuéntanos qué te quita tiempo.' });
      }
      const fl = p.includes('/seo/') ? 'seo' : 'dev'; const dom = fl === 'seo' && input.web ? domainOf(input.web) : '';
      const ks = keysOf(fl, lead.email, lead.whatsapp, dom);
      const uk = usedKey(ks); if (uk) { save({ type: 'blocked', t: now(), flow: fl, email: lead.email, wa: lead.whatsapp, dom, why: uk }); return send(res, 409, { error: REPEAT(fl, uk) }); }
      markUsed(ks, Date.now()); lead.keys = ks; save({ type: 'start', t: now(), lead: lead.id, flow: fl, email: lead.email, wa: lead.whatsapp, dom, input });
      const jid = await startJob(lead, fl, input);
      return send(res, 200, { job: jid });
    }
    const m = p.match(/^\/pbf-api\/job\/([\w-]{6,20})$/);
    if (req.method === 'GET' && m) {
      const j = loadJob(m[1]); if (!j) return send(res, 404, { error: 'no existe' });
      return send(res, 200, Object.assign({}, j, { email: j.lead.email, empresa: j.lead.empresa, nombre: j.lead.nombre }));
    }
    if (req.method === 'POST' && p === '/pbf-api/wa-hook') {
      if (!HOOK_KEY || req.headers['x-pbf-hook'] !== HOOK_KEY) return send(res, 403, { error: 'no' });
      const b = await body(req); return send(res, 200, waHook(b));
    }
    if (req.method === 'GET' && p === '/pbf-api/wa-prefill') {
      const s = waById(String(u.searchParams.get('w') || '')); if (!s) return send(res, 404, { error: 'no' });
      const ph = s.phone && s.phone.startsWith('51') && s.phone.length === 11 ? s.phone.slice(2) : (s.phone ? '+' + s.phone : '');
      return send(res, 200, { nombre: s.name || '', whatsapp: ph });
    }
    if (p === '/pbf-api/admin/wa' && ADMIN && u.searchParams.get('k') === ADMIN) {
      if (u.searchParams.get('digest') === '1') return send(res, 200, await digest(true));
      if (u.searchParams.get('del')) { const ok = wast.delete(u.searchParams.get('del')); wastSave(); return send(res, 200, { ok }); }
      return send(res, 200, [...wast.values()]);
    }
    if (p === '/pbf-api/admin/verify' && ADMIN && u.searchParams.get('k') === ADMIN) {
      const em = normEmail(u.searchParams.get('email') || ''); if (!em) return send(res, 400, { error: 'falta email' });
      preverified.add(em); save({ type: 'preverify', t: now(), email: em });
      let n = 0; for (const L of leads.values()) if (normEmail(L.email) === em && !L.verified) { L.verified = true; L.code = null; save({ type: 'verified', t: now(), lead: L.id, email: L.email, how: 'admin' }); n++; }
      return send(res, 200, { ok: true, email: em, leads_habilitados: n });
    }
    if (p === '/pbf-api/admin/rerun' && ADMIN && u.searchParams.get('k') === ADMIN) {
      // Rehace un análisis que se cortó (p. ej. por un reinicio): usa el lead ya verificado.
      const L = leads.get(u.searchParams.get('lead') || ''); if (!L) return send(res, 404, { error: 'lead no está en memoria' });
      const q = k => clip(u.searchParams.get(k) || '', 160);
      const input = { empresa: L.empresa, servicio: q('servicio'), ciudad: q('ciudad') || 'Lima', web: q('web') };
      if (input.servicio.length < 3) return send(res, 400, { error: 'falta servicio' });
      save({ type: 'rerun', t: now(), lead: L.id, flow: 'seo', input });
      const jid = await startJob(L, 'seo', input); return send(res, 200, { job: jid });
    }
    if (p === '/pbf-api/admin/leads' && ADMIN && u.searchParams.get('k') === ADMIN) {
      const rows = fs.existsSync(LEADS) ? fs.readFileSync(LEADS, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
      return send(res, 200, rows);
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { log('req err', p, e.message); send(res, 500, { error: 'Error. Inténtalo de nuevo.' }); }
}).listen(PORT, () => log('pbf on', PORT));

setInterval(() => { const t = Date.now(); for (const [k, j] of jobs) if (t - j.t0 > 6 * 3600e3) jobs.delete(k); }, 600e3);
