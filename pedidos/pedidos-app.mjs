import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

const codeDir = path.dirname(fileURLToPath(import.meta.url));
const installDir = process.env.DFS_INSTALL_DIR || codeDir;
const dataDir = process.env.DFS_DATA_DIR || path.join(installDir, 'dados');
// Cada app (Fila / Registro / etc.) guarda a própria sessão — não compartilham a mesma conta.
const sessionNameRaw = String(process.env.DFS_SESSION_NAME || 'painel-sessao.json').trim();
const sessionName = /^[a-zA-Z0-9._-]+$/.test(sessionNameRaw) ? sessionNameRaw : 'painel-sessao.json';
const sessionFile = path.join(dataDir, sessionName);
const alertFile = path.join(dataDir, 'fila-alerta.json');
const queueStateFile = path.join(dataDir, 'fila-estado-cache.json');
const queuePendingFile = path.join(dataDir, 'fila-pendente.json');
const openFilaFile = path.join(dataDir, 'fila-abrir.json');
const filaHtmlFile = [
  path.join(installDir, 'fila.html'),
  path.join(codeDir, 'fila.html'),
].find((file) => fs.existsSync(file)) || path.join(installDir, 'fila.html');
const registroHtmlFile = [
  path.join(installDir, 'registro.html'),
  path.join(codeDir, 'registro.html'),
  path.join(installDir, 'registro.ui'),
  path.join(codeDir, 'registro.ui'),
].find((file) => fs.existsSync(file)) || path.join(installDir, 'registro.html');
const calcHtmlFile = [
  path.join(installDir, 'calc.html'),
  path.join(codeDir, 'calc.html'),
  path.join(installDir, 'calc.ui'),
  path.join(codeDir, 'calc.ui'),
].find((file) => fs.existsSync(file)) || path.join(installDir, 'calc.html');
const siteFile = path.join(dataDir, 'painel-site.json');
const htmlFile = [
  path.join(codeDir, 'pedidos.html'),
  path.join(installDir, 'pedidos.html'),
  path.join(codeDir, 'pedidos.ui'),
  path.join(installDir, 'pedidos.ui'),
].find((file) => fs.existsSync(file));

