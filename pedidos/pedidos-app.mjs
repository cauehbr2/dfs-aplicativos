import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

const codeDir = path.dirname(fileURLToPath(import.meta.url));
const installDir = process.env.DFS_INSTALL_DIR || codeDir;
const dataDir = process.env.DFS_DATA_DIR || path.join(installDir, 'dados');
const sessionFile = path.join(dataDir, 'painel-sessao.json');
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
function panelRequest(apiPath, payload) {
  const origin = readOrigin();
  if (!origin) return Promise.reject(new Error('Sem site da empresa.'));
  const body = new URLSearchParams();
  body.set('action', 'dfs');
  body.set('path', apiPath);
  if (payload && payload.dfs_token) body.set('dfs_token', payload.dfs_token);
  body.set('dfs_json', JSON.stringify(payload || {}));
  const data = body.toString();
  return new Promise((resolve, reject) => {
    const req = https.request(new URL('/wp-admin/admin-ajax.php', origin), {
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
function firstRate(...values) {
  for (const value of values) {
    if (value == null) continue;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}
function commissionOf(session, companyId, module) {
  const link = (Array.isArray(session.companyLinks) ? session.companyLinks : []).find((item) => item && item.companyId === companyId) || {};
  if (module === 'contas') {
    return {
      rate: firstRate(link.commissionContas, session.commissionContas, link.commission, session.commission),
      rule: link.contasCommissionRule || session.contasCommissionRule || 'net',
    };
  }
  return {
    rate: firstRate(link.commissionMontante, session.commissionMontante, link.commission, session.commission),
    rule: link.montanteCommissionRule || session.montanteCommissionRule || 'net',
  };
}
function profitOf(deposit, blogger, rate, rule) {
  const base = Number((Number(blogger || 0) - Number(deposit || 0)).toFixed(2));
  const raw = Number((((rule === 'blogger' ? Number(blogger || 0) : base) * Math.max(0, Number(rate) || 0)) / 100).toFixed(2));
  const commission = base >= 0 ? Math.abs(raw) : raw;
  return {
    grossProfit: base,
    commission,
    commissionAbatement: 0,
    netProfit: Number((base - commission).toFixed(2)),
    commissionRate: Math.max(0, Number(rate) || 0),
  };
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
  const rate = commissionOf(session, order.companyId, module);
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
    ...profitOf(deposit, blogger, rate.rate, rate.rule),
  };
  if (contas && order.accountData) payload.depositRange = order.accountData.faixaDeposito || order.accountData.grupo || '';
  if (!contas && order.amountData && order.amountData.rollover) payload.rollover = order.amountData.rollover;
  return payload;
}
async function passTurnIfMine(sector) {
  const state = await localRequest(8765, 'GET', '/fila/estado', null);
  const ops = sector === 'montante' ? state.montante : state.contas;
  const me = String((state.me && state.me.id) || '');
  const active = (Array.isArray(ops) ? ops : []).filter((op) => op && op.active !== false);
  if (!me || !active[0] || String(active[0].userId) !== me || active.length < 2) return 'not-their-turn';
  const result = await localRequest(8765, 'POST', '/fila/acao', { action: 'pass', sector });
  return result && result.ok ? 'skipped' : 'not-their-turn';
}
async function acceptDesignated(session, orderId, options) {
  const claim = !!(options && options.claim);
  const takeOver = !!(options && options.takeOver);
  const order = await readOrder(session, orderId);
  if (!order) throw new Error('Pedido não encontrado.');
  if (order.status === 'Finalizado' || order.status === 'Cancelado') throw new Error('Este pedido já foi finalizado ou cancelado.');
  const meId = String(session.userId || '');
  const name = session.name || '';
  if (order.responsibleOperatorId && order.responsibleOperatorId !== meId) {
    throw new Error('Este pedido já foi assumido por outro operador (' + (order.responsibleOperatorName || 'outro operador') + ').');
  }
  const assigned = String(order.assignedOperatorId || '');
  const takeover = takeOver && !!assigned && assigned !== meId;
  if (takeover && !isManager(session) && order.companyId !== session.companyId) {
    throw new Error('Este pedido é de outra empresa.');
  }
  if (!takeover && assigned && assigned !== meId && !isManager(session)) {
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
  };
}
function isManager(session) {
  return session.role === 'ADM_MASTER' || session.role === 'SOCIO';
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
  const added = markedModules(order);
  added[module] = !added[module];
  await writeOrder(session, order, { addedModules: added });
  return { ok: true, addedModules: added };
}
async function finishOrder(session, id, done) {
  const order = await readOrder(session, id);
  if (!order) throw new Error('Pedido não encontrado.');
  const admin = isManager(session);
  const mine = order.responsibleOperatorId === session.userId;
  if (order.status === 'Cancelado') throw new Error('Pedido cancelado.');
  if (!done && !admin) throw new Error('Sócio ou administrador desmarca a finalização.');
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
async function actOnOrder(session, id, action, reason) {
  const order = await readOrder(session, id);
  if (!order) throw new Error('Pedido não encontrado.');
  if (order.status === 'Finalizado' || order.status === 'Cancelado') throw new Error('Este pedido já foi finalizado ou cancelado.');
  const admin = isManager(session);
  const mine = order.responsibleOperatorId === session.userId;
  const note = String(reason || '').trim();
  if (!note) throw new Error('Informe o motivo da ação.');
  const name = session.name || 'operador';
  if (action === 'return') {
    if (!mine && !admin) throw new Error('Só quem assumiu o pedido retorna à fila.');
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
    await addHistory(session, order, 'Pedido retornado à fila', 'Pedido retornado à fila por ' + name + '. Motivo: ' + note);
    return { ok: true, status: 'Retornado para fila' };
  }
  if (action === 'cancel') {
    if (!mine && !admin) throw new Error('Só quem assumiu o pedido cancela.');
    await writeOrder(session, order, { status: 'Cancelado', cancelledAt: new Date().toISOString() });
    await addHistory(session, order, 'Pedido cancelado', 'Pedido cancelado por ' + name + '. Motivo: ' + note);
    return { ok: true, status: 'Cancelado' };
  }
  throw new Error('Ação inválida.');
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
  if (url === '/pedidos' && req.method === 'GET') {
    const session = readSession();
    if (!session) {
      sendJson(res, 200, { ok: false, message: 'Entre na empresa para ver os pedidos.' });
      return;
    }
    panelRequest('query', { collection: 'orders', limit: 0, dfs_token: session.token })
      .then((result) => {
        let orders = rowsOf(result);
        const companyId = String(session.companyId || '');
        const linkIds = (Array.isArray(session.companyLinks) ? session.companyLinks : []).map((link) => String(link.companyId || '')).filter(Boolean);
        const allowed = new Set([companyId, ...linkIds].filter(Boolean));
        if (session.role !== 'ADM_MASTER' && allowed.size) {
          orders = orders.filter((order) => allowed.has(String(order.companyId || '')));
        }
        orders.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
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
  if (url === '/pedidos/sair' && req.method === 'POST') {
    try { fs.unlinkSync(sessionFile); } catch (e) {}
    imageMap = null;
    imageMapPromise = null;
    sendJson(res, 200, { ok: true });
    return;
  }
  if (url === '/pedidos/imagens' && req.method === 'GET') {
    const session = readSession();
    if (!session) { sendJson(res, 200, { ok: false, images: {} }); return; }
    const id = String(query.get('id') || '');
    const ids = String(query.get('ids') || '').split(',').map((part) => part.trim()).filter(Boolean).slice(0, 6);
    const sendMap = (map) => {
      if (id) sendJson(res, 200, { ok: true, images: map[id] || [] });
      else if (ids.length) {
        const part = {};
        ids.forEach((key) => { part[key] = map[key] || []; });
        sendJson(res, 200, { ok: true, images: part });
      } else sendJson(res, 200, { ok: true, images: {} });
    };
    loadImageMap(session).then((map) => {
      const wanted = id ? [id] : ids;
      const missing = wanted.some((key) => !map[key] || !map[key].length);
      if (missing && Date.now() - imageMapAt >= 4000) {
        imageMap = null;
        return loadImageMap(session, true).then(sendMap);
      }
      sendMap(map);
    }).catch(() => sendJson(res, 200, { ok: false, images: id ? [] : {} }));
    return;
  }
  res.writeHead(404);
  res.end();
});

let imageMap = null;
let imageMapAt = 0;
let imageMapPromise = null;
function loadImageMap(session, force) {
  if (!force && imageMap && Date.now() - imageMapAt < 4000) return Promise.resolve(imageMap);
  if (!force && imageMapPromise) return imageMapPromise;
  const companyId = String(session.companyId || '');
  const filters = session.role === 'ADM_MASTER' || !companyId
    ? []
    : [{ field: 'companyId', op: '==', value: companyId }];
  imageMapPromise = panelRequest('query', {
    collection: 'orderImages',
    filters,
    limit: 0,
    dfs_token: session.token,
  }).then((result) => {
    const map = {};
    rowsOf(result).forEach((row) => {
      const orderId = String(row.orderId || '');
      const dataUrl = String(row.dataUrl || row.url || '');
      if (!orderId || !dataUrl.startsWith('data:image/')) return;
      if (!map[orderId]) map[orderId] = [];
      if (map[orderId].length < 4) map[orderId].push(dataUrl);
    });
    imageMap = map;
    imageMapAt = Date.now();
    imageMapPromise = null;
    return map;
  }).catch((err) => {
    imageMapPromise = null;
    throw err;
  });
  return imageMapPromise;
}

server.listen(8767, '127.0.0.1');
