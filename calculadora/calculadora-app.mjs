import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

const codeDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DFS_DATA_DIR || path.join(codeDir, 'dados');
const dataFile = path.join(dataDir, 'calculadora.json');
const catalogFile = path.join(dataDir, 'catalogo.json');
const sessionFile = path.join(dataDir, 'painel-sessao.json');
const siteFile = path.join(dataDir, 'painel-site.json');
const htmlFile = path.join(codeDir, 'calculadora.html');
const versionFile = path.join(codeDir, 'app-versao.txt');
const templatesFile = path.join(codeDir, 'budget-templates.json');
const defaultOrigin = 'https://renovanow.online';
const port = 8765;
function loadBudgetTemplates() {
  try {
    return JSON.parse(fs.readFileSync(templatesFile, 'utf8'));
  } catch (e) {
    return { defaults: { CONTAS: 'contas-formal', MONTANTE: 'montante-formal' }, templates: {} };
  }
}

fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, '{}\n');

function readAppVersion() {
  try {
    const text = fs.readFileSync(versionFile, 'utf8').trim().replace(/^\uFEFF/, '');
    return text || '0';
  } catch (e) {
    return '0';
  }
}

function readSite() {
  try { return JSON.parse(fs.readFileSync(siteFile, 'utf8')); } catch (e) { return {}; }
}
function readOrigin() {
  try {
    const saved = readSite();
    const url = new URL(String(saved.origin || ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return defaultOrigin;
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return defaultOrigin;
    return url.origin;
  } catch (e) {
    return defaultOrigin;
  }
}
function readSavedLink() {
  const saved = readSite();
  const link = String(saved.link || '').trim();
  if (link) return link;
  const slug = String(saved.companySlug || '').trim();
  if (slug) return slug;
  return 'elite';
}
function writeOrigin(origin, link) {
  const url = new URL(String(origin || ''));
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('O link da empresa não serve.');
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') throw new Error('O link da empresa não serve.');
  const prev = readSite();
  const nextLink = String(link == null ? (prev.link || '') : link).trim();
  const slug = companySlug(nextLink) || String(prev.companySlug || '').trim() || 'elite';
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(siteFile, JSON.stringify({
    origin: url.origin,
    link: nextLink || slug,
    companySlug: slug,
  }));
  captchaCache = null;
}
function panelOrigin(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : 'https://' + text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return '';
    return url.origin;
  } catch (e) {
    return '';
  }
}
function readSession() {
  try { return JSON.parse(fs.readFileSync(sessionFile, 'utf8')); } catch (e) { return null; }
}
function writeSession(session) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(sessionFile, JSON.stringify(session));
}
function publicSession(session) {
  if (!session || !session.token || !session.userId) return { ok: false };
  return {
    ok: true,
    name: session.name || '',
    email: session.email || '',
    companyId: session.companyId || '',
    companyName: session.companyName || '',
    companySlug: session.companySlug || 'elite',
  };
}
function companySlug(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = text.match(/login\/([^/?#\s]+)/i);
  if (match) return decodeURIComponent(match[1]);
  if (/^https?:\/\//i.test(text)) {
    try {
      const parts = new URL(text).pathname.split('/').filter(Boolean);
      const last = parts[parts.length - 1] || '';
      return last === 'login' ? '' : last;
    } catch (e) { return ''; }
  }
  return text.replace(/^\/+|\/+$/g, '').toLowerCase();
}
function panelRequest(apiPath, payload) {
  const body = new URLSearchParams();
  body.set('action', 'dfs');
  body.set('path', apiPath);
  if (payload && payload.dfs_token) body.set('dfs_token', payload.dfs_token);
  body.set('dfs_json', JSON.stringify(payload || {}));
  const data = body.toString();
  return new Promise((resolve, reject) => {
    const req = https.request(new URL('/wp-admin/admin-ajax.php', readOrigin()), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 60000,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { json = { message: 'O painel respondeu fora do formato esperado.' }; }
        resolve({ status: response.statusCode || 500, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}
function panelGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 20000 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
let captchaCache = null;
async function captchaConfig() {
  if (captchaCache) return captchaCache;
  const origin = readOrigin();
  const json = await panelGet(origin + '/?dfs_api=site');
  captchaCache = {
    enabled: !!json.recaptchaEnabled && !!json.recaptchaSiteKey,
    siteKey: json.recaptchaSiteKey || '',
    origin,
  };
  return captchaCache;
}
function flattenDoc(doc) {
  if (!doc || typeof doc !== 'object') return null;
  let data = doc.data && typeof doc.data === 'object' ? doc.data : doc;
  // Alguns docs vêm aninhados (data.data).
  if (data && data.data && typeof data.data === 'object' && !data.chave && !data.pixKeys && !data.nome && !data.email) {
    data = data.data;
  }
  const id = doc.id || data.id || '';
  return { id, ...data };
}
function rowsOf(result) {
  const json = (result && result.json) || {};
  let docs = json.docs;
  if (!Array.isArray(docs) && json.data && Array.isArray(json.data.docs)) docs = json.data.docs;
  if (!Array.isArray(docs) && Array.isArray(json.data)) docs = json.data;
  if ((result && result.status >= 400) || !Array.isArray(docs)) return [];
  return docs.map(flattenDoc).filter(Boolean);
}
function normalizeGroup(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  const tagged = text.match(/^(lista|grupo)\s*0*(\d+)$/i);
  if (!tagged) return text;
  const kind = tagged[1].toLowerCase() === 'grupo' ? 'Grupo' : 'Lista';
  return kind + ' ' + tagged[2].padStart(2, '0');
}
function rangeGroup(item) {
  const explicit = normalizeGroup(item.categoria || '');
  if (explicit) return explicit;
  const match = String(item.nome || '').trim().match(/\s+((?:lista|grupo)\s*\d+)\s*$/i);
  return match ? normalizeGroup(match[1]) : 'Faixa';
}
function rangeTitle(item) {
  const nome = String(item.nome || '').replace(/\s+/g, ' ').trim();
  const group = rangeGroup(item);
  if (!group || group === 'Faixa') return nome;
  const escaped = group.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return nome.replace(new RegExp('\\s+' + escaped + '\\s*$', 'i'), '').trim() || nome;
}
function rateLabel(item) {
  const mult = Number(item.multiplicador) || 0;
  const taxa = Number(item.taxa) || 0;
  const base = mult.toLocaleString('pt-BR') + ' x ' + taxa.toLocaleString('pt-BR') + '%';
  return item.observacao ? base + ' · ' + item.observacao : base;
}
function pixOff(value) {
  return value === false || value === 0 || value === '0' || String(value || '').toLowerCase() === 'false';
}
function pixChaveOf(item) {
  return String(
    (item && (item.chave || item.pixChave || item.key || item.valor || item.value)) || ''
  ).trim();
}
function pixRow(item, id) {
  if (!item || typeof item !== 'object') return null;
  const chave = pixChaveOf(item);
  if (!chave) return null;
  // Painel: chave ativa entra nas abas marcadas. Sem marca, libera as duas.
  const ativa = !pixOff(item.ativa);
  if (!ativa) return null;
  let contas = item.exibirContas == null && item.exibirMontante == null
    ? true
    : !pixOff(item.exibirContas);
  let montante = item.exibirContas == null && item.exibirMontante == null
    ? true
    : !pixOff(item.exibirMontante);
  // Se veio só uma flag, a outra acompanha a ativa.
  if (item.exibirContas == null && item.exibirMontante != null) contas = montante;
  if (item.exibirMontante == null && item.exibirContas != null) montante = contas;
  if (!contas && !montante) {
    contas = true;
    montante = true;
  }
  const nome = String(item.nomeCompleto || item.nome || item.nomeTitular || item.titular || '').trim();
  const banco = String(item.bancoInstituicao || item.banco || item.instituicao || '').trim();
  return {
    id: String(id || item.id || item.userKeyId || chave),
    tipo: String(item.tipoChave || item.tipo || 'CPF').trim() || 'CPF',
    chave,
    nome: nome || 'Pix',
    banco: banco || '—',
    contas,
    montante,
  };
}
function userInCompany(user, companyId) {
  if (!companyId) return false;
  const wanted = String(companyId);
  if (String(user.companyId || '') === wanted) return true;
  const links = Array.isArray(user.companyLinks) ? user.companyLinks : [];
  return links.some((link) => link && String(link.companyId || '') === wanted);
}
function collectUserPix(user, pushPix) {
  if (!user) return;
  const list = Array.isArray(user.pixKeys) ? user.pixKeys : [];
  if (!list.length && pixChaveOf(user)) {
    pushPix(pixRow({
      tipoChave: user.pixTipoChave || user.tipoChave,
      chave: user.pixChave || user.chave,
      nome: user.name || user.nome || '',
      banco: user.pixBanco || user.banco || '',
      ativa: true,
      exibirContas: true,
      exibirMontante: true,
    }, 'user-' + (user.id || 'me')));
    return;
  }
  list.forEach((item, index) => {
    pushPix(pixRow(item, 'user-' + (user.id || 'me') + '-' + (item.id || item.chave || index)));
  });
}
async function pullCatalog(session) {
  if (!session || !session.token || !session.companyId) {
    return { ok: false, message: 'Entre com o link da empresa para puxar faixa, taxa e Pix.' };
  }
  const companyId = String(session.companyId);
  const filters = [{ field: 'companyId', op: '==', value: companyId }];
  const body = { filters, limit: 0, dfs_token: session.token };
  const budgetId = 'calculator_budget_' + companyId;
  const [rangesRes, campaignsRes, ratesRes, rulesRes, pixRes, pixAllRes, usersRes, meRes, budgetRes] = await Promise.all([
    panelRequest('query', { ...body, collection: 'calculatorRanges' }),
    panelRequest('query', { ...body, collection: 'campaigns' }),
    panelRequest('query', { ...body, collection: 'calculatorMontanteRates' }),
    panelRequest('query', { ...body, collection: 'calculatorMontanteAccountRules' }),
    panelRequest('query', { ...body, collection: 'calculatorPixKeys' }),
    panelRequest('query', { collection: 'calculatorPixKeys', limit: 0, dfs_token: session.token }),
    panelRequest('query', { collection: 'users', limit: 0, dfs_token: session.token }),
    session.userId
      ? panelRequest('read', { collection: 'users', id: session.userId, dfs_token: session.token })
      : Promise.resolve({ status: 404, json: {} }),
    panelRequest('read', { collection: 'settings', id: budgetId, dfs_token: session.token }),
  ]);
  const pix = [];
  const seen = new Set();
  const pushPix = (row) => {
    if (!row || !row.chave) return;
    const key = String(row.tipo || '') + '|' + String(row.chave || '');
    if (seen.has(key)) return;
    seen.add(key);
    pix.push(row);
  };
  const sameCompany = (item) => {
    const cid = String((item && item.companyId) || '');
    return !cid || cid === companyId;
  };
  rowsOf(pixRes).forEach((item) => pushPix(pixRow(item, item.id)));
  // Reforço: coleção inteira (o que a sessão puder ler) e filtra empresa.
  rowsOf(pixAllRes).filter(sameCompany).forEach((item) => pushPix(pixRow(item, item.id)));
  rowsOf(usersRes).filter((user) => userInCompany(user, companyId)).forEach((user) => collectUserPix(user, pushPix));
  const meJson = (meRes && meRes.json) || {};
  const meDoc = (meJson.data && typeof meJson.data === 'object') ? meJson.data : (meJson.exists === false ? null : meJson);
  if (meDoc && typeof meDoc === 'object') {
    collectUserPix({ id: session.userId || meJson.id, ...meDoc }, pushPix);
  }
  pix.sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'));
  const packed = loadBudgetTemplates();
  const budgetDoc = (budgetRes && budgetRes.json && budgetRes.json.data) || {};
  const budget = {
    templateIdContas: String(budgetDoc.templateIdContas || packed.defaults.CONTAS || 'contas-formal'),
    templateIdMontante: String(budgetDoc.templateIdMontante || packed.defaults.MONTANTE || 'montante-formal'),
    messageContas: String(budgetDoc.messageContas || ''),
    messageMontante: String(budgetDoc.messageMontante || ''),
    templateBodies: budgetDoc.templateBodies && typeof budgetDoc.templateBodies === 'object' ? budgetDoc.templateBodies : {},
    templates: packed.templates || {},
    defaults: packed.defaults || {},
  };
  const catalog = {
    ok: true,
    companyId: session.companyId,
    companyName: session.companyName || '',
    companySlug: session.companySlug || '',
    budget,
    ranges: rowsOf(rangesRes).map((item) => ({
      id: item.id,
      group: rangeGroup(item),
      name: rangeTitle(item),
      price: Number(item.valor) || 0,
      order: item.order,
    })).filter((item) => item.name).sort((a, b) => {
      const ao = a.order != null ? Number(a.order) : 999999;
      const bo = b.order != null ? Number(b.order) : 999999;
      if (ao !== bo) return ao - bo;
      return a.name.localeCompare(b.name, 'pt-BR');
    }),
    campaigns: rowsOf(campaignsRes).map((item) => ({
      id: item.id,
      status: item.status || '',
      panelKind: item.panelKind || 'dia',
      category: item.category || '',
      startDate: item.startDate || '',
      endDate: item.endDate || '',
      startTime: item.startTime || '',
      endTime: item.endTime || '',
      weekDays: Array.isArray(item.weekDays) ? item.weekDays : [],
      discountContas: item.discountContas,
      discountMontantes: item.discountMontantes,
      groupDiscounts: Array.isArray(item.groupDiscounts) ? item.groupDiscounts : [],
    })),
    rates: rowsOf(ratesRes).map((item) => ({
      id: item.id,
      label: rateLabel(item),
      taxa: Number(item.taxa) || 0,
      order: item.order,
    })).sort((a, b) => {
      const ao = a.order != null ? Number(a.order) : 999999;
      const bo = b.order != null ? Number(b.order) : 999999;
      if (ao !== bo) return ao - bo;
      return a.label.localeCompare(b.label, 'pt-BR');
    }),
    rules: rowsOf(rulesRes).map((item) => ({
      montante: Number(item.montante) || 0,
      qtdContas: Number(item.qtdContas) || 0,
    })).filter((item) => item.montante > 0).sort((a, b) => a.montante - b.montante),
    pix,
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(catalogFile, JSON.stringify(catalog));
  return catalog;
}
function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/dados/calculadora.json' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(dataFile));
    return;
  }
  if (url === '/dados/calculadora.json' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(dataFile, Buffer.concat(chunks));
      res.writeHead(204);
      res.end();
    });
    return;
  }
  if (url === '/painel/captcha' && req.method === 'GET') {
    captchaConfig().then((cfg) => sendJson(res, 200, cfg)).catch(() => sendJson(res, 200, { enabled: false, siteKey: '', origin: readOrigin() }));
    return;
  }
  if (url === '/painel/site' && req.method === 'GET') {
    const saved = readSite();
    sendJson(res, 200, {
      origin: readOrigin(),
      link: readSavedLink(),
      companySlug: String(saved.companySlug || companySlug(readSavedLink()) || 'elite'),
    });
    return;
  }
  if (url === '/painel/site' && req.method === 'POST') {
    readBody(req).then((body) => {
      try {
        const raw = String(body.link || body.origin || body.companySlug || '').trim();
        const fromBody = panelOrigin(body.origin || '');
        const fromRaw = /^https?:\/\//i.test(raw) || /\./.test(raw.split('/')[0] || '') ? panelOrigin(raw) : '';
        const origin = fromBody || fromRaw || readOrigin();
        if (!origin) {
          sendJson(res, 400, { message: 'O link da empresa não serve. Use o endereço do site, com https.' });
          return;
        }
        writeOrigin(origin, raw || origin);
        const saved = readSite();
        sendJson(res, 200, { ok: true, origin, link: saved.link || raw, companySlug: saved.companySlug || 'elite' });
      } catch (e) {
        sendJson(res, 400, { message: e.message || 'Não guardei o link do site.' });
      }
    }).catch(() => sendJson(res, 400, { message: 'Não li o link do site.' }));
    return;
  }
  if (url === '/painel/status' && req.method === 'GET') {
    sendJson(res, 200, publicSession(readSession()));
    return;
  }
  if (url === '/painel/sair' && req.method === 'POST') {
    try { fs.unlinkSync(sessionFile); } catch (e) {}
    sendJson(res, 200, { ok: true });
    return;
  }
  if (url === '/painel/entrar' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      try {
        const rawLink = String(body.link || body.companySlug || body.origin || '').trim();
        const fromBody = panelOrigin(body.origin || '');
        const fromRaw = /^https?:\/\//i.test(rawLink) || /\./.test(rawLink.split('/')[0] || '') ? panelOrigin(rawLink) : '';
        const origin = fromBody || fromRaw || readOrigin();
        if (origin) writeOrigin(origin, rawLink || origin);
        const slug = companySlug(rawLink) || 'elite';
        const result = await panelRequest('auth/login', {
          email: String(body.email || '').trim(),
          password: String(body.password || ''),
          companySlug: slug,
          recaptchaToken: String(body.recaptchaToken || ''),
        });
        const json = result.json || {};
        if (result.status >= 400 || !json.token) {
          sendJson(res, result.status >= 400 ? result.status : 401, { message: json.message || 'E-mail ou senha inválidos.' });
          return;
        }
        const profile = json.profile || {};
        const links = Array.isArray(profile.companyLinks) ? profile.companyLinks : [];
        const link = links.find((item) => item && item.companyId && item.companyId === profile.companyId) || links[0] || null;
        writeSession({
          token: json.token,
          userId: (json.user && json.user.uid) || profile.id || '',
          name: (json.user && json.user.displayName) || profile.name || '',
          email: (json.user && json.user.email) || '',
          companyId: profile.companyId || (link && link.companyId) || '',
          companyName: (link && (link.companyName || link.name)) || profile.companyName || slug,
          companySlug: slug,
        });
        const session = readSession();
        try { await pullCatalog(session); } catch (e) {}
        sendJson(res, 200, publicSession(session));
      } catch (e) {
        sendJson(res, 502, { message: 'Não consegui falar com o painel.' });
      }
    }).catch(() => sendJson(res, 400, { message: 'Não li o login.' }));
    return;
  }
  if (url === '/site/catalogo' && req.method === 'GET') {
    const session = readSession();
    if (!session || !session.token) {
      sendJson(res, 200, { ok: false });
      return;
    }
    pullCatalog(session).then((catalog) => sendJson(res, 200, catalog)).catch(() => {
      try { sendJson(res, 200, JSON.parse(fs.readFileSync(catalogFile, 'utf8'))); }
      catch (e) { sendJson(res, 200, { ok: false, message: 'O site não devolveu o cadastro.' }); }
    });
    return;
  }
  if (url === '/app/versao' && req.method === 'GET') {
    sendJson(res, 200, { version: readAppVersion() });
    return;
  }
  if ((url === '/' || url === '/calculadora.html') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(htmlFile));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, '127.0.0.1');