function readSite() {
  try { return JSON.parse(fs.readFileSync(siteFile, 'utf8')); } catch (e) { return {}; }
}
function readOrigin() {
  try {
    const url = new URL(String(readSite().origin || ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return url.origin;
  } catch (e) {
    return '';
  }
}
function machineId() {
  const fromEnv = String(process.env.DFS_MACHINE_ID || '').trim();
  if (fromEnv) return fromEnv;
  try { return String(fs.readFileSync(path.join(dataDir, 'pc-id.txt'), 'utf8') || '').trim(); }
  catch (e) { return ''; }
}
function readSession() {
  try {
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    if (!session || !session.token) return null;
    const mid = machineId();
    if (mid && session.machineId && session.machineId !== mid) return null;
    return session;
  } catch (e) {
    return null;
  }
}
function writeSession(session) {
  const mid = machineId();
  const next = { ...(session || {}) };
  if (mid) next.machineId = mid;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(sessionFile, JSON.stringify(next));
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
function rowsOfAuth(result) {
  const json = (result && result.json) || {};
  const docs = Array.isArray(json.docs) ? json.docs : [];
  return docs.map((doc) => {
    const data = doc && doc.data && typeof doc.data === 'object' ? doc.data : (doc || {});
    return Object.assign({ id: doc && doc.id }, data);
  });
}
async function adoptPanelToken(token) {
  const me = await panelRequest('auth/me', { dfs_token: token });
  const json = me.json || {};
  const profile = json.profile || {};
  const auth = json.auth || {};
  if (me.status >= 400 || !(auth.uid || profile.id)) {
    throw new Error(json.message || 'A sessão do painel não valeu.');
  }
  const links = Array.isArray(profile.companyLinks) ? profile.companyLinks : [];
  const link = links.find((item) => item && item.companyId && item.companyId === profile.companyId) || links[0] || null;
  let companyId = String(profile.companyId || (link && link.companyId) || '').trim();
  let companyName = (link && (link.companyName || link.name)) || profile.companyName || '';
  const slug = companySlug(String((readSite().link || readSite().companySlug || '')).trim());
  if (slug) {
    try {
      const companyRes = await panelRequest('query', {
        collection: 'companies',
        filters: [{ field: 'loginSlug', op: '==', value: slug }],
        limit: 1,
        dfs_token: token,
      });
      let company = rowsOfAuth(companyRes)[0];
      if (!company) {
        const all = await panelRequest('query', { collection: 'companies', limit: 0, dfs_token: token });
        company = rowsOfAuth(all).find((item) => companySlug(item.loginSlug || '') === slug) || null;
      }
      if (company && company.id) {
        companyId = String(company.id);
        companyName = String(company.name || company.nome || companyName);
      }
    } catch (e) { /* mantém a empresa do perfil */ }
  }
  const permissions = Array.isArray(profile.permissions) ? profile.permissions.slice() : [];
  writeSession({
    token,
    userId: auth.uid || profile.id || '',
    name: auth.displayName || profile.name || '',
    email: auth.email || profile.email || '',
    role: profile.role || '',
    permissions,
    companyLinks: links,
    companyId,
    companyName,
    companySlug: slug,
  });
  return readSession();
}
function panelRequest(apiPath, payload) {
  const origin = readOrigin();
  if (!origin) return Promise.reject(new Error('Sem site da empresa.'));
  const token = payload && payload.dfs_token ? String(payload.dfs_token) : '';
  const jsonStr = JSON.stringify(payload || {});
  // Prints em dataUrl estouram form-urlencoded (HostGator corta). JSON no body aguenta.
  const hasDataUrl = !!(payload && payload.data && typeof payload.data.dataUrl === 'string');
  const useJson = hasDataUrl || jsonStr.length > 45000;
  return new Promise((resolve, reject) => {
    const url = new URL('/wp-admin/admin-ajax.php', origin);
    url.searchParams.set('action', 'dfs');
    url.searchParams.set('path', String(apiPath || ''));
    if (token && useJson) url.searchParams.set('dfs_token', token);
    let data;
    const headers = { 'Content-Length': 0 };
    if (useJson) {
      data = jsonStr;
      headers['Content-Type'] = 'application/json; charset=utf-8';
      if (token) {
        headers.Authorization = 'Bearer ' + token;
        headers['X-DFS-Token'] = token;
      }
    } else {
      const body = new URLSearchParams();
      body.set('action', 'dfs');
      body.set('path', String(apiPath || ''));
      if (token) body.set('dfs_token', token);
      body.set('dfs_json', jsonStr);
      data = body.toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    }
    headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(url, {
      method: 'POST',
      headers,
      timeout: 90000,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { json = {}; }
        resolve({ status: response.statusCode || 500, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}
function rowsOf(result) {
  const json = (result && result.json) || {};
  let docs = json.docs;
  if (!Array.isArray(docs) && json.data && Array.isArray(json.data.docs)) docs = json.data.docs;
  if (!Array.isArray(docs) && Array.isArray(json.data)) docs = json.data;
  if (!Array.isArray(docs)) return [];
  return docs.map((doc) => {
    if (!doc || typeof doc !== 'object') return null;
    const data = doc.data && typeof doc.data === 'object' ? doc.data : doc;
    return { id: doc.id || data.id || '', ...data };
  }).filter(Boolean);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}
function localRequest(port, method, urlPath, payload) {
  const data = payload ? JSON.stringify(payload) : '';
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (err) { resolve({}); }
      });
    });
    req.on('error', () => resolve({}));
    req.end(data);
  });
}
async function readOrder(session, id) {
  const result = await panelRequest('read', { collection: 'orders', id, dfs_token: session.token });
  const json = (result && result.json) || {};
  const data = json.data && typeof json.data === 'object' ? json.data : (json.doc && json.doc.data) || null;
  if (!data) return null;
  return { id, ...data };
}
function numOrNull(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
function sumRange(qty, start, end) {
  const a = numOrNull(start);
  const b = numOrNull(end);
  if (a == null && b == null) return null;
  const count = Math.max(0, Math.floor(Number(qty) || 0));
  if (count === 0) return 0;
  if (a == null) return count * b;
  if (b == null || a === b) return count * a;
  const step = a <= b ? 1 : -1;
  const seq = [];
  let cursor = a;
  while (seq.length < 10000 && (step > 0 ? cursor <= b + 1e-9 : cursor >= b - 1e-9)) {
    seq.push(Math.round(cursor * 100) / 100);
    cursor += step;
  }
  if (!seq.length) seq.push(a);
  let total = 0;
  for (let i = 0; i < count; i += 1) total += seq[i % seq.length];
  return Math.round(total * 100) / 100;
}
function minuteStamp(iso) {
  const date = iso ? new Date(iso) : new Date();
  const value = Number.isNaN(date.getTime()) ? new Date() : date;
  const pad = (n) => String(n).padStart(2, '0');
  return value.getFullYear() + '-' + pad(value.getMonth() + 1) + '-' + pad(value.getDate()) + 'T' + pad(value.getHours()) + ':' + pad(value.getMinutes());
}
async function depositFor(session, order) {
  const contas = order.type === 'contas';
  if (!contas) {
    return Number((order.amountData && (order.amountData.valorMontante || order.amountData.deposit)) || 0);
  }
  const faixa = String((order.accountData && order.accountData.faixaDeposito) || '').trim();
  const qty = Number((order.accountData && order.accountData.qtdContas) || 0);
  if (faixa && qty > 0 && order.companyId) {
    try {
      const result = await panelRequest('query', {
        collection: 'calculatorRanges',
        filters: [{ field: 'companyId', op: '==', value: order.companyId }],
        limit: 0,
        dfs_token: session.token,
      });
      const row = rowsOf(result).find((item) => item.id === faixa || String(item.nome || '') === faixa);
      if (row) {
        const summed = sumRange(qty, row.somaInicio, row.somaFim);
        if (summed != null) return summed;
      }
    } catch (err) {}
  }
  return Number((order.accountData && order.accountData.deposit) || 0);
}
async function operationFromOrder(session, order) {
  const contas = order.type === 'contas';
  const module = contas ? 'contas' : 'montante';
  const now = new Date().toISOString();
  const deposit = await depositFor(session, order);
  const blogger = contas
    ? Number((order.accountData && order.accountData.blogger) ?? order.blogger ?? 0)
    : Number((order.amountData && order.amountData.blogger) ?? order.blogger ?? 0);
  const links = splitLinks(order.links);
  const discount = Number(order.discountPercentage || 0);
  const notes = [
    'Vinculado ao Pedido Código: ' + (order.orderCode || '') + '.',
    discount ? '(Desconto: ' + discount + '%)' : '',
    order.pixReceivedBy ? 'Pix: ' + order.pixReceivedBy + '.' : '',
    order.notes || '',
  ].filter(Boolean).join(' ');
  const payload = {
    date: minuteStamp(order.createdAt),
    operatorId: session.userId || '',
    companyId: order.companyId,
    clientId: order.clientId || '',
    clientName: order.clientName || 'Cliente',
    accountName: order.clientName || 'Cliente',
    phone: order.phone || '',
    houseLink: links[0] || '',
    houseLinks: links,
    requestedAccounts: contas
      ? Number((order.accountData && order.accountData.qtdContas) || 1)
      : Number((order.amountData && order.amountData.quantidade) || 1),
    clearedAccounts: 0,
    withdrawnAccounts: 0,
    deposit: Number(deposit) || 0,
    withdrawal: 0,
    blogger: Number(blogger) || 0,
    originalAmount: Number(order.originalAmount ?? order.totalValue ?? 0),
    discountPercentage: discount,
    discountAmount: Number(order.discountAmount || 0),
    discountApplied: discount,
    finalAmount: Number(order.finalAmount ?? order.totalValue ?? 0),
    module,
    notes: notes.trim(),
    orderId: order.id,
    orderCode: order.orderCode || '',
    verificado: false,
    promocao: !contas && !!order.promocao,
    depositRange: '',
    createdAt: now,
    updatedAt: now,
  };
  if (contas && order.accountData) payload.depositRange = order.accountData.faixaDeposito || order.accountData.grupo || '';
  if (!contas && order.amountData && order.amountData.rollover) payload.rollover = order.amountData.rollover;
  return payload;
}
async function passTurnIfMine(sector) {
  const state = await localRequest(Number(process.env.DFS_PORT || 8767) || 8767, 'GET', '/fila/estado', null);
  const ops = sector === 'montante' ? state.montante : state.contas;
  const me = String((state.me && state.me.id) || '');
  const active = (Array.isArray(ops) ? ops : []).filter((op) => op && op.active !== false);
  if (!me || !active[0] || String(active[0].userId) !== me || active.length < 2) return 'not-their-turn';
  const result = await localRequest(Number(process.env.DFS_PORT || 8767) || 8767, 'POST', '/fila/acao', { action: 'pass', sector });
  return result && result.ok ? 'skipped' : 'not-their-turn';
}
async function acceptDesignated(session, orderId, options) {
  const claim = !!(options && options.claim);
  const takeOver = !!(options && options.takeOver);
  const order = await readOrder(session, orderId);
  if (!order) throw new Error('Pedido não encontrado.');
  if (order.status === 'Finalizado' || order.status === 'Concluído' || order.status === 'Cancelado') throw new Error('Este pedido já foi finalizado ou cancelado.');
  const meId = String(session.userId || '');
  const name = session.name || '';
  if (order.responsibleOperatorId && order.responsibleOperatorId !== meId) {
    throw new Error('Este pedido já foi assumido por outro operador (' + (order.responsibleOperatorName || 'outro operador') + ').');
  }
  const assigned = String(order.assignedOperatorId || '');
  const takeover = takeOver && !!assigned && assigned !== meId;
  if (takeover && !canEditOrders(session)) {
    throw new Error('Só ADM Master ou quem tem a tag de editar pedidos assume o de outra pessoa.');
  }
  if (!takeover && assigned && assigned !== meId && !canEditOrders(session)) {
    throw new Error('Este pedido está designado exclusivamente para ' + (order.assignedOperatorName || 'outro operador') + '.');
  }
  if (claim && order.operationId) {
    return { ok: true, already: true, message: 'A operação já está registrada.' };
  }
  const now = new Date().toISOString();
  let operationId = order.operationId || '';
  if (!operationId) {
    const created = await panelRequest('write', {
      op: 'create',
      collection: 'operations',
      data: await operationFromOrder(session, order),
      dfs_token: session.token,
    });
    const json = (created && created.json) || {};
    operationId = json.id || (json.data && json.data.id) || '';
    if (created.status >= 400 || !operationId) throw new Error((json.message) || 'Não registrei a operação.');
  }
  const patch = {
    status: 'Assumido',
    assignmentAccepted: true,
    assignmentAcceptedAt: now,
    responsibleOperatorId: meId,
    responsibleOperatorName: name,
    assumedAt: now,
    startedAt: order.startedAt || now,
    operationId,
  };
  if (claim) {
    patch.assignedOperatorId = meId;
    patch.assignedOperatorName = name;
  }
  await writeOrder(session, order, patch);
  const busyName = order.assignedOperatorName || 'o operador designado';
  const note = takeover
    ? 'Pedido assumido por ' + (name || 'operador') + ' porque ' + busyName + ' estava ocupado. Operação #' + String(operationId).slice(0, 6) + ' registrada.'
    : claim
      ? 'Pedido assumido por ' + (name || 'operador') + '. Operação #' + String(operationId).slice(0, 6) + ' iniciada.'
      : 'Pedido aceito e assumido por ' + (name || 'operador') + '. Operação registrada.';
  await addHistory(session, order, 'Pedido assumido', note);
  if (claim) {
    const code = order.orderCode || '';
    return {
      ok: true,
      message: takeover
        ? 'Pedido ' + code + ' assumido. A operação ficou registrada para você.'
        : 'Pedido ' + code + ' assumido. A operação já está registrada.',
    };
  }
  const sector = order.type === 'montante' ? 'montante' : 'contas';
  const jumped = await passTurnIfMine(sector);
  return { ok: true, skipped: jumped === 'skipped' };
}
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function money(order) {
  const value = Number(order.totalValue || order.finalAmount || 0);
  return Number.isFinite(value) ? value : 0;
}
function splitLinks(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((part) => String(part || '').trim()).filter(Boolean);
  return String(value).split(/[\n;|]+/).map((part) => part.trim()).filter(Boolean);
}
function markedModules(order) {
  const added = order.addedModules;
  const has = added && (added.contas !== undefined || added.montante !== undefined);
  return {
    contas: has ? !!added.contas : order.type === 'contas',
    montante: has ? !!added.montante : order.type === 'montante',
  };
}
function publicOrder(order) {
  return {
    id: order.id,
    orderCode: order.orderCode || '',
    type: order.type || '',
    clientName: order.clientName || '',
    phone: order.phone || '',
    companyId: order.companyId || '',
    companyName: order.companyName || '',
    status: order.status || '',
    priority: order.priority || 'Normal',
    assignedOperatorId: order.assignedOperatorId || '',
    assignedOperatorName: order.assignedOperatorName || '',
    responsibleOperatorId: order.responsibleOperatorId || '',
    responsibleOperatorName: order.responsibleOperatorName || '',
    registeredByName: order.registeredByName || '',
    createdAt: order.createdAt || '',
    notes: order.notes || '',
    links: splitLinks(order.links),
    assignmentAccepted: order.assignmentAccepted === true,
    pixReceivedBy: order.pixReceivedBy || '',
    totalValue: money(order),
    originalAmount: Number(order.originalAmount || 0),
    discountPercentage: Number(order.discountPercentage || 0),
    discountAmount: Number(order.discountAmount || 0),
    blogger: Number(order.blogger || (order.accountData && order.accountData.blogger) || (order.amountData && order.amountData.blogger) || 0),
    faixa: (order.accountData && order.accountData.faixaDeposito) || '',
    qtd: Number((order.accountData && order.accountData.qtdContas) || 0),
    grupo: (order.accountData && order.accountData.grupo) || '',
    valorPorConta: Number((order.accountData && order.accountData.valorPorConta) || 0),
    quantidade: Number((order.amountData && order.amountData.quantidade) || 0),
    valorMontante: Number((order.amountData && order.amountData.valorMontante) || 0),
    rollover: (order.amountData && order.amountData.rollover) || '',
    addedModules: order.addedModules && typeof order.addedModules === 'object' ? order.addedModules : null,
    version: Number(order.version || 1),
    operationId: order.operationId || '',
    withdrawal: moneyOf(order.withdrawal),
    saques: Array.isArray(order.saques) ? order.saques.map((item) => String(item)) : [],
  };
}
function isManager(session) {
  return session.role === 'ADM_MASTER' || session.role === 'SOCIO';
}
function hasPerm(session, id) {
  if (!session) return false;
  if (session.role === 'ADM_MASTER') return true;
  return Array.isArray(session.permissions) && session.permissions.includes(id);
}
function canViewOrders(session) {
  return hasPerm(session, 'order_queue_view');
}
function canEditOrders(session) {
  return hasPerm(session, 'order_queue_edit');
}
function canExcludeOrders(session) {
  return hasPerm(session, 'order_queue_exclude');
}
function canOversee(session) {
  return canEditOrders(session);
}
function waitingStatus(status) {
  return status === 'Aguardando operador' || status === 'Registrado' || status === 'Retornado para fila';
}
function canSeeOrder(session, order) {
  if (canViewOrders(session)) return true;
  const me = String(session.userId || '');
  if (!me) return false;
  if (waitingStatus(order.status)) return true;
  if (order.status === 'Designado') return String(order.assignedOperatorId || '') === me;
  return String(order.responsibleOperatorId || '') === me;
}
async function writeOrder(session, order, data) {
  const now = new Date().toISOString();
  const updated = await panelRequest('write', {
    op: 'update',
    collection: 'orders',
    id: order.id,
    merge: true,
    data: { ...data, version: Number(order.version || 1) + 1, updatedAt: now },
    dfs_token: session.token,
  });
  if (updated.status >= 400) throw new Error((updated.json && updated.json.message) || 'Não atualizei o pedido.');
  return now;
}
async function addHistory(session, order, action, notes) {
  await panelRequest('write', {
    op: 'create',
    collection: 'orderHistory',
    data: {
      orderId: order.id,
      companyId: order.companyId || '',
      action,
      userId: session.userId || '',
      userName: session.name || '',
      userRole: session.role || 'OPERADOR',
      timestamp: new Date().toISOString(),
      notes,
    },
    dfs_token: session.token,
  });
}
async function toggleModule(session, id, module) {
  if (module !== 'contas' && module !== 'montante') throw new Error('Módulo inválido.');
  const order = await readOrder(session, id);
  if (!order) throw new Error('Pedido não encontrado.');
  if (!canOversee(session) && order.responsibleOperatorId !== session.userId) {
    throw new Error('Só ADM Master ou quem tem a tag de editar pedidos altera o módulo.');
  }
  const added = markedModules(order);
  added[module] = !added[module];
  await writeOrder(session, order, { addedModules: added });
  return { ok: true, addedModules: added };
}
async function finishOrder(session, id, done) {
  const order = await readOrder(session, id);
  if (!order) throw new Error('Pedido não encontrado.');
  const admin = canOversee(session);
  const mine = order.responsibleOperatorId === session.userId;
  if (order.status === 'Cancelado') throw new Error('Pedido cancelado.');
  if (order.status === 'Concluído') throw new Error('Este pedido já foi concluído.');
  if (!done && !admin) throw new Error('Só ADM Master ou quem tem a tag de editar pedidos desmarca a finalização.');
  if (done && order.status === 'Finalizado') return { ok: true, status: order.status };
  if (!done && order.status !== 'Finalizado') return { ok: true, status: order.status };
  const allowed = admin || (mine && (order.status === 'Assumido' || order.status === 'Em andamento' || order.status === 'Finalizado'));
  if (!allowed) throw new Error('Só quem assumiu o pedido marca como finalizado.');
  const name = session.name || 'operador';
  if (done) {
    await writeOrder(session, order, { status: 'Finalizado', statusBeforeFinish: order.status, finishedAt: new Date().toISOString() });
    const op = order.operationId ? 'Pedido finalizado com a operação #' + String(order.operationId).slice(0, 6) + '.' : 'Pedido finalizado por ' + name + '.';
    await addHistory(session, order, 'Pedido finalizado', op);
    return { ok: true, status: 'Finalizado' };
  }
  const previous = order.statusBeforeFinish;
  const status = previous && previous !== 'Finalizado' && previous !== 'Cancelado'
    ? previous
    : (order.responsibleOperatorId ? 'Assumido' : order.assignedOperatorId ? 'Designado' : 'Aguardando operador');
  await writeOrder(session, order, { status, statusBeforeFinish: null, finishedAt: null });
  await addHistory(session, order, 'Finalização desmarcada', 'Pedido voltou para ' + status + ' por ' + name + '.');
  return { ok: true, status };
}
function moneyOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const text = String(value || '').trim().replace(/\s/g, '').replace(/R\$/g, '');
  if (!text) return 0;
  const normal = text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text;
  const n = parseFloat(normal);
  return Number.isFinite(n) ? n : 0;
}
function withdrawalOf(op) {
  const direct = moneyOf(op && op.withdrawal);
  if (direct > 0) return direct;
  const list = op && (Array.isArray(op.saques) ? op.saques : (op.calculatorData && Array.isArray(op.calculatorData.withdrawals) ? op.calculatorData.withdrawals : []));
  if (!Array.isArray(list)) return 0;
  return list.reduce((sum, item) => sum + moneyOf(item && typeof item === 'object' ? (item.value ?? item.amount ?? item.valor) : item), 0);
}
function typedWithdrawal(values) {
  if (!Array.isArray(values)) return null;
  const filled = values.map((item) => String(item || '').trim()).filter(Boolean);
  if (!filled.length) return null;
  return Math.round(filled.reduce((sum, item) => sum + moneyOf(item), 0) * 100) / 100;
}
function localOpFiles() {
  const files = [];
  const root = path.join(dataDir, 'operacoes.json');
  if (fs.existsSync(root)) files.push(root);
  const perfis = path.join(dataDir, 'perfis');
  if (fs.existsSync(perfis)) {
    fs.readdirSync(perfis).forEach((name) => {
      const file = path.join(perfis, name, 'operacoes.json');
      if (fs.existsSync(file)) files.push(file);
    });
  }
  return files;
}
function dropLocalOp(operationId, orderId) {
  localOpFiles().forEach((file) => {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const ops = Array.isArray(data.ops) ? data.ops : null;
      if (!ops) return;
      const next = ops.filter((op) => {
        const samePanel = operationId && String(op.panelId || '') === String(operationId);
        const sameOrder = orderId && String(op.orderId || '') === String(orderId);
        return !samePanel && !sameOrder;
      });
      if (next.length === ops.length) return;
      data.ops = next;
      fs.writeFileSync(file, JSON.stringify(data));
    } catch (err) { /* a cópia local some no próximo sync */ }
  });
}
async function dropLinkedOperations(session, order) {
  const ids = new Set();
  if (order && order.operationId) ids.add(String(order.operationId));
  if (order && order.id) {
    try {
      const found = await panelRequest('query', {
        collection: 'operations',
        filters: [{ field: 'orderId', op: '==', value: order.id }],
        limit: 0,
        dfs_token: session.token,
      });
      rowsOf(found).forEach((op) => {
        if (op && op.id) ids.add(String(op.id));
      });
    } catch (err) { /* ainda apaga a operação ligada no pedido */ }
  }
  for (const id of ids) {
    const removed = await panelRequest('write', {
      op: 'delete',
      collection: 'operations',
      id,
      dfs_token: session.token,
    });
    const json = (removed && removed.json) || {};
    if (!removed || removed.status >= 400 || json.ok === false) {
      throw new Error(json.message || 'Não apaguei a operação do pedido cancelado.');
    }
    dropLocalOp(id, order && order.id);
  }
  if (order && order.id) dropLocalOp('', order.id);
}
function patchLocalOp(operationId, orderId, patch) {
  localOpFiles().forEach((file) => {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const ops = Array.isArray(data.ops) ? data.ops : null;
      if (!ops) return;
      let changed = false;
      ops.forEach((op) => {
        const same = String(op.panelId || '') === String(operationId) || String(op.orderId || '') === String(orderId);
        if (!same) return;
        if (patch.withdrawal != null) op.withdrawal = patch.withdrawal;
        if (Array.isArray(patch.saques)) op.saques = patch.saques.map((item) => String(item));
        if (patch.gross != null) op.gross = patch.gross;
        if (patch.commission != null) op.commission = patch.commission;
        if (patch.net != null) op.net = patch.net;
        if (patch.verificado === true) op.verificado = true;
        changed = true;
      });
      if (changed) fs.writeFileSync(file, JSON.stringify(data));
    } catch (err) { /* o histórico local continua no painel */ }
  });
}
function rememberReady(map, key, info) {
  if (!key) return;
  const current = map.get(String(key));
  if (!current) { map.set(String(key), info); return; }
  map.set(String(key), {
    verificado: current.verificado || info.verificado,
    withdrawal: Math.max(current.withdrawal, info.withdrawal),
    saques: (info.saques && info.saques.length) ? info.saques : (current.saques || []),
  });
}
function saqueLinesOf(op) {
  const raw = op && (Array.isArray(op.saques) ? op.saques : (op.calculatorData && Array.isArray(op.calculatorData.withdrawals) ? op.calculatorData.withdrawals : []));
  const lines = Array.isArray(raw)
    ? raw.map((item) => String(item && typeof item === 'object' ? (item.value ?? item.amount ?? item.valor ?? '') : (item ?? ''))).filter((item) => moneyOf(item) > 0)
    : [];
  const withdrawal = withdrawalOf(op);
  if (!lines.length && withdrawal > 0) lines.push(String(withdrawal));
  return { withdrawal, saques: lines };
}
function readyFromOp(op) {
  const pack = saqueLinesOf(op);
  const checked = op && op.verificado === true;
  if (!checked && !(pack.withdrawal > 0)) return null;
  return { verificado: checked, withdrawal: pack.withdrawal, saques: pack.saques };
}
async function readOperation(session, id) {
  const read = await panelRequest('read', { collection: 'operations', id, dfs_token: session.token });
  if (!read || read.status >= 400) return null;
  const json = read.json || {};
  const op = json.data && typeof json.data === 'object' ? json.data : (json.doc && json.doc.data) || null;
  return op && typeof op === 'object' ? op : null;
}
async function saveOrderSaque(session, order, values, markChecked) {
  const typed = typedWithdrawal(values);
  const op = order.operationId ? await readOperation(session, order.operationId) : null;
  const withdrawal = typed == null ? (op ? withdrawalOf(op) : moneyOf(order.withdrawal)) : typed;
  const saques = typed == null
    ? (op && Array.isArray(op.saques) ? op.saques : (withdrawal > 0 ? [String(withdrawal)] : (Array.isArray(order.saques) ? order.saques : [])))
    : values.map((item) => String(item || '').trim()).filter(Boolean);
  if (order.operationId) {
    const calc = Object.assign({}, (op && op.calculatorData) || {});
    calc.withdrawals = saques.slice();
    calc.totalWithdrawals = withdrawal;
    const patch = {
      withdrawal,
      saques,
      calculatorData: calc,
      updatedAt: new Date().toISOString(),
    };
    if (markChecked) patch.verificado = true;
    const saved = await panelRequest('write', {
      op: 'update',
      collection: 'operations',
      id: order.operationId,
      merge: true,
      data: patch,
      dfs_token: session.token,
    });
    const savedJson = (saved && saved.json) || {};
    if (saved.status >= 400 || savedJson.ok === false) throw new Error(savedJson.message || 'Não gravei o saque na operação.');
    const savedOp = savedJson.data && typeof savedJson.data === 'object' ? savedJson.data : {};
    patchLocalOp(order.operationId, order.id, {
      withdrawal,
      saques,
      gross: savedOp.grossProfit,
      commission: savedOp.commission,
      net: savedOp.netProfit,
      verificado: markChecked === true,
    });
  }
  await writeOrder(session, order, { withdrawal, saques });
  return { withdrawal, saques };
}
async function storeSaque(session, id, values) {
  const order = await readOrder(session, id);
  if (!order) throw new Error('Pedido não encontrado.');
  if (order.status !== 'Finalizado') throw new Error('O saque entra no pedido finalizado.');
  if (!canOversee(session) && order.responsibleOperatorId !== session.userId) {
    throw new Error('Só quem finalizou o pedido, o ADM Master ou quem tem a tag lança o saque.');
  }
  const saved = await saveOrderSaque(session, order, values, false);
  return { ok: true, withdrawal: saved.withdrawal };
}
async function concludeOrder(session, id, values) {
  const order = await readOrder(session, id);
  if (!order) throw new Error('Pedido não encontrado.');
  if (order.status === 'Concluído') return { ok: true, status: 'Concluído', withdrawal: moneyOf(order.withdrawal) };
  if (order.status !== 'Finalizado') throw new Error('Finalize o pedido antes de concluir.');
  if (!canOversee(session) && order.responsibleOperatorId !== session.userId) {
    throw new Error('Só quem finalizou o pedido, o ADM Master ou quem tem a tag conclui.');
  }
  const saved = await saveOrderSaque(session, order, values, true);
  await writeOrder(session, order, { status: 'Concluído', concludedAt: new Date().toISOString(), withdrawal: saved.withdrawal, saques: saved.saques });
  const note = saved.withdrawal > 0
    ? 'Saque de R$ ' + saved.withdrawal.toFixed(2).replace('.', ',') + ' confirmado. Operação marcada no histórico.'
    : 'Pedido concluído com saque zerado. Operação marcada no histórico.';
  await addHistory(session, order, 'Pedido concluído', note);
  return { ok: true, status: 'Concluído', withdrawal: saved.withdrawal };
}
let promoteStarted = false;
async function promoteExisting(session, orders) {
  const byPanel = new Map();
  const byOrder = new Map();
  function take(id, orderId, info) {
    rememberReady(byPanel, id, info);
    rememberReady(byOrder, orderId, info);
  }
  localOpFiles().forEach((file) => {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      (Array.isArray(data.ops) ? data.ops : []).forEach((op) => {
        const info = readyFromOp(op);
        if (!info) return;
        take(op.panelId || op.id, op.orderId, info);
      });
    } catch (err) { /* arquivo local ilegível não trava a fila */ }
  });
  try {
    const result = await panelRequest('query', { collection: 'operations', limit: 0, dfs_token: session.token });
    rowsOf(result).forEach((op) => {
      const info = readyFromOp(op);
      if (!info) return;
      take(op.id, op.orderId, info);
    });
  } catch (err) { /* o histórico local ainda promove o que já está no computador */ }
  for (const [id, info] of byPanel) {
    if (!id || info.verificado || !(info.withdrawal > 0)) continue;
    try {
      const saved = await panelRequest('write', {
        op: 'update',
        collection: 'operations',
        id,
        merge: true,
        data: { verificado: true, updatedAt: new Date().toISOString() },
        dfs_token: session.token,
      });
      if (!saved || saved.status >= 400) continue;
      patchLocalOp(id, '', { verificado: true });
      info.verificado = true;
    } catch (err) { /* segue para a próxima operação */ }
  }
  for (const order of orders) {
    if (order.status !== 'Finalizado') continue;
    const info = byPanel.get(String(order.operationId || '')) || byOrder.get(String(order.id || ''));
    if (!info) continue;
    try {
      await writeOrder(session, order, {
        status: 'Concluído',
        concludedAt: new Date().toISOString(),
        withdrawal: info.withdrawal,
        saques: Array.isArray(info.saques) ? info.saques : [],
      });
    } catch (err) { /* tenta o próximo pedido */ }
  }
}
async function actOnOrder(session, id, action, reason) {
  const order = await readOrder(session, id);
  if (!order) throw new Error('Pedido não encontrado.');
  if (order.status === 'Finalizado' || order.status === 'Concluído' || order.status === 'Cancelado') throw new Error('Este pedido já foi finalizado ou cancelado.');
  if (!canExcludeOrders(session)) throw new Error('Só ADM Master ou quem tem a tag de adicionar ou excluir pedido cancela ou devolve o pedido.');
  const note = String(reason || '').trim();
  if (!note) throw new Error('Informe o motivo da ação.');
  const name = session.name || 'operador';
  if (action === 'return') {
    await dropLinkedOperations(session, order);
    await writeOrder(session, order, {
      status: 'Retornado para fila',
      responsibleOperatorId: null,
      responsibleOperatorName: null,
      assignedOperatorId: null,
      assignedOperatorName: null,
      assignmentAccepted: true,
      operationId: null,
      returnedAt: new Date().toISOString(),
    });
    await addHistory(session, order, 'Pedido retornado à fila', 'Pedido retornado à fila por ' + name + '. A operação saiu do registro. Motivo: ' + note);
    return { ok: true, status: 'Retornado para fila' };
  }
  if (action === 'cancel') {
    await dropLinkedOperations(session, order);
    await writeOrder(session, order, {
      status: 'Cancelado',
      cancelledAt: new Date().toISOString(),
      operationId: null,
    });
    await addHistory(session, order, 'Pedido cancelado', 'Pedido cancelado por ' + name + '. A operação foi excluída. Motivo: ' + note);
    return { ok: true, status: 'Cancelado' };
  }
  throw new Error('Ação inválida.');
}

