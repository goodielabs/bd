// =============================================================
//  会议/展会 嘉宾信息挖掘 -> 写入飞书多维表格
//  零依赖（不需要 npm install），可直接拖到 Netlify 部署
//
//  抽取引擎（按优先级，配哪个用哪个）：
//    1) GROQ_API_KEY      -> Groq（免费、key 好拿、最快，推荐）
//    2) GEMINI_API_KEY    -> Google Gemini（需 AIza 开头的 key）
//    3) ANTHROPIC_API_KEY -> Claude
//    4) 都没配             -> 规则抽取（仅结构化数据网站，效果有限）
//
//  页面渲染：
//    默认 auto —— 直连抓取；若内容太少（疑似 JS 渲染）自动改用 Jina Reader 重抓。
//    USE_JINA=force 始终用 Jina（最稳，限速更紧）；USE_JINA=0 关闭 Jina。
//    JINA_API_KEY 选填，填了限额更高。
// =============================================================

const FEISHU = 'https://open.feishu.cn/open-apis';

// 飞书表格列名（必须与你表格里的列名一模一样）
const F = {
  name: '姓名', title: '职位', company: '公司',
  linkedin: '领英', email: '邮箱', source: '来源', scrapedAt: '抓取时间',
};

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const LINKEDIN_RE = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|pub)\/[A-Za-z0-9\-_%.]+/gi;

const SYSTEM = [
  '你是一个严谨的信息抽取器。从给定的会议/展会网页文本中，抽取所有演讲嘉宾(speakers)。',
  '只返回 JSON，不要任何解释、不要 markdown 代码块。格式严格为：',
  '{"speakers":[{"name":"","title":"","company":"","linkedin":"","email":""}]}',
  '规则：',
  '- name 必填；找不到的字段一律留空字符串 ""。',
  '- linkedin 必须是完整的 linkedin.com 个人主页 URL，否则留空。',
  '- email 必须是文本中真实出现的邮箱，绝不允许编造，否则留空。',
  '- 当文本中列出了一批邮箱/领英链接时，按姓名拼写把它们匹配到对应的人。',
  '- 不要把主办方、赞助商、导航菜单、版权信息当成嘉宾。',
  '- 同一个人只保留一条，合并其信息。',
].join('\n');

