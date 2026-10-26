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
const defaultOrigin = 'https://renovanow.online';
const port = 8765;

fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, '{}\n');

function readOrigin() {
  try {
    const saved = JSON.parse(fs.readFileSync(siteFile, 'utf8'));
    const url = new URL(String(saved.origin || ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return defaultOrigin;
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return defaultOrigin;
    return url.origin;
  } catch (e) {
    return defaultOrigin;
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
  const json = await panelGet(readOrigin() + '/?dfs_api=site');
  captchaCache = {
    enabled: !!json.recaptchaEnabled && !!json.recaptchaSiteKey,
    siteKey: json.recaptchaSiteKey || '',
  };
  return captchaCache;
}
function rowsOf(result) {
  const json = result.json || {};
  if (result.status >= 400 || !Array.isArray(json.docs)) return [];
  return json.docs.map((doc) => ({ id: doc.id, ...(doc.data || {}) }));
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
function pixRow(item, id) {
  const chave = String(item.chave || '').trim();
  if (!chave || item.ativa === false) return null;
  return {
    id: id || item.id || chave,
    tipo: item.tipoChave || 'CPF',
    chave,
    nome: String(item.nomeCompleto || item.nome || '').trim(),
    banco: String(item.bancoInstituicao || item.banco || '').trim(),
    contas: item.exibirContas !== false,
    montante: item.exibirMontante !== false,
  };
}
function userInCompany(user, companyId) {
  if (!companyId) return false;
  if (String(user.companyId || '') === companyId) return true;
  const links = Array.isArray(user.companyLinks) ? user.companyLinks : [];
  return links.some((link) => link && String(link.companyId || '') === companyId);
}
async function pullCatalog(session) {
  if (!session || !session.token || !session.companyId) {
    return { ok: false, message: 'Entre com o link da empresa para puxar faixa, taxa e Pix.' };
  }
  const filters = [{ field: 'companyId', op: '==', value: session.companyId }];
  const body = { filters, limit: 0, dfs_token: session.token };
  const [rangesRes, campaignsRes, ratesRes, rulesRes, pixRes, usersRes] = await Promise.all([
    panelRequest('query', { ...body, collection: 'calculatorRanges' }),
    panelRequest('query', { ...body, collection: 'campaigns' }),
    panelRequest('query', { ...body, collection: 'calculatorMontanteRates' }),
    panelRequest('query', { ...body, collection: 'calculatorMontanteAccountRules' }),
    panelRequest('query', { ...body, collection: 'calculatorPixKeys' }),
    panelRequest('query', { collection: 'users', limit: 0, dfs_token: session.token }),
  ]);
  const pix = [];
  const seen = new Set();
  const pushPix = (row) => {
    if (!row || !row.chave) return;
    const key = row.tipo + '|' + row.chave;
    if (seen.has(key)) return;
    seen.add(key);
    pix.push(row);
  };
  rowsOf(pixRes).forEach((item) => pushPix(pixRow(item, item.id)));
  rowsOf(usersRes).filter((user) => userInCompany(user, session.companyId)).forEach((user) => {
    const list = Array.isArray(user.pixKeys) ? user.pixKeys : [];
    if (!list.length && String(user.pixChave || '').trim()) {
      pushPix(pixRow({
        tipoChave: user.pixTipoChave,
        chave: user.pixChave,
        nome: user.name || '',
        banco: user.pixBanco,
        exibirContas: true,
        exibirMontante: true,
      }, 'user-' + user.id));
      return;
    }
    list.forEach((item) => pushPix(pixRow(item, 'user-' + user.id + '-' + (item.id || item.chave))));
  });
  pix.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  const catalog = {
    ok: true,
    companyId: session.companyId,
    companyName: session.companyName || '',
    companySlug: session.companySlug || '',
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
    captchaConfig().then((cfg) => sendJson(res, 200, cfg)).catch(() => sendJson(res, 200, { enabled: false, siteKey: '' }));
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
        const slug = companySlug(body.companySlug) || 'elite';
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
  if ((url === '/' || url === '/calculadora.html') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(htmlFile));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, '127.0.0.1');