let saqueCache = null;
const saqueWritten = new Set();
async function copySaquesFromOperations(session, orders) {
  const missing = (order) => (order.status === 'Concluído' || order.status === 'Finalizado')
    && !(moneyOf(order.withdrawal) > 0)
    && !(Array.isArray(order.saques) && order.saques.some((item) => moneyOf(item) > 0));
  if (!orders.some(missing) && saqueCache) return;
  if (!saqueCache) {
    saqueCache = new Map();
    try {
      const result = await panelRequest('query', { collection: 'operations', limit: 0, dfs_token: session.token });
      rowsOf(result).forEach((op) => {
        const info = saqueLinesOf(op);
        if (!(info.withdrawal > 0) && !info.saques.length) return;
        const pack = { withdrawal: info.withdrawal, saques: info.saques };
        if (op.id) saqueCache.set('op:' + op.id, pack);
        if (op.orderId) saqueCache.set('order:' + op.orderId, pack);
      });
    } catch (err) {
      saqueCache = null;
      return;
    }
  }
  for (const order of orders) {
    if (!missing(order)) continue;
    const pack = saqueCache.get('op:' + (order.operationId || '')) || saqueCache.get('order:' + order.id);
    if (!pack) continue;
    order.withdrawal = pack.withdrawal;
    order.saques = pack.saques.slice();
    if (order.status !== 'Concluído' || saqueWritten.has(order.id)) continue;
    saqueWritten.add(order.id);
    writeOrder(session, order, { withdrawal: pack.withdrawal, saques: pack.saques }).catch(() => { saqueWritten.delete(order.id); });
  }
}