// -------------------- 主入口 --------------------
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: '请求体不是合法 JSON' }); }

  const url = (body.url || '').trim();
  const deepScan = !!body.deepScan;
  const preview = !!body.preview;
  const maxDetailPages = Math.max(0, Math.min(parseInt(body.maxDetailPages, 10) || 6, 12));
  const forceJina = !!(body.forceJina || body.jina);
  const enrichLinkedin = !!body.enrichLinkedin;
  if (!/^https?:\/\//i.test(url)) return json(400, { ok: false, error: '请输入有效的网址（要带 http:// 或 https://）' });

  const warnings = [];

  // 抽取引擎选择
  const groqKey = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  let cfg = null;
  if (groqKey) cfg = { provider: 'groq', key: groqKey, model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile' };
  else if (geminiKey) cfg = { provider: 'gemini', key: geminiKey, model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' };
  else if (anthropicKey) cfg = { provider: 'anthropic', key: anthropicKey, model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6' };

  // 渲染选择
  const jinaKey = process.env.JINA_API_KEY || '';
  let jinaMode = process.env.USE_JINA === '0' ? 'off' : (process.env.USE_JINA === 'force' ? 'force' : 'auto');
  if (forceJina) jinaMode = 'force';

  // 1) 抓主页面
  let main;
  try { main = await getPage(url, { timeoutMs: 9000, jinaMode, jinaKey }); }
  catch (e) { return json(502, { ok: false, error: '抓取页面失败：' + e.message }); }
  if (!main.text) return json(502, { ok: false, error: '抓取页面失败：直连与渲染都没拿到内容' });
  if (main.via === 'jina') warnings.push('该页面疑似 JS 渲染，已自动用 Jina Reader 重新抓取。');

  const corpusParts = [`# 主页面：${url}\n${main.text.slice(0, 60000)}`];
  const mainBlob = main.html + '\n' + main.text;
  const mainEmails = uniq((mainBlob.match(EMAIL_RE) || []).filter(isRealEmail));
  const mainLinks = uniq(mainBlob.match(LINKEDIN_RE) || []);
  if (mainEmails.length) corpusParts.push('页面中发现的邮箱：' + mainEmails.join(', '));
  if (mainLinks.length) corpusParts.push('页面中发现的领英：' + mainLinks.join(', '));

  // 2) 深度扫描（可选）
  if (deepScan) {
    const links = findDetailLinks(main.html, main.text, url).slice(0, maxDetailPages);
    if (links.length) {
      const concurrency = (jinaMode === 'force' || jinaKey) ? 2 : 3;
      const subs = await mapLimit(links, concurrency, async (link) => {
        try {
          const p = await getPage(link, { timeoutMs: 7000, jinaMode, jinaKey });
          if (!p.text) return null;
          let s = `# 子页面：${link}\n${p.text.slice(0, 6000)}`;
          const blob = p.html + '\n' + p.text;
          const em = uniq((blob.match(EMAIL_RE) || []).filter(isRealEmail));
          const li = uniq(blob.match(LINKEDIN_RE) || []);
          if (em.length) s += '\n邮箱：' + em.join(', ');
          if (li.length) s += '\n领英：' + li.join(', ');
          return s;
        } catch { return null; }
      });
      corpusParts.push(...subs.filter(Boolean));
    } else {
      warnings.push('深度扫描：没找到明显的嘉宾详情页链接，只用了主页面。');
    }
  }

  const corpus = corpusParts.join('\n\n');

  // 3) 抽取（带超限自动裁剪重试，解决 Groq 每分钟 token 上限）
  let speakers = [];
  if (cfg) {
    try { speakers = await extractWithRetry(corpus, cfg, warnings); }
    catch (e) { warnings.push(`AI 抽取失败(${cfg.provider})，改用规则抽取：` + e.message); }
  } else {
    warnings.push('未配置 AI Key（GROQ_API_KEY / GEMINI_API_KEY / ANTHROPIC_API_KEY），只能用规则抽取，效果有限。建议配置 Groq 免费 Key。');
  }
  if (!speakers.length) speakers = heuristicExtract(main.html, mainEmails, mainLinks);
  speakers = normalizeAndDedupe(speakers);

  // 3.5) 联网补全领英（可选）：对没有领英的人，用"姓名+公司"搜索
  if (enrichLinkedin && speakers.length) {
    const before = speakers.filter(s => s.linkedin).length;
    await enrichLinkedIn(speakers, jinaKey, 12);
    const after = speakers.filter(s => s.linkedin).length;
    warnings.push(`联网补领英：新增 ${after - before} 个（最多查前 12 位；同名可能有误差，请抽查核对）。`);
  }

  if (!speakers.length) {
    return json(200, { ok: true, found: 0, written: 0, speakers: [],
      warnings: [...warnings, '未能提取到嘉宾。可换用嘉宾列表页直链、开启深度扫描，或配置 AI Key 后重试。'] });
  }
  if (preview) {
    return json(200, { ok: true, found: speakers.length, written: 0, speakers, warnings: [...warnings, '预览模式：未写入飞书。'] });
  }

  // 4) 写入飞书
  try {
    const written = await writeToFeishu(speakers, url);
    return json(200, { ok: true, found: speakers.length, written, speakers, warnings });
  } catch (e) {
    return json(200, { ok: true, found: speakers.length, written: 0, speakers, warnings: [...warnings, '写入飞书失败：' + e.message] });
  }
};

// -------------------- 抓取 --------------------
async function getPage(url, { timeoutMs = 9000, jinaMode = 'auto', jinaKey = '' } = {}) {
  let html = '', text = '', via = 'direct';
  if (jinaMode !== 'force') {
    try { html = await fetchDirect(url, timeoutMs); text = stripHtml(html); }
    catch { html = ''; text = ''; }
  }
  const thin = text.replace(/\s/g, '').length < 500;
  if (jinaMode === 'force' || (jinaMode === 'auto' && thin)) {
    try {
      const md = await fetchJina(url, timeoutMs + 5000, jinaKey);
      if (md && md.length > text.length) { text = md; via = 'jina'; }
    } catch { /* 保留直连结果 */ }
  }
  return { html, text, via };
}

async function fetchDirect(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow', signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en,zh-CN;q=0.9,zh;q=0.8',
      },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally { clearTimeout(t); }
}

async function fetchJina(url, timeoutMs, key) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { 'Accept': 'text/plain' };
    if (key) headers['Authorization'] = 'Bearer ' + key;
    const res = await fetch('https://r.jina.ai/' + url, { signal: ctrl.signal, headers });
    if (!res.ok) throw new Error('Jina HTTP ' + res.status);
    return await res.text();
  } finally { clearTimeout(t); }
}

// -------------------- HTML 处理（零依赖） --------------------
function stripHtml(html) {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(s).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

// 从 HTML 的 <a> 和 markdown 的 [..](url) 里收集链接候选
function collectLinkCandidates(html, mdText) {
  const pairs = [];
  let m;
  const aRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = aRe.exec(html))) pairs.push({ href: m[1], text: stripHtml(m[2]) });
  const mdRe = /\[([^\]]{0,80})\]\((https?:\/\/[^)\s]+)\)/g;
  while ((m = mdRe.exec(mdText))) pairs.push({ href: m[2], text: m[1] });
  return pairs;
}