function localDateString(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function assignQueuePositions(ops) {
  let n = 0;
  return (ops || []).map((op) => {
    if (op.active === false) return { ...op, position: 0 };
    n += 1;
    return { ...op, position: n };
  });
}
function firstPausedIndex(ops) {
  const idx = (ops || []).findIndex((op) => op.active === false);
  return idx === -1 ? (ops || []).length : idx;
}
function insertAtActiveEnd(ops, op) {
  const next = (ops || []).slice();
  next.splice(firstPausedIndex(next), 0, { ...op, active: true });
  return assignQueuePositions(next);
}
function sendOperatorToPausedEnd(ops, userId) {
  const idx = (ops || []).findIndex((op) => op.userId === userId);
  if (idx === -1) return ops || [];
  const next = ops.slice();
  const [moved] = next.splice(idx, 1);
  next.push({ ...moved, active: false });
  return assignQueuePositions(next);
}
function sendOperatorToActiveEnd(ops, userId, extra = {}) {
  const idx = (ops || []).findIndex((op) => op.userId === userId);
  if (idx === -1) return ops || [];
  const next = ops.slice();
  const [moved] = next.splice(idx, 1);
  next.splice(firstPausedIndex(next), 0, { ...moved, ...extra, active: true });
  return assignQueuePositions(next);
}
function filterActiveCycleQueueOperators(ops, resetTime = '00:00', lastResetAt, now = new Date()) {
  if (!Array.isArray(ops)) return [];
  const parts = String(resetTime || '00:00').split(':');
  const h = parseInt(parts[0], 10) || 0;
  const m = parseInt(parts[1], 10) || 0;
  const cycleStart = new Date(now);
  cycleStart.setHours(h, m, 0, 0);
  if (cycleStart.getTime() > now.getTime()) cycleStart.setDate(cycleStart.getDate() - 1);
  let minValid = cycleStart.getTime();
  if (lastResetAt) {
    const manualTs = new Date(lastResetAt).getTime();
    if (!isNaN(manualTs) && manualTs > minValid) minValid = manualTs;
  }
  const today = localDateString(now);
  const filtered = ops.filter((op) => {
    let opTime = 0;
    if (op.enteredAt) opTime = new Date(op.enteredAt).getTime();
    else if (op.lastMovedAt) {
      if (typeof op.lastMovedAt === 'string') opTime = new Date(op.lastMovedAt).getTime();
      else if (op.lastMovedAt && typeof op.lastMovedAt === 'object' && op.lastMovedAt.seconds) {
        opTime = op.lastMovedAt.seconds * 1000;
      }
    }
    if (opTime && !isNaN(opTime)) return opTime >= minValid;
    if (op.queueDate && op.queueDate === today) return true;
    return false;
  });
  return assignQueuePositions(filtered);
}
async function readDoc(session, collection, id) {
  const res = await panelRequest('read', { collection, id, dfs_token: session.token });
  const json = (res && res.json) || {};
  if (res.status >= 400) return null;
  if (json.data && typeof json.data === 'object') return { id, ...json.data };
  if (json.doc && json.doc.data) return { id, ...json.doc.data };
  return null;
}
async function writeQueueSector(session, sectorId, operators, updatedBy) {
  const nowIso = new Date().toISOString();
  const res = await panelRequest('write', {
    op: 'set',
    collection: 'queueSectors',
    id: sectorId,
    data: {
      sector: sectorId,
      operators,
      updatedAt: nowIso,
      updatedBy: updatedBy || session.name || '',
    },
    merge: true,
    dfs_token: session.token,
  });
  if (res.status >= 400) {
    const message = (res.json && res.json.message) || 'Não gravei a fila no site.';
    throw new Error(message);
  }
  return operators;
}
async function appendQueueLog(session, payload) {
  try {
    const now = new Date();
    await panelRequest('write', {
      op: 'create',
      collection: 'queueActivityLogs',
      data: {
        sector: payload.sector,
        action: payload.action,
        operatorId: payload.operatorId,
        operatorName: payload.operatorName,
        actorId: payload.actorId || payload.operatorId,
        actorName: payload.actorName || payload.operatorName,
        note: payload.note || '',
        timestamp: now.toISOString(),
        date: localDateString(now),
        time: String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0'),
      },
      dfs_token: session.token,
    });
  } catch (e) {}
}
function readQueueStateCache() {
  try {
    return JSON.parse(fs.readFileSync(queueStateFile, 'utf8'));
  } catch (e) {
    return null;
  }
}
function writeQueueStateCache(state) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(queueStateFile, JSON.stringify(state));
  } catch (e) {}
}
function readQueuePending() {
  try {
    const data = JSON.parse(fs.readFileSync(queuePendingFile, 'utf8'));
    return Array.isArray(data.items) ? data.items : [];
  } catch (e) {
    return [];
  }
}
function writeQueuePending(items) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(queuePendingFile, JSON.stringify({ items: items || [] }));
  } catch (e) {}
}
function queueStateFromOps(session, contas, montante, meta) {
  const meId = String(session.userId || '');
  const contasOps = Array.isArray(contas) ? contas : [];
  const montanteOps = Array.isArray(montante) ? montante : [];
  return {
    ok: true,
    me: { id: meId, name: session.name || '' },
    resetTime: (meta && meta.resetTime) || '00:00',
    lastResetAt: (meta && meta.lastResetAt) || '',
    lastResetType: (meta && meta.lastResetType) || '',
    contas: contasOps,
    montante: montanteOps,
    meContas: contasOps.find((op) => String(op.userId) === meId) || null,
    meMontante: montanteOps.find((op) => String(op.userId) === meId) || null,
  };
}
async function loadQueueState(session) {
  try {
    const [settingsDoc, contasDoc, montanteDoc] = await Promise.all([
      readDoc(session, 'queueSettings', 'global'),
      readDoc(session, 'queueSectors', 'contas'),
      readDoc(session, 'queueSectors', 'montante'),
    ]);
    const resetTime = (settingsDoc && settingsDoc.resetTime) || '00:00';
    const lastResetAt = settingsDoc && settingsDoc.lastResetAt;
    const lastResetType = (settingsDoc && settingsDoc.lastResetType) || '';
    const contas = filterActiveCycleQueueOperators((contasDoc && contasDoc.operators) || [], resetTime, lastResetAt);
    const montante = filterActiveCycleQueueOperators((montanteDoc && montanteDoc.operators) || [], resetTime, lastResetAt);
    const state = queueStateFromOps(session, contas, montante, { resetTime, lastResetAt, lastResetType });
    writeQueueStateCache(state);
    return state;
  } catch (e) {
    const cached = readQueueStateCache();
    if (cached && cached.ok) {
      return { ...cached, offline: true, message: 'Site fora do ar — fila do último estado neste PC.' };
    }
    throw e;
  }
}
async function flushQueuePending(session) {
  const items = readQueuePending();
  if (!items.length) return;
  const left = [];
  for (const item of items) {
    try {
      await writeQueueSector(session, item.sectorId, item.operators, item.updatedBy);
      if (item.log) await appendQueueLog(session, item.log);
    } catch (e) {
      left.push(item);
    }
  }
  writeQueuePending(left);
}
async function loadQueueAlertSettings(session) {
  const user = await readDoc(session, 'users', String(session.userId || ''));
  return (user && user.queueAlertSettings) || null;
}
async function saveQueueAlertSettings(session, settings) {
  const res = await panelRequest('write', {
    op: 'set',
    collection: 'users',
    id: String(session.userId || ''),
    data: { queueAlertSettings: settings },
    merge: true,
    dfs_token: session.token,
  });
  if (res.status >= 400) {
    throw new Error((res.json && res.json.message) || 'Não gravei a configuração do toque.');
  }
  return settings;
}
async function queueAction(session, action, sector) {
  const sectorId = sector === 'montante' ? 'montante' : 'contas';
  if (!['enter', 'leave', 'pause', 'pass'].includes(action)) {
    throw new Error('Ação inválida.');
  }
  const meId = String(session.userId || '');
  const meName = String(session.name || 'Operador');
  if (!meId) throw new Error('Entre de novo para usar a fila.');
  let state;
  try {
    state = await loadQueueState(session);
  } catch (e) {
    const cached = readQueueStateCache();
    if (!cached || !cached.ok) throw e;
    state = { ...cached, offline: true };
  }
  let ops = sectorId === 'contas' ? (state.contas || []).slice() : (state.montante || []).slice();
  const todayStr = localDateString();
  const nowIso = new Date().toISOString();
  let logAction = action;
  let note = '';

  if (action === 'enter') {
    if (ops.some((op) => String(op.userId) === meId)) {
      return { ok: true, already: true, ...state };
    }
    ops = insertAtActiveEnd(ops, {
      userId: meId,
      name: meName,
      position: 0,
      active: true,
      lastMovedAt: nowIso,
      enteredAt: nowIso,
      queueDate: todayStr,
    });
    logAction = 'enter';
  } else if (action === 'leave') {
    ops = assignQueuePositions(ops.filter((op) => String(op.userId) !== meId));
    logAction = 'leave';
  } else if (action === 'pause') {
    const idx = ops.findIndex((op) => String(op.userId) === meId);
    if (idx < 0) throw new Error('Você não está nesta fila.');
    const isActive = ops[idx].active !== false;
    if (isActive) {
      ops = sendOperatorToPausedEnd(ops, meId);
      logAction = 'pause';
      note = 'Finalizou turno';
    } else {
      ops = sendOperatorToActiveEnd(ops, meId, { lastMovedAt: nowIso, queueDate: todayStr });
      logAction = 'resume';
      note = 'Voltou ao ativo';
    }
  } else if (action === 'pass') {
    const first = ops.find((op) => op.active !== false);
    if (!first) throw new Error('Não há operadores ativos nesta fila.');
    if (String(first.userId) !== meId) throw new Error('Somente o operador da vez pode avançar a fila.');
    ops = sendOperatorToActiveEnd(ops, meId, { lastMovedAt: nowIso, queueDate: todayStr });
    logAction = 'pass';
  }

  const log = {
    sector: sectorId,
    action: logAction,
    operatorId: meId,
    operatorName: meName,
    actorId: meId,
    actorName: meName,
    note,
  };
  const nextContas = sectorId === 'contas' ? ops : (state.contas || []);
  const nextMontante = sectorId === 'montante' ? ops : (state.montante || []);
  const localState = queueStateFromOps(session, nextContas, nextMontante, state);
  writeQueueStateCache(localState);

  try {
    await writeQueueSector(session, sectorId, ops, meName);
    await appendQueueLog(session, log);
    try { await flushQueuePending(session); } catch (e) {}
    return { ok: true, ...(await loadQueueState(session)) };
  } catch (e) {
    const pending = readQueuePending();
    pending.push({
      sectorId,
      operators: ops,
      updatedBy: meName,
      log,
      at: Date.now(),
    });
    writeQueuePending(pending);
    return {
      ok: true,
      offline: true,
      message: 'Site fora do ar — ação ficou neste PC e sobe quando voltar.',
      ...localState,
    };
  }
}

function orderCodeNow() {
  const d = new Date();
  const dateStr = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  const suffix = String(Math.floor(1000 + Math.random() * 9000));
  return 'PED-' + dateStr + '-' + suffix;
}
function rangeGroupOf(item) {
  // Espelho de resolveDepositRangeCategory do site: categoria gravada; senão Lista no fim do nome.
  const raw = String((item && (item.categoria || item.grupo || item.group)) || '').replace(/\s+/g, ' ').trim();
  const explicit = normalizeCategoryLabel(raw);
  if (explicit) return explicit;
  const fromLista = String((item && item.nome) || '').trim().match(/\s+(lista\s*\d+)\s*$/i);
  if (fromLista) return normalizeCategoryLabel(fromLista[1]);
  return '';
}
function montanteGroupOf(item) {
  const raw = String((item && (item.grupo || item.categoria || item.group)) || '').replace(/\s+/g, ' ').trim();
  const match = raw.match(/(?:grupo|lista)\s*0*(\d+)/i);
  if (match) {
    const n = match[1].padStart(2, '0');
    if (n === '01') return 'Grupo 01';
    if (n === '02') return 'Grupo 02';
  }
  return 'Grupo 01';
}
function loadBudgetTemplatesFile() {
  try {
    const file = path.join(__dirname, 'budget-templates.json');
    if (!fs.existsSync(file)) return { templates: [], defaults: { CONTAS: 'contas-formal', MONTANTE: 'montante-formal', MULTIPLO: 'multi-formal' } };
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      templates: Array.isArray(json.templates) ? json.templates : [],
      defaults: json.defaults && typeof json.defaults === 'object'
        ? json.defaults
        : { CONTAS: 'contas-formal', MONTANTE: 'montante-formal', MULTIPLO: 'multi-formal' },
    };
  } catch (err) {
    return { templates: [], defaults: { CONTAS: 'contas-formal', MONTANTE: 'montante-formal', MULTIPLO: 'multi-formal' } };
  }
}
function parseBudgetDefaults(data, fallbackIds) {
  const empty = {
    messageMontante: '',
    messageContas: '',
    messageMultiplo: '',
    templateIdContas: fallbackIds.CONTAS || 'contas-formal',
    templateIdMontante: fallbackIds.MONTANTE || 'montante-formal',
    templateIdMultiplo: fallbackIds.MULTIPLO || 'multi-formal',
    templateBodies: {},
  };
  if (!data || typeof data !== 'object') return empty;
  const bodies = {};
  if (data.templateBodies && typeof data.templateBodies === 'object' && !Array.isArray(data.templateBodies)) {
    Object.entries(data.templateBodies).forEach(([key, body]) => {
      if (typeof body === 'string' && body.trim()) bodies[key] = body;
    });
  }
  const pickId = (value, fallback) => {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!id || id === 'contas-classico' || id === 'montante-classico' || id === 'multi-classico') return fallback;
    return id;
  };
  return {
    messageMontante: typeof data.messageMontante === 'string' ? data.messageMontante : '',
    messageContas: typeof data.messageContas === 'string' ? data.messageContas : '',
    messageMultiplo: typeof data.messageMultiplo === 'string' ? data.messageMultiplo : '',
    templateIdContas: pickId(data.templateIdContas, empty.templateIdContas),
    templateIdMontante: pickId(data.templateIdMontante, empty.templateIdMontante),
    templateIdMultiplo: pickId(data.templateIdMultiplo, empty.templateIdMultiplo),
    templateBodies: bodies,
  };
}
async function loadRegistroDados(session) {
  const companyId = String(session.companyId || '').trim();
  if (!companyId) throw new Error('Entre na empresa para registrar pedidos.');
  const filters = [{ field: 'companyId', op: '==', value: companyId }];
  const token = session.token;
  const catalog = loadBudgetTemplatesFile();
  const [rangesRes, ratesRes, rulesRes, campaignsRes, usersRes, clientsRes, queueState, budgetRes] = await Promise.all([
    panelRequest('query', { collection: 'calculatorRanges', filters, limit: 0, dfs_token: token }),
    panelRequest('query', { collection: 'calculatorMontanteRates', filters, limit: 0, dfs_token: token }),
    panelRequest('query', { collection: 'calculatorMontanteAccountRules', filters, limit: 0, dfs_token: token }),
    panelRequest('query', { collection: 'campaigns', filters, limit: 0, dfs_token: token }),
    panelRequest('query', { collection: 'users', filters, limit: 0, dfs_token: token }),
    panelRequest('query', { collection: 'clients', filters, limit: 0, dfs_token: token }),
    loadQueueState(session).catch(() => ({ ok: false, contas: [], montante: [] })),
    panelRequest('read', { collection: 'settings', id: 'calculator_budget_' + companyId, dfs_token: token }).catch(() => null),
  ]);
  const ranges = rowsOf(rangesRes).map((item) => ({
    id: item.id,
    nome: String(item.nome || ''),
    valor: Number(item.valor) || 0,
    categoria: String(item.categoria || item.grupo || item.group || ''),
    grupo: rangeGroupOf(item),
    order: item.order,
  })).filter((item) => item.nome).sort((a, b) => Number(a.order ?? 9999) - Number(b.order ?? 9999));
  const rates = rowsOf(ratesRes).map((item) => {
    const taxa = Number(item.taxa) || 0;
    const multiplicador = Number(item.multiplicador) || 0;
    const multLabel = multiplicador.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    const taxaLabel = taxa.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    const obs = String(item.observacao || '').trim();
    const base = multiplicador > 0 ? (multLabel + ' x ' + taxaLabel + '%') : (taxaLabel + '%');
    return {
      id: item.id,
      taxa,
      multiplicador,
      observacao: obs,
      label: item.label || (obs ? (base + ' · ' + obs) : base),
      grupo: montanteGroupOf(item),
      order: item.order,
    };
  }).sort((a, b) => Number(a.order ?? 9999) - Number(b.order ?? 9999));
  const rules = rowsOf(rulesRes).map((item) => ({
    montante: Number(item.montante) || 0,
    qtdContas: Number(item.qtdContas) || 0,
    grupo: montanteGroupOf(item),
  })).filter((item) => item.montante > 0).sort((a, b) => a.montante - b.montante);
  const campaigns = rowsOf(campaignsRes);
  const users = rowsOf(usersRes).filter((user) => user.status === 'active');
  const operators = users.filter((user) => {
    const role = String(user.role || '');
    if (role !== 'OPERADOR' && role !== 'ATENDENTE' && role !== 'GERENTE') return false;
    const perms = Array.isArray(user.permissions) ? user.permissions : [];
    return perms.includes('contas') || perms.includes('montante') || perms.includes('dashboard') || role === 'ATENDENTE';
  }).map((user) => ({
    id: user.id,
    name: user.name || user.displayName || user.email || 'Operador',
    role: user.role || 'OPERADOR',
    permissions: Array.isArray(user.permissions) ? user.permissions : [],
  })).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const clients = rowsOf(clientsRes).filter((item) => item.active !== false).map((item) => ({
    id: item.id,
    name: item.name || '',
    phone: item.phone || '',
    normalizedPhone: String(item.normalizedPhone || item.phone || '').replace(/\D/g, ''),
    pix: item.pix || '',
    notes: item.notes || '',
  })).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const pix = [];
  users.forEach((user) => {
    const keys = Array.isArray(user.pixKeys) ? user.pixKeys : [];
    keys.forEach((key, index) => {
      if (!key || key.active === false) return;
      const chave = String(key.chave || key.key || '').trim();
      if (!chave) return;
      pix.push({
        id: String(key.id || (user.id + '-' + index)),
        userId: String(user.id || ''),
        chave,
        tipo: key.tipoChave || key.tipo || 'Pix',
        banco: key.bancoInstituicao || key.banco || '',
        nome: key.nomeCompleto || key.nome || user.name || '',
        contas: key.exibirContas !== false && (key.contas !== false),
        montante: key.exibirMontante !== false && (key.montante !== false),
      });
    });
  });
  const budgetRaw = budgetRes && budgetRes.json
    ? (budgetRes.json.data || budgetRes.json.doc || budgetRes.json)
    : null;
  const budgetDefaults = parseBudgetDefaults(budgetRaw, catalog.defaults || {});
  return {
    ok: true,
    me: {
      id: session.userId || '',
      name: session.name || '',
      role: session.role || '',
      companyId,
      companyName: session.companyName || '',
      permissions: Array.isArray(session.permissions) ? session.permissions : [],
    },
    companyName: session.companyName || '',
    ranges,
    rates,
    rules,
    campaigns,
    operators,
    clients,
    pix,
    budgetDefaults,
    budgetTemplates: catalog.templates || [],
    budgetDefaultIds: catalog.defaults || {},
    queue: {
      contas: Array.isArray(queueState.contas) ? queueState.contas : [],
      montante: Array.isArray(queueState.montante) ? queueState.montante : [],
    },
  };
}
function normalizeCategoryLabel(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  const tagged = text.match(/^(lista|grupo)\s*0*(\d+)$/i);
  if (tagged) {
    const kind = tagged[1].toLowerCase() === 'grupo' ? 'Grupo' : 'Lista';
    return kind + ' ' + tagged[2].padStart(2, '0');
  }
  return text;
}
function sameDepositGroup(a, b) {
  const left = normalizeCategoryLabel(a || '').toLowerCase();
  const right = normalizeCategoryLabel(b || '').toLowerCase();
  if (!left && !right) return true;
  if (!left || !right) return false;
  if (left === right) return true;
  const numA = (left.match(/^(?:grupo|lista)\s+(\d+)$/) || [])[1];
  const numB = (right.match(/^(?:grupo|lista)\s+(\d+)$/) || [])[1];
  return !!(numA && numB && numA === numB);
}
function isAllGroupsLabel(group) {
  const raw = String(group || '').trim().toLowerCase();
  return !raw || raw === 'todos' || raw === 'todos os grupos' || raw === 'all';
}
function ruleIsModule(rule, moduleKey) {
  const raw = String((rule && (rule.module || rule.tipo)) || '').trim().toLowerCase();
  if (moduleKey === 'Contas') return raw === 'contas';
  return raw === 'montantes' || raw === 'montante';
}
function hasMontanteThreshold(montante) {
  const n = Number(montante);
  return Number.isFinite(n) && n > 0;
}
function ruleMatchesMontanteValue(rule, value) {
  if (!hasMontanteThreshold(rule.montante)) return true;
  const x = Number(rule.montante) || 0;
  const cmp = String(rule.montanteCompare || '') === 'abaixo' ? 'abaixo' : 'acima';
  return cmp === 'abaixo' ? value <= x + 1e-9 : value + 1e-9 >= x;
}
function rulesForGroup(rules, groupLabel) {
  const group = normalizeCategoryLabel(groupLabel || '');
  if (group) {
    const exact = rules.filter((r) => !isAllGroupsLabel(r.group || r.grupo) && sameDepositGroup(r.group || r.grupo, group));
    if (exact.length) return exact;
  }
  const all = rules.filter((r) => isAllGroupsLabel(r.group || r.grupo));
  if (all.length) return all;
  if (!group) return rules;
  return [];
}
function pickPercentByThreshold(scoped, value) {
  const withThreshold = scoped.filter((r) => hasMontanteThreshold(r.montante));
  const withoutThreshold = scoped.filter((r) => !hasMontanteThreshold(r.montante));
  const n = Number(value);
  if (Number.isFinite(n) && n > 0 && withThreshold.length) {
    const matched = withThreshold.filter((r) => ruleMatchesMontanteValue(r, n));
    if (matched.length) {
      matched.sort((a, b) => {
        const da = Math.abs((Number(a.montante) || 0) - n);
        const db = Math.abs((Number(b.montante) || 0) - n);
        if (da !== db) return da - db;
        return (Number(b.percent) || 0) - (Number(a.percent) || 0);
      });
      return Number(matched[0].percent) || 0;
    }
  }
  if (withoutThreshold.length) return Number(withoutThreshold[0].percent) || 0;
  if (withThreshold.length) return Math.max(0, ...withThreshold.map((r) => Number(r.percent) || 0));
  return Number(scoped[0] && scoped[0].percent) || 0;
}
/** Espelho de src/utils/campaignDiscount.ts — desconto por grupo / limiar. */
function campaignDiscountPercent(campaigns, module, grupo, montanteValue, qtd) {
  const list = Array.isArray(campaigns) ? campaigns : [];
  const day = new Date().toISOString().slice(0, 10);
  const active = list.find((item) => {
    if (!item) return false;
    const st = String(item.status || '').toLowerCase();
    if (st === 'inactive' || st === 'inativa' || st === 'encerrada' || st === 'pausada') return false;
    if (item.startDate && day < String(item.startDate).slice(0, 10)) return false;
    if (item.endDate && day > String(item.endDate).slice(0, 10)) return false;
    return true;
  });
  if (!active) return null;
  const moduleKey = module === 'contas' ? 'Contas' : 'Montantes';
  const rules = (Array.isArray(active.groupDiscounts) ? active.groupDiscounts : []).filter((r) => ruleIsModule(r, moduleKey));
  if (!rules.length) {
    if (module === 'contas' && active.discountContas != null) return Number(active.discountContas) || 0;
    if (module === 'montante' && active.discountMontantes != null) return Number(active.discountMontantes) || 0;
    return null;
  }
  const scoped = rulesForGroup(rules, grupo);
  if (!scoped.length) return 0;
  if (module === 'contas') return pickPercentByThreshold(scoped, qtd);
  return pickPercentByThreshold(scoped, montanteValue);
}
function qtdFromMontante(value, rules, grupo) {
  const num = Number(value) || 0;
  if (!(num > 0)) return 0;
  const pool = (rules || []).filter((rule) => !grupo || String(rule.grupo || '').toLowerCase() === String(grupo).toLowerCase());
  const list = pool.length ? pool : (rules || []);
  let best = null;
  list.forEach((rule) => {
    if (num >= Number(rule.montante || 0)) best = rule;
  });
  return best ? Number(best.qtdContas) || 0 : 0;
}
/** Igual ao site (OrderService + skipActiveOperatorTurn): se o designado é o 1 da fila, passa a vez. */
async function skipDesignatedOperatorTurn(session, order) {
  const operatorId = String((order && order.assignedOperatorId) || '').trim();
  if (!operatorId) return;
  const sectorId = order.type === 'montante' ? 'montante' : 'contas';
  try {
    const state = await loadQueueState(session);
    let ops = (sectorId === 'montante' ? state.montante : state.contas) || [];
    ops = ops.slice();
    const positioned = assignQueuePositions(ops);
    const mine = positioned.find((op) => String(op.userId) === operatorId);
    if (!mine || mine.active === false) return;
    if (Number(mine.position) !== 1) return;
    const activeCount = positioned.filter((op) => op.active !== false).length;
    if (activeCount < 2) return;
    const nowIso = new Date().toISOString();
    const next = sendOperatorToActiveEnd(positioned, operatorId, {
      lastMovedAt: nowIso,
      queueDate: localDateString(),
    });
    await writeQueueSector(session, sectorId, next, order.assignedOperatorName || session.name || 'Sistema');
    try {
      await appendQueueLog(session, {
        sector: sectorId,
        action: 'pass',
        operatorId,
        operatorName: order.assignedOperatorName || 'Operador',
        actorId: session.userId || '',
        actorName: session.name || '',
        note: 'Vez passada ao designar pedido ' + (order.orderCode || ''),
      });
    } catch (e) { /* log opcional */ }
  } catch (e) { /* fila ocupada / offline — pedido já gravou */ }
}