function findDetailLinks(html, mdText, baseUrl) {
  const base = new URL(baseUrl);
  const out = new Set();
  for (const { href, text } of collectLinkCandidates(html || '', mdText || '')) {
    let u;
    try { u = new URL(href, baseUrl); } catch { continue; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    if (u.hostname !== base.hostname) continue;
    const hay = (u.pathname + ' ' + text).toLowerCase();
    if (/(speaker|presenter|panelist|keynote|profile|people|person|faculty|\/bio)/.test(hay)) {
      out.add(u.href.split('#')[0]);
    }
  }
  return [...out];
}

// -------------------- AI 抽取 --------------------
// 超限自动裁剪重试：Groq 免费层每分钟 token 有上限，内容过大时逐级裁短再试
async function extractWithRetry(corpus, cfg, warnings) {
  const caps = [Number(process.env.LLM_MAX_INPUT_CHARS) || 32000, 16000, 8000];
  let lastErr;
  for (let i = 0; i < caps.length; i++) {
    try {
      const r = await llmExtract(corpus.slice(0, caps[i]), cfg);
      if (i > 0) warnings.push(`内容较大，已裁剪到约 ${caps[i]} 字符后成功抽取（可能漏掉靠后的嘉宾；可分页抓取或升级 AI 额度）。`);
      return r;
    } catch (e) {
      lastErr = e;
      // 仅当是"内容过大/限流"类错误才继续裁剪重试，其它错误直接抛出
      if (!/too large|per minute|TPM|rate|413|429|context|token/i.test(e.message)) throw e;
    }
  }
  throw lastErr;
}

async function llmExtract(corpus, cfg) {
  if (cfg.provider === 'groq') return groqExtract(corpus, cfg.key, cfg.model);
  if (cfg.provider === 'gemini') return geminiExtract(corpus, cfg.key, cfg.model);
  return anthropicExtract(corpus, cfg.key, cfg.model);
}

async function groqExtract(corpus, key, model) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: corpus.slice(0, 100000) }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + res.status));
  const text = (((data.choices || [])[0] || {}).message || {}).content || '';
  return parseSpeakers(text);
}

async function geminiExtract(corpus, key, model) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: corpus.slice(0, 120000) }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 8192 },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + res.status));
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  return parseSpeakers(parts.map(p => p.text || '').join(''));
}

async function anthropicExtract(corpus, key, model) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 4096, system: SYSTEM, messages: [{ role: 'user', content: corpus.slice(0, 80000) }] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + res.status));
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return parseSpeakers(text);
}

function parseSpeakers(text) {
  const clean = String(text || '').replace(/```json|```/g, '').trim();
  const start = clean.indexOf('{'), end = clean.lastIndexOf('}');
  if (start < 0 || end < 0) return [];
  const parsed = JSON.parse(clean.slice(start, end + 1));
  return Array.isArray(parsed.speakers) ? parsed.speakers : [];
}

// -------------------- 联网补全领英（免费，用 Jina 搜索） --------------------
async function enrichLinkedIn(speakers, jinaKey, cap) {
  const targets = speakers.filter(s => !s.linkedin && s.name).slice(0, cap);
  await mapLimit(targets, 3, async (s) => {
    const url = await searchLinkedIn(s.name, s.company || '', jinaKey);
    // 只在领英链接的 slug 能对上姓名时才采用，降低同名误配
    if (url && nameMatchesSlug(s.name, url)) s.linkedin = url;
  });
}

async function searchLinkedIn(name, company, jinaKey) {
  const q = `${name} ${company} site:linkedin.com/in`.trim();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const headers = { 'Accept': 'text/plain', 'X-Respond-With': 'no-content' };
    if (jinaKey) headers['Authorization'] = 'Bearer ' + jinaKey;
    const res = await fetch('https://s.jina.ai/' + encodeURIComponent(q), { signal: ctrl.signal, headers });
    if (!res.ok) return '';
    const text = await res.text();
    const m = text.match(LINKEDIN_RE);
    return m ? m[0].replace(/[).,]+$/, '') : '';
  } catch { return ''; }
  finally { clearTimeout(t); }
}

// -------------------- 规则抽取（无 AI Key 时兜底） --------------------
function heuristicExtract(html, emails, linkedins) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html || ''))) {
    try { collectPersons(JSON.parse(m[1].trim()), out); } catch { /* ignore */ }
  }
  for (const p of out) {
    if (!p.linkedin) { const hit = linkedins.find(l => nameMatchesSlug(p.name, l)); if (hit) p.linkedin = hit; }
    if (!p.email) { const hit = emails.find(e => nameMatchesSlug(p.name, e)); if (hit) p.email = hit; }
  }
  return out;
}