async function createRegisteredOrder(session, body) {
  const companyId = String(session.companyId || '').trim();
  if (!companyId) throw new Error('Entre na empresa para registrar o pedido.');
  const type = body.type === 'montante' ? 'montante' : 'contas';
  const clientName = String(body.clientName || '').trim();
  if (!clientName) throw new Error('Informe o nome do cliente.');
  const qtd = Math.max(1, Math.round(Number(body.qtdContas) || 1));
  const valorPorConta = Number(body.valorPorConta) || 0;
  const valorMontante = Number(body.valorMontante) || 0;
  const taxa = Number(body.taxa) || 0;
  const qtyMontante = Math.max(1, Math.round(Number(body.quantidadeMontante) || qtdFromMontante(valorMontante, [], body.grupo) || 1));
  let discountPercentage = Number(String(body.discountPercentage ?? '0').replace(',', '.'));
  if (!Number.isFinite(discountPercentage) || discountPercentage < 0) throw new Error('Informe um percentual numérico válido.');
  if (discountPercentage > 100) throw new Error('O desconto não pode ser superior a 100%.');
  discountPercentage = Math.round(discountPercentage * 100) / 100;
  // Mesma conta do OrderRegistrationModal do site.
  let subtotal = 0;
  if (type === 'contas') subtotal = Math.round(qtd * valorPorConta * 100) / 100;
  else subtotal = Math.round(valorMontante * (taxa / 100) * 100) / 100;
  const discountAmount = Math.round(((subtotal * discountPercentage) / 100) * 100) / 100;
  const computedFinal = Math.max(0, Math.round((subtotal - discountAmount) * 100) / 100);
  // Site 1.4.23+: Promoção no Repasse Blogueira — se marcada, finalAmount/blogger usam o valor editado.
  const promocao = !!body.promocao;
  const blogger = promocao && body.blogger != null
    ? Math.max(0, Math.round((Number(body.blogger) || 0) * 100) / 100)
    : computedFinal;
  const finalAmount = blogger;
  const assignedOperatorId = String(body.assignedOperatorId || '').trim();
  const assignedOperatorName = String(body.assignedOperatorName || '').trim();
  const now = new Date().toISOString();
  let createdAt = now;
  if (body.day === 'ontem') {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    createdAt = d.toISOString();
  }
  const noteImages = Array.isArray(body.noteImages)
    ? body.noteImages.filter((item) => typeof item === 'string' && item.indexOf('data:image/') === 0).slice(0, 4)
    : [];
  const payload = {
    orderCode: orderCodeNow(),
    type,
    status: assignedOperatorId ? 'Designado' : 'Aguardando operador',
    clientId: body.clientId || null,
    clientName,
    phone: String(body.phone || '').trim(),
    companyId,
    companyName: session.companyName || 'Empresa',
    priority: 'Normal',
    pixReceivedBy: String(body.pixReceivedBy || '').trim(),
    links: String(body.links || '').trim(),
    notes: String(body.notes || '').trim(),
    // Prints ficam só em orderImages (base64 no pedido estoura a lista da Fila no site).
    noteImages: [],
    assignedOperatorId: assignedOperatorId || null,
    assignedOperatorName: assignedOperatorId ? (assignedOperatorName || null) : null,
    assignedAt: assignedOperatorId ? now : null,
    assignmentAccepted: assignedOperatorId ? false : true,
    registeredBy: session.userId || '',
    registeredByName: session.name || '',
    registeredByRole: session.role || 'OPERADOR',
    createdAt,
    updatedAt: now,
    originalAmount: subtotal,
    discountPercentage,
    discountAmount,
    finalAmount,
    totalValue: finalAmount,
    blogger,
    promocao,
    version: 1,
    accountData: type === 'contas' ? {
      grupo: String(body.grupo || 'Grupo 01'),
      faixaDeposito: String(body.faixaDeposito || ''),
      qtdContas: qtd,
      valorPorConta,
      subtotal,
      originalAmount: subtotal,
      discountPercentage,
      discountAmount,
      finalAmount,
      deposit: finalAmount,
      blogger,
    } : null,
    amountData: type === 'montante' ? {
      grupo: String(body.grupo || 'Grupo 01'),
      valorMontante,
      quantidade: qtyMontante,
      rollover: String(body.rollover || ''),
      taxa,
      subtotal,
      originalAmount: subtotal,
      discountPercentage,
      discountAmount,
      finalAmount,
      deposit: valorMontante,
      blogger,
      aposta: Number(body.aposta) || 0,
    } : null,
  };
  const created = await panelRequest('write', {
    op: 'create',
    collection: 'orders',
    data: payload,
    dfs_token: session.token,
  });
  const json = (created && created.json) || {};
  const id = String(json.id || (json.data && json.data.id) || (json.doc && json.doc.id) || '').trim();
  if (!created || created.status >= 400) throw new Error(json.message || 'Não registrei o pedido.');
  if (!id) throw new Error('O painel não confirmou o ID do pedido. Nada foi marcado como enviado.');
  if (!payload.orderCode) throw new Error('Falha ao gerar o código do pedido.');
  const order = { id, ...payload };
  // A Fila lê prints em orderImages (não no campo noteImages do pedido).
  if (noteImages.length) {
    for (let i = 0; i < noteImages.length; i++) {
      let imgRes;
      try {
        imgRes = await panelRequest('write', {
          op: 'create',
          collection: 'orderImages',
          data: {
            orderId: id,
            orderCode: payload.orderCode,
            companyId,
            dataUrl: noteImages[i],
            index: i,
            createdAt: now,
            registeredBy: session.userId || '',
          },
          dfs_token: session.token,
        });
      } catch (imgErr) {
        throw new Error('Pedido ' + payload.orderCode + ' gravou, mas a imagem ' + (i + 1) + ' não: ' + (imgErr.message || 'erro') + '.');
      }
      const imgJson = (imgRes && imgRes.json) || {};
      const imgOk = imgRes && imgRes.status < 400 && imgJson && !imgJson.error && (imgJson.id || (imgJson.data && imgJson.id !== false));
      if (!imgOk) {
        const msg = (imgJson && (imgJson.message || (imgJson.error && imgJson.error.message))) || ('HTTP ' + ((imgRes && imgRes.status) || '?'));
        throw new Error('Pedido ' + payload.orderCode + ' gravou, mas a imagem ' + (i + 1) + ' não: ' + msg + '.');
      }
    }
    imageMap = null;
    imageMapAt = 0;
    imageMapPromise = null;
  }
  const moneyFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(discountAmount);
  const discountNote = discountPercentage > 0
    ? (' Pedido registrado com desconto de ' + discountPercentage + '% — ' + moneyFmt + ' de desconto.')
    : '';
  await addHistory(session, order, 'Pedido registrado', (
    assignedOperatorName
      ? ('Pedido registrado por ' + (session.name || 'atendente') + ' e designado para ' + assignedOperatorName + '.')
      : ('Pedido registrado por ' + (session.name || 'atendente') + ' na fila global.')
  ) + discountNote);
  if (assignedOperatorId) {
    try {
      await panelRequest('write', {
        op: 'set',
        collection: 'orderAlerts',
        id: assignedOperatorId,
        merge: true,
        data: {
          orderId: id,
          companyId,
          operatorId: assignedOperatorId,
          active: true,
          updatedAt: now,
        },
        dfs_token: session.token,
      });
    } catch (e) { /* aviso é opcional */ }
    await skipDesignatedOperatorTurn(session, order);
  }
  return { ok: true, id, orderCode: payload.orderCode, order: publicOrder(order) };
}

const server = http.createServer((req, res) => {
  const rawUrl = String(req.url || '/');
  const splitAt = rawUrl.indexOf('?');
  const url = splitAt >= 0 ? rawUrl.slice(0, splitAt) : rawUrl;
  const query = new URLSearchParams(splitAt >= 0 ? rawUrl.slice(splitAt + 1) : '');
  if (url === '/app/health') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (url === '/' || url === '/pedidos.html') {
    if (!htmlFile) {
      res.writeHead(404);
      res.end('pedidos.html');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(htmlFile));
    return;
  }
  if ((url === '/registro' || url === '/registro.html') && req.method === 'GET') {
    if (!fs.existsSync(registroHtmlFile)) { res.writeHead(404); res.end('registro.html'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(registroHtmlFile));
    return;
  }
  if ((url === '/calc' || url === '/calc.html') && req.method === 'GET') {
    if (!fs.existsSync(calcHtmlFile)) { res.writeHead(404); res.end('calc.html'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(calcHtmlFile));
    return;
  }
  if (url === '/registro/dados' && req.method === 'GET') {
    const session = readSession();
    if (!session || !session.token) {
      sendJson(res, 200, { ok: false, message: 'Entre na empresa para registrar pedidos.' });
      return;
    }
    loadRegistroDados(session)
      .then((data) => sendJson(res, 200, data))
      .catch((err) => sendJson(res, 200, { ok: false, message: err.message || 'Não li os dados do registro.' }));
    return;
  }
  if (url === '/registro/criar' && req.method === 'POST') {
    const session = readSession();
    if (!session || !session.token) {
      sendJson(res, 200, { ok: false, message: 'Entre na empresa para registrar o pedido.' });
      return;
    }
    readBody(req).then((body) => createRegisteredOrder(session, body || {}))
      .then((result) => sendJson(res, 200, result))
      .catch((err) => sendJson(res, 200, { ok: false, message: err.message || 'Não registrei o pedido.' }));
    return;
  }
  if (url === '/pedidos' && req.method === 'GET') {
    const session = readSession();
    if (!session) {
      sendJson(res, 200, { ok: false, message: 'Entre na empresa para ver os pedidos.' });
      return;
    }
    panelRequest('query', { collection: 'orders', limit: 0, dfs_token: session.token })
      .then(async (result) => {
        let orders = rowsOf(result);
        const companyId = String(session.companyId || '');
        const linkIds = (Array.isArray(session.companyLinks) ? session.companyLinks : []).map((link) => String(link.companyId || '')).filter(Boolean);
        const allowed = new Set([companyId, ...linkIds].filter(Boolean));
        if (session.role !== 'ADM_MASTER' && allowed.size) {
          orders = orders.filter((order) => allowed.has(String(order.companyId || '')));
        }
        orders = orders.filter((order) => canSeeOrder(session, order));
        await copySaquesFromOperations(session, orders);
        orders.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        if (!promoteStarted) {
          promoteStarted = true;
          const pending = orders.filter((order) => order.status === 'Finalizado');
          promoteExisting(session, pending).catch(() => {});
        }
        sendJson(res, 200, {
          ok: true,
          companyName: session.companyName || '',
          me: {
            id: session.userId || '',
            name: session.name || '',
            role: session.role || '',
            companyId: session.companyId || '',
            companyName: session.companyName || '',
            permissions: Array.isArray(session.permissions) ? session.permissions : [],
          },
          orders: orders.map(publicOrder),
        });
      })
      .catch((err) => sendJson(res, 200, { ok: false, message: err.message || 'Não li os pedidos.' }));
    return;
  }
  if (url === '/pedidos/aceitar' && req.method === 'POST') {
    const session = readSession();
    if (!session) {
      sendJson(res, 200, { ok: false, message: 'Entre na empresa para aceitar o pedido.' });
      return;
    }
    readBody(req).then((body) => acceptDesignated(session, String(body.id || ''), {
      claim: body.claim === true,
      takeOver: body.takeOver === true,
    }))
      .then((result) => sendJson(res, 200, result))
      .catch((err) => sendJson(res, 200, { ok: false, message: err.message || 'Não foi possível aceitar o pedido.' }));
    return;
  }
  if (url === '/pedidos/modulo' && req.method === 'POST') {
    const session = readSession();
    if (!session) { sendJson(res, 200, { ok: false, message: 'Entre na empresa para marcar o pedido.' }); return; }
    readBody(req).then((body) => toggleModule(session, String(body.id || ''), String(body.module || '')))
      .then((result) => sendJson(res, 200, result))
      .catch((err) => sendJson(res, 200, { ok: false, message: err.message || 'Não foi possível marcar o módulo.' }));
    return;
  }
  if (url === '/pedidos/saque' && req.method === 'POST') {
    const session = readSession();
    if (!session) { sendJson(res, 200, { ok: false, message: 'Entre na empresa para lançar o saque.' }); return; }
    readBody(req).then((body) => storeSaque(session, String(body.id || ''), body.values))
      .then((result) => sendJson(res, 200, result))
      .catch((err) => sendJson(res, 200, { ok: false, message: err.message || 'Não foi possível lançar o saque.' }));
    return;
  }
  if (url === '/pedidos/concluir' && req.method === 'POST') {
    const session = readSession();
    if (!session) { sendJson(res, 200, { ok: false, message: 'Entre na empresa para concluir o pedido.' }); return; }
    readBody(req).then((body) => concludeOrder(session, String(body.id || ''), body.values))
      .then((result) => sendJson(res, 200, result))
      .catch((err) => sendJson(res, 200, { ok: false, message: err.message || 'Não foi possível concluir o pedido.' }));
    return;
  }
  if (url === '/pedidos/finalizar' && req.method === 'POST') {
    const session = readSession();
    if (!session) { sendJson(res, 200, { ok: false, message: 'Entre na empresa para finalizar o pedido.' }); return; }
    readBody(req).then((body) => finishOrder(session, String(body.id || ''), body.done === true))
      .then((result) => sendJson(res, 200, result))
      .catch((err) => sendJson(res, 200, { ok: false, message: err.message || 'Não foi possível atualizar o pedido.' }));
    return;
  }
  if (url === '/pedidos/acao' && req.method === 'POST') {
    const session = readSession();
    if (!session) { sendJson(res, 200, { ok: false, message: 'Entre na empresa para alterar o pedido.' }); return; }
    readBody(req).then((body) => actOnOrder(session, String(body.id || ''), String(body.action || ''), body.reason))
      .then((result) => sendJson(res, 200, result))
      .catch((err) => sendJson(res, 200, { ok: false, message: err.message || 'Não foi possível atualizar o pedido.' }));
    return;
  }
  if (url === '/pedidos/historico' && req.method === 'GET') {
    const session = readSession();
    if (!session) { sendJson(res, 200, { ok: false, message: 'Entre na empresa para ver o histórico.' }); return; }
    const id = String(query.get('id') || '');
    panelRequest('query', {
      collection: 'orderHistory',
      filters: [{ field: 'orderId', op: '==', value: id }],
      limit: 0,
      dfs_token: session.token,
    }).then((result) => {
      const events = rowsOf(result)
        .filter((event) => String(event.orderId || '') === id)
        .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
      sendJson(res, 200, { ok: true, events });
    }).catch((err) => sendJson(res, 200, { ok: false, message: err.message || 'Não li o histórico.' }));
    return;
  }
  if (url === '/pedidos/versao' && req.method === 'GET') {
    let version = '1.0.0';
    try {
      const text = fs.readFileSync(path.join(installDir, 'app-versao-pedidos.txt'), 'utf8').replace(/^\uFEFF/, '').trim();
      if (text) version = text;
    } catch (e) {}
    sendJson(res, 200, { ok: true, version });
    return;
  }
  if ((url === '/fila' || url === '/fila.html') && req.method === 'GET') {
    if (!fs.existsSync(filaHtmlFile)) { res.writeHead(404); res.end('fila.html'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(filaHtmlFile));
    return;
  }
  if (url === '/fila/abrir' && (req.method === 'POST' || req.method === 'GET')) {
    const payload = { at: Date.now() };
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(openFilaFile, JSON.stringify(payload));
      sendJson(res, 200, { ok: true, at: payload.at });
    } catch (e) {
      sendJson(res, 500, { ok: false, message: e.message || 'Não pedi abertura da fila.' });
    }
    return;
  }
  if (url === '/fila/alerta' && req.method === 'GET') {
    try { sendJson(res, 200, JSON.parse(fs.readFileSync(alertFile, 'utf8'))); }
    catch (e) { sendJson(res, 200, { active: false, sector: '', stopped: false }); }
    return;
  }
  if (url === '/fila/alerta' && req.method === 'POST') {
    readBody(req).then((body) => {
      const payload = { active: !!body.active, sector: String(body.sector || ''), stopped: !!body.stopped, at: Date.now() };
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(alertFile, JSON.stringify(payload));
      sendJson(res, 200, payload);
    }).catch(() => sendJson(res, 400, { active: false, sector: '', stopped: false }));
    return;
  }
  if (url === '/fila/estado' && req.method === 'GET') {
    const session = readSession();
    if (!session || !session.token) {
      sendJson(res, 200, { ok: false, message: 'Entre na empresa para ver a fila operacional.' });
      return;
    }
    flushQueuePending(session).catch(() => {}).then(() => loadQueueState(session))
      .then((state) => sendJson(res, 200, state))
      .catch(() => {
        const cached = readQueueStateCache();
        if (cached && cached.ok) {
          sendJson(res, 200, { ...cached, offline: true, message: 'Site fora do ar — fila do último estado neste PC.' });
          return;
        }
        sendJson(res, 502, { ok: false, message: 'Não li a fila do site.' });
      });
    return;
  }
  if (url === '/fila/acao' && req.method === 'POST') {
    const session = readSession();
    if (!session || !session.token) {
      sendJson(res, 401, { ok: false, message: 'Entre na empresa para usar a fila operacional.' });
      return;
    }
    readBody(req).then(async (body) => {
      try {
        sendJson(res, 200, await queueAction(session, String(body.action || ''), String(body.sector || 'contas')));
      } catch (e) {
        sendJson(res, 400, { ok: false, message: e.message || 'Não atualizei a fila.' });
      }
    }).catch(() => sendJson(res, 400, { ok: false, message: 'Não li a ação da fila.' }));
    return;
  }
  if (url === '/fila/config' && req.method === 'GET') {
    const session = readSession();
    if (!session || !session.token) {
      sendJson(res, 200, { ok: false, message: 'Entre na empresa para ver a configuração.' });
      return;
    }
    loadQueueAlertSettings(session)
      .then((settings) => sendJson(res, 200, { ok: true, settings: settings || null, meId: String(session.userId || '') }))
      .catch(() => sendJson(res, 502, { ok: false, message: 'Não li a configuração do toque.' }));
    return;
  }
  if (url === '/fila/config' && req.method === 'POST') {
    const session = readSession();
    if (!session || !session.token) {
      sendJson(res, 401, { ok: false, message: 'Entre na empresa para salvar a configuração.' });
      return;
    }
    readBody(req).then(async (body) => {
      try {
        const settings = body && body.settings ? body.settings : body;
        await saveQueueAlertSettings(session, settings);
        sendJson(res, 200, { ok: true, settings });
      } catch (e) {
        sendJson(res, 400, { ok: false, message: e.message || 'Não gravei a configuração do toque.' });
      }
    }).catch(() => sendJson(res, 400, { ok: false, message: 'Não li a configuração do toque.' }));
    return;
  }
  if (url === '/pedidos/usar' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const token = String(body.token || '').trim();
      if (!token) { sendJson(res, 400, { ok: false, message: 'A sessão do painel não veio.' }); return; }
      try {
        const session = await adoptPanelToken(token);
        sendJson(res, 200, { ok: true, name: session.name || '', companyId: session.companyId || '', companyName: session.companyName || '' });
      } catch (err) {
        sendJson(res, 401, { ok: false, message: err.message || 'A sessão do painel não valeu.' });
      }
    }).catch(() => sendJson(res, 400, { ok: false, message: 'Não li a sessão.' }));
    return;
  }
  if (url === '/pedidos/sair' && req.method === 'POST') {
    try { fs.unlinkSync(sessionFile); } catch (e) {}
    sendJson(res, 200, { ok: true });
    return;
  }
  if (url === '/pedidos/imagens' && req.method === 'GET') {
    const session = readSession();
    if (!session) { sendJson(res, 200, { ok: false, images: {}, byCode: {} }); return; }
    const id = String(query.get('id') || '').trim();
    const ids = String(query.get('ids') || '').split(',').map((part) => part.trim()).filter(Boolean).slice(0, 40);
    const codes = String(query.get('codes') || '').split(',').map((part) => part.trim()).filter(Boolean).slice(0, 40);
    const wantedIds = id ? [id] : ids;
    // Igual ao site: consulta orderImages por orderCode/orderId (coleção inteira = 500).
    fetchOrderImages(session, wantedIds, codes).then((pack) => {
      const map = (pack && pack.map) || {};
      const byCode = (pack && pack.byCode) || {};
      if (id) sendJson(res, 200, { ok: true, images: map[id] || [], byCode });
      else if (wantedIds.length) {
        const part = {};
        wantedIds.forEach((key) => { part[key] = map[key] || []; });
        sendJson(res, 200, { ok: true, images: part, byCode });
      } else sendJson(res, 200, { ok: true, images: byCode, byCode });
    }).catch(() => sendJson(res, 200, { ok: false, images: id ? [] : {}, byCode: {} }));
    return;
  }
  res.writeHead(404);
  res.end();
});