function collectPersons(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(n => collectPersons(n, out)); return; }
  const t = node['@type'];
  const types = Array.isArray(t) ? t : [t];
  if (types.includes('Person') && node.name) {
    const sameAs = [].concat(node.sameAs || []);
    out.push({
      name: typeof node.name === 'string' ? node.name : '',
      title: node.jobTitle || '',
      company: (node.worksFor && (node.worksFor.name || (typeof node.worksFor === 'string' ? node.worksFor : ''))) || '',
      linkedin: sameAs.find(u => /linkedin\.com/i.test(u)) || '',
      email: (node.email || '').replace(/^mailto:/i, ''),
    });
  }
  if (node['@graph']) collectPersons(node['@graph'], out);
  ['itemListElement', 'member', 'employee', 'item'].forEach(k => { if (node[k]) collectPersons(node[k], out); });
}

function nameMatchesSlug(name, str) {
  if (!name) return false;
  const parts = name.toLowerCase().split(/\s+/).filter(p => p.length > 1);
  const hay = str.toLowerCase();
  return parts.length >= 1 && parts.every(p => hay.includes(p));
}

// -------------------- 清洗 / 去重 --------------------
function normalizeAndDedupe(arr) {
  const seen = new Set(); const out = [];
  for (const s of arr) {
    const name = String(s.name || '').trim();
    if (!name || name.length > 80) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let linkedin = String(s.linkedin || '').trim();
    if (linkedin && !/linkedin\.com\/(in|pub)\//i.test(linkedin)) linkedin = '';
    let email = String(s.email || '').trim().replace(/^mailto:/i, '');
    if (email && !isRealEmail(email)) email = '';
    out.push({ name, title: String(s.title || '').trim(), company: String(s.company || '').trim(), linkedin, email });
  }
  return out;
}

function isRealEmail(e) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(e)) return false;
  if (/\.(png|jpe?g|gif|webp|svg|css|js|ico)$/i.test(e)) return false;
  if (/(example|sentry|wixpress|domain)\.(com|org)$/i.test(e)) return false;
  return true;
}

// -------------------- 飞书写入 --------------------
async function writeToFeishu(speakers, sourceUrl) {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  const nodeToken = process.env.FEISHU_WIKI_NODE_TOKEN || 'Dr54WYrqkiqCp6koutJcrg7ynDh';
  const tableId = process.env.FEISHU_TABLE_ID || 'tbltOq9dXy3op1FC';
  if (!appId || !appSecret) throw new Error('服务器缺少 FEISHU_APP_ID / FEISHU_APP_SECRET 环境变量');

  const token = await getTenantToken(appId, appSecret);
  const appToken = await resolveAppToken(token, nodeToken);
  const ts = nowCN();
  const records = speakers.map(s => ({ fields: {
    [F.name]: s.name || '', [F.title]: s.title || '', [F.company]: s.company || '',
    [F.linkedin]: s.linkedin || '', [F.email]: s.email || '', [F.source]: sourceUrl, [F.scrapedAt]: ts,
  }}));
  let written = 0;
  for (let i = 0; i < records.length; i += 100) {
    const chunk = records.slice(i, i + 100);
    await feishuJson('POST', `/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`, token, { records: chunk });
    written += chunk.length;
  }
  return written;
}

async function getTenantToken(appId, appSecret) {
  const res = await fetch(FEISHU + '/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error('获取 tenant_access_token 失败：' + data.msg + '（检查 App ID / App Secret）');
  return data.tenant_access_token;
}

async function resolveAppToken(token, nodeToken) {
  const res = await fetch(`${FEISHU}/wiki/v2/spaces/get_node?token=${encodeURIComponent(nodeToken)}&obj_type=wiki`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error('解析知识库节点失败：' + data.msg + '（确认应用已加入该知识库且有可编辑权限）');
  if (!data.data || !data.data.node || !data.data.node.obj_token) throw new Error('未能拿到表格 app_token');
  return data.data.node.obj_token;
}

async function feishuJson(method, path, token, payload) {
  const res = await fetch(FEISHU + path, {
    method, headers: { 'content-type': 'application/json; charset=utf-8', Authorization: 'Bearer ' + token },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`飞书接口返回 code=${data.code} ${data.msg}`);
  return data;
}

// -------------------- 工具 --------------------
function nowCN() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19); }
function uniq(a) { return [...new Set(a)]; }
async function mapLimit(items, limit, fn) {
  const ret = []; let i = 0;
  const n = Math.min(limit, items.length || 1);
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; ret[idx] = await fn(items[idx], idx); }
  }));
  return ret;
}
function json(status, obj) {
  return { statusCode: status, headers: {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  }, body: JSON.stringify(obj) };
}

// 测试钩子（部署时无影响）
if (process.env.NODE_ENV === 'test') {
  module.exports._t = { stripHtml, findDetailLinks, collectPersons, normalizeAndDedupe, isRealEmail, nameMatchesSlug, parseSpeakers };
}