function companyImageFilters(session) {
  const companyId = String((session && session.companyId) || '');
  // ADM / sem empresa: sem filtro, senão some o print de outra empresa (igual dfs-extras).
  if (!session || session.role === 'ADM_MASTER' || !companyId || companyId === 'all') return [];
  return [{ field: 'companyId', op: '==', value: companyId }];
}

function pushImage(bucket, key, dataUrl) {
  if (!key || !dataUrl || dataUrl.indexOf('data:image/') !== 0) return;
  if (!bucket[key]) bucket[key] = [];
  if (bucket[key].indexOf(dataUrl) < 0 && bucket[key].length < 4) bucket[key].push(dataUrl);
}

function absorbImageRows(rows, map, byCode) {
  (rows || []).forEach((row) => {
    const orderId = String(row.orderId || row.order_id || '');
    const orderCode = String(row.orderCode || row.order_code || '');
    const dataUrl = String(row.dataUrl || row.url || '');
    pushImage(map, orderId, dataUrl);
    pushImage(byCode, orderCode, dataUrl);
  });
}

function fetchOrderImages(session, orderIds, orderCodes) {
  const ids = (orderIds || []).map((v) => String(v || '').trim()).filter(Boolean).slice(0, 40);
  const codes = (orderCodes || []).map((v) => String(v || '').trim()).filter(Boolean).slice(0, 40);
  if (!ids.length && !codes.length) return Promise.resolve({ map: {}, byCode: {} });
  const base = companyImageFilters(session);
  const map = {};
  const byCode = {};
  // Site busca primeiro por orderCode — mais estável que só orderId.
  const first = codes.length
    ? panelRequest('query', {
      collection: 'orderImages',
      filters: base.concat([{ field: 'orderCode', op: 'in', value: codes }]),
      limit: 80,
      dfs_token: session.token,
    })
    : panelRequest('query', {
      collection: 'orderImages',
      filters: base.concat([{ field: 'orderId', op: 'in', value: ids }]),
      limit: 80,
      dfs_token: session.token,
    });
  return first.then((result) => {
    absorbImageRows(rowsOf(result), map, byCode);
    const missing = ids.filter((key) => !map[key] || !map[key].length);
    if (!missing.length || !ids.length) return { map, byCode };
    // Completa o que faltou pelo orderId (prints sem código ou código divergente).
    return panelRequest('query', {
      collection: 'orderImages',
      filters: base.concat([{ field: 'orderId', op: 'in', value: missing }]),
      limit: 80,
      dfs_token: session.token,
    }).then((second) => {
      absorbImageRows(rowsOf(second), map, byCode);
      return { map, byCode };
    }).catch(() => ({ map, byCode }));
  });
}

const listenPort = Number(process.env.DFS_PORT || 8767) || 8767;
server.listen(listenPort, '127.0.0.1');
console.log('[pedidos] http://127.0.0.1:' + listenPort);
