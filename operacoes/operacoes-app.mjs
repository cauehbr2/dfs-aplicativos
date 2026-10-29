import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(dir, 'dados');
const dataFile = path.join(dataDir, 'operacoes.json');
const sessionFile = path.join(dataDir, 'painel-sessao.json');
const rememberFile = path.join(dataDir, 'lembrar-login.json');
const siteFile = path.join(dataDir, 'painel-site.json');
const defaultOrigin = 'https://renovanow.online';
const htmlFile = path.join(dir, 'contas-operacoes.html');
const versionFile = path.join(dir, 'app-versao.txt');
const logoFile = path.join(dir, '..', '..', 'releases', 'elite-cpa-logo-4.png');
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
  return readOrigin();
}
function writeOrigin(origin, link) {
  const prev = readSite();
  let nextOrigin = String(origin || '').trim();
  try {
    const url = new URL(nextOrigin);
    if (!String(url.hostname || '').includes('.')) nextOrigin = '';
  } catch (e) { nextOrigin = ''; }
  // Não grava host truncado (elitecpasystem sem .digital) por cima do bom.
  if (!nextOrigin) nextOrigin = readOrigin();
  const nextLink = String(link == null ? (prev.link || '') : link).trim();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(siteFile, JSON.stringify({
    origin: nextOrigin,
    link: nextLink || nextOrigin,
  }));
}
const port = 8766;
let siteCatalog = null;
let catalogFlight = null;
let catalogKey = '';

fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, '{}\n');

function readSession() {
  try { return JSON.parse(fs.readFileSync(sessionFile, 'utf8')); } catch (e) { return null; }
}
function writeSession(session) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(sessionFile, JSON.stringify(session));
}
function readRemember() {
  try { return !!JSON.parse(fs.readFileSync(rememberFile, 'utf8')).save; } catch (e) { return false; }
}
function writeRemember(save) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(rememberFile, JSON.stringify({ save: !!save }));
}
function sessionModules(session) {
  const role = String((session && session.role) || '');
  const perms = Array.isArray(session && session.permissions) ? session.permissions : [];
  if (role === 'ADM_MASTER') return { contas: true, montante: true };
  const contas = perms.includes('contas');
  const montante = perms.includes('montante');
  if (!contas && !montante) return { contas: true, montante: false };
  return { contas, montante };
}
function applyProfileAccess(session, profile) {
  if (!session) return session;
  const data = profile && typeof profile === 'object' ? profile : {};
  const links = Array.isArray(data.companyLinks) ? data.companyLinks : (Array.isArray(session.companyLinks) ? session.companyLinks : []);
  session.companyLinks = links;
  const link = links.find((item) => item && item.companyId && item.companyId === session.companyId) || (links.length === 1 ? links[0] : null);
  session.role = (link && link.role) || data.role || session.role || '';
  const fromLink = link && Array.isArray(link.permissions) ? link.permissions : null;
  const fromProfile = Array.isArray(data.permissions) ? data.permissions : [];
  session.permissions = (fromLink && fromLink.length ? fromLink : fromProfile).map((item) => String(item));
  return session;
}
function publicSession(session) {
  if (!session || !session.token || !session.userId) return { ok: false, remember: readRemember() };
  const modules = sessionModules(session);
  return {
    ok: true,
    name: session.name || '',
    email: session.email || '',
    userId: session.userId,
    companyId: session.companyId || '',
    companyName: session.companyName || '',
    remember: readRemember(),
    contas: modules.contas,
    montante: modules.montante,
  };
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
      timeout: 90000,
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
const PANEL_RANGE_NAMES = {
  'grupo 01|10|11|5': '10 a 11 Grupo 01',
  'grupo 01|10|12|6': '10 a 12 Grupo 01',
  'grupo 01|10|13|7': '10 a 13',
  'grupo 01|11|13|8': '11 a 13 Grupo 01',
  'grupo 01|11|14|9': '11 a 14 Grupo 01',
  'grupo 01|12|15|10': '12 a 15 GRUPO 01',
  'grupo 01|12|18|11': '12 a 18 Grupo 01',
  'grupo 02|10|10|6': '10  Grupo 02',
  'grupo 02|10|11|7': '10 a 11 Grupo 02',
  'grupo 02|10|12|8': '10 a 12  Grupo 02',
  'grupo 02|12|15|11': '12 a 15',
  'grupo 02|13|18|12': '13 a 18',
  'grupo 03|10|10|7': '10 Grupo 03',
  'grupo 03|10|11|8': '10 A 11 Grupo 03',
  'grupo 03|11|12|9': '11 a 12  Grupo 03',
  'grupo 03|11|13|10': '11 A 13 Grupo 03',
  'grupo 03|12|15|11': '12 a 15',
  'grupo 03|13|16|12': '13 a 16',
  'grupo 03|14|18|13': '14 a 18',
};
function readOpsFile(target = dataFile) {
  try {
    const data = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, data: null };
    if (!Array.isArray(data.ops)) data.ops = [];
    return { ok: true, data };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, data: { ops: [] } };
    return { ok: false, data: null };
  }
}
function safeProfileId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
}
function profileId() {
  const session = readSession();
  return safeProfileId(session && session.userId);
}
function claimExistingHistory() {
  const ownerPath = path.join(dataDir, 'operacoes.dono');
  if (fs.existsSync(ownerPath)) return;
  const id = profileId();
  if (!id || !fs.existsSync(dataFile)) return;
  const destDir = path.join(dataDir, 'perfis', id);
  const dest = path.join(destDir, 'operacoes.json');
  fs.mkdirSync(destDir, { recursive: true });
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(dataFile, dest);
    const antes = path.join(dataDir, 'operacoes.antes.json');
    if (fs.existsSync(antes)) fs.copyFileSync(antes, path.join(destDir, 'operacoes.antes.json'));
  }
  fs.writeFileSync(ownerPath, JSON.stringify({ userId: id }));
}
function activeDataFile() {
  const id = profileId();
  if (!id) return null;
  const dest = path.join(dataDir, 'perfis', id, 'operacoes.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, JSON.stringify({ ops: [] }));
  return dest;
}
function readOps() {
  const file = activeDataFile();
  if (!file) return { ops: [], ranges: [], rate: 0 };
  const loaded = readOpsFile(file);
  return loaded.ok ? loaded.data : { ops: [], ranges: [], rate: 0 };
}
function opIdentity(op) {
  if (!op || typeof op !== 'object') return '';
  const id = op.id != null ? String(op.id).trim() : '';
  if (id) return 'id:' + id;
  const client = String(op.client || op.clientName || op.accountName || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const date = String(op.date || '').trim().slice(0, 16);
  const deposit = Math.round((Number(op.deposit) || 0) * 100);
  const qty = Math.round(Number(op.qty != null ? op.qty : op.requestedAccounts) || 0);
  return 'k:' + [client, date, deposit, qty].join('|');
}
function normalizeRemovedIds(...lists) {
  const seen = new Set();
  const out = [];
  lists.forEach((list) => {
    (Array.isArray(list) ? list : []).forEach((id) => {
      const key = String(id == null ? '' : id).trim();
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(key);
    });
  });
  return out.slice(-5000);
}
function mergeOps(diskOps, incomingOps, removedIds) {
  const removed = new Set(normalizeRemovedIds(removedIds).map((id) => 'id:' + id));
  const incomingList = (Array.isArray(incomingOps) ? incomingOps : []).filter((op) => op && typeof op === 'object');
  const diskList = (Array.isArray(diskOps) ? diskOps : []).filter((op) => op && typeof op === 'object');
  const incomingByKey = new Map();
  incomingList.forEach((op) => {
    const key = opIdentity(op);
    if (key && !removed.has(key)) incomingByKey.set(key, op);
  });
  const diskKeys = new Set(diskList.map((op) => opIdentity(op)).filter(Boolean));
  const seen = new Set();
  const ops = [];
  incomingList.forEach((op) => {
    const key = opIdentity(op);
    if (!key || removed.has(key) || diskKeys.has(key) || seen.has(key)) return;
    seen.add(key);
    ops.push(op);
  });
  let stale = false;
  diskList.forEach((op) => {
    const key = opIdentity(op);
    if (!key || removed.has(key) || seen.has(key)) return;
    const updated = incomingByKey.get(key);
    if (!updated) stale = true;
    seen.add(key);
    ops.push(updated || op);
  });
  return { ops, stale };
}
function mergeState(disk, incoming) {
  const base = disk && typeof disk === 'object' ? disk : { ops: [] };
  const body = incoming && typeof incoming === 'object' ? incoming : {};
  const removedIds = normalizeRemovedIds(base.removedIds, body.removedIds);
  const merged = mergeOps(base.ops, body.ops, removedIds);
  const next = merged.stale ? { ...body, ...base, ops: merged.ops } : { ...base, ...body, ops: merged.ops };
  const incomingStamp = Number(body.viewStamp) || 0;
  const diskStamp = Number(base.viewStamp) || 0;
  if (incomingStamp >= diskStamp) {
    if (body.dateRange) next.dateRange = body.dateRange;
    if (body.customStart != null) next.customStart = body.customStart;
    if (body.customEnd != null) next.customEnd = body.customEnd;
    if (body.screen === 'contas' || body.screen === 'montante') next.screen = body.screen;
    if (incomingStamp) next.viewStamp = incomingStamp;
  } else {
    next.dateRange = base.dateRange;
    next.customStart = base.customStart;
    next.customEnd = base.customEnd;
    next.screen = base.screen;
    next.viewStamp = diskStamp;
  }
  next.removedIds = removedIds;
  return next;
}
function opDay(op) {
  const match = String(op && op.date || '').match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}
function listDays(ops) {
  const days = new Set();
  (Array.isArray(ops) ? ops : []).forEach((op) => {
    const day = opDay(op);
    if (day) days.add(day);
  });
  return days;
}
function withoutRemoved(ops, removedIds) {
  const removed = new Set(normalizeRemovedIds(removedIds));
  return (Array.isArray(ops) ? ops : []).filter((op) => !(op && op.id != null && removed.has(String(op.id))));
}
function retainDiskOps(diskOps, nextOps, removedIds) {
  const removed = new Set(normalizeRemovedIds(removedIds));
  const ops = [];
  const seen = new Set();
  const push = (op) => {
    if (!op || typeof op !== 'object') return;
    if (op.id != null && removed.has(String(op.id))) return;
    const key = opIdentity(op);
    if (!key || seen.has(key)) return;
    seen.add(key);
    ops.push(op);
  };
  (Array.isArray(nextOps) ? nextOps : []).forEach(push);
  (Array.isArray(diskOps) ? diskOps : []).forEach(push);
  return ops;
}
function opsOfMissingDays(sourceOps, presentOps) {
  const present = listDays(presentOps);
  return (Array.isArray(sourceOps) ? sourceOps : []).filter((op) => {
    const day = opDay(op);
    return day && !present.has(day);
  });
}
function backupIsRicher(backupOps, currentOps) {
  const currentDays = listDays(currentOps);
  for (const day of listDays(backupOps)) {
    if (!currentDays.has(day)) return true;
  }
  return (backupOps || []).length > (currentOps || []).length;
}
function daysLost(beforeOps, afterOps, removedIds) {
  const removed = new Set(normalizeRemovedIds(removedIds));
  const afterDays = listDays(afterOps);
  const lost = [];
  listDays(beforeOps).forEach((day) => {
    if (afterDays.has(day)) return;
    const ids = beforeOps.filter((op) => opDay(op) === day).map((op) => (op && op.id != null ? String(op.id) : ''));
    const allExplicit = ids.length > 0 && ids.every((id) => id && removed.has(id));
    if (!allExplicit) lost.push(day);
  });
  return lost;
}
function readJsonOps(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || !Array.isArray(data.ops)) return [];
    return data.ops.filter((op) => op && typeof op === 'object');
  } catch (e) {
    return [];
  }
}
function floorOps(diskOps, backupOps, incomingOps, removedIds) {
  const diskKept = withoutRemoved(diskOps, removedIds);
  const backupKept = withoutRemoved(backupOps, removedIds);
  const floor = retainDiskOps(opsOfMissingDays(backupKept, diskKept), diskKept, removedIds);
  return retainDiskOps(floor, incomingOps, removedIds);
}
function stampSent(disk, state) {
  const stamps = new Map();
  (Array.isArray(state && state.ops) ? state.ops : []).forEach((op) => {
    if (!op || op.id == null || !op.panelId) return;
    stamps.set(String(op.id), { panelId: op.panelId, panelSentAt: op.panelSentAt || '' });
  });
  const ops = (Array.isArray(disk.ops) ? disk.ops : []).map((op) => {
    if (!op || op.id == null) return op;
    const stamp = stamps.get(String(op.id));
    if (!stamp) return op;
    return { ...op, panelId: stamp.panelId, panelSentAt: stamp.panelSentAt };
  });
  return { ...disk, ops };
}
function commitJson(data, target = dataFile, removedIds = []) {
  const folder = path.dirname(target);
  const tmp = target + '.tmp';
  const backupFile = path.join(folder, 'operacoes.antes.json');
  fs.mkdirSync(folder, { recursive: true });
  const diskOps = fs.existsSync(target) ? readJsonOps(target) : [];
  const backupOps = fs.existsSync(backupFile) ? readJsonOps(backupFile) : [];
  let diskRemoved = [];
  try {
    const current = JSON.parse(fs.readFileSync(target, 'utf8'));
    diskRemoved = current && Array.isArray(current.removedIds) ? current.removedIds : [];
  } catch (e) { diskRemoved = []; }
  const tombstones = normalizeRemovedIds(diskRemoved, data && data.removedIds, removedIds);
  const healed = floorOps(diskOps, backupOps, Array.isArray(data.ops) ? data.ops : [], tombstones);
  const protectedOps = withoutRemoved(diskOps, tombstones).concat(opsOfMissingDays(withoutRemoved(backupOps, tombstones), withoutRemoved(diskOps, tombstones)));
  const lost = daysLost(protectedOps, healed, tombstones);
  if (lost.length) {
    throw new Error('A gravação tiraria o dia ' + lost.join(', ') + '. O arquivo ficou como estava.');
  }
  const payload = { ...data, ops: healed, removedIds: tombstones };
  fs.writeFileSync(tmp, JSON.stringify(payload));
  if (fs.existsSync(target)) {
    const diskKept = withoutRemoved(diskOps, tombstones);
    const backupKept = withoutRemoved(backupOps, tombstones);
    let snapshot = null;
    const keepRichBackup = backupIsRicher(backupKept, diskKept) && fs.existsSync(backupFile);
    try { snapshot = JSON.parse(fs.readFileSync(keepRichBackup ? backupFile : target, 'utf8')); } catch (e) { snapshot = null; }
    if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
      snapshot.ops = keepRichBackup ? backupKept : diskKept;
      snapshot.removedIds = tombstones;
      fs.writeFileSync(backupFile, JSON.stringify(snapshot));
    }
  }
  try {
    try {
      fs.renameSync(tmp, target);
    } catch (e) {
      if (fs.existsSync(target)) fs.rmSync(target);
      fs.renameSync(tmp, target);
    }
  } catch (err) {
    if (!fs.existsSync(target) && fs.existsSync(backupFile)) fs.copyFileSync(backupFile, target);
    try { fs.rmSync(tmp, { force: true }); } catch (e) {}
    throw err;
  }
  return payload;
}
function persistState(incoming, target) {
  const file = target || activeDataFile();
  if (!file) return null;
  if (!incoming || typeof incoming !== 'object' || !Array.isArray(incoming.ops)) return null;
  const loaded = readOpsFile(file);
  if (!loaded.ok) return null;
  const backupOps = readJsonOps(path.join(path.dirname(file), 'operacoes.antes.json'));
  const removedIds = normalizeRemovedIds(loaded.data.removedIds, incoming.removedIds);
  const baseOps = floorOps(loaded.data.ops || [], backupOps, [], removedIds);
  const next = mergeState({ ...loaded.data, ops: baseOps, removedIds }, { ...incoming, removedIds });
  next.ops = floorOps(loaded.data.ops || [], backupOps, next.ops, removedIds);
  next.removedIds = removedIds;
  return commitJson(next, file, removedIds);
}
function writeOps(state) {
  const file = activeDataFile();
  if (!file) throw new Error('Entre na conta para gravar o histórico.');
  const loaded = readOpsFile(file);
  if (!loaded.ok) throw new Error('Não li as operações. Nada foi regravado.');
  commitJson(stampSent(loaded.data, state), file);
}
function panelDate(value) {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return text.slice(0, 16);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return '';
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}
function panelRangeName(range) {
  if (!range) return '';
  const group = String(range.group || '').replace(/\s+/g, ' ').trim();
  const start = Number(range.start);
  const end = Number(range.end);
  const price = Number(range.price) || 0;
  const known = PANEL_RANGE_NAMES[[group.toLowerCase(), start, end, price].join('|')];
  if (known) return known;
  const span = start === end ? String(start) : start + ' a ' + end;
  return group ? span + ' ' + group : span;
}
function operationForPanel(op, state) {
  const ranges = Array.isArray(state.ranges) ? state.ranges : [];
  const range = ranges.find((item) => item.id === op.range);
  const links = (Array.isArray(op.links) ? op.links : [op.link]).map((item) => String(item || '').trim()).filter(Boolean);
  const date = panelDate(op.date);
  return {
    date,
    createdAt: date,
    accountName: op.client || '',
    phone: op.phone || '',
    houseLink: links[0] || '',
    houseLinks: links.length ? links : [''],
    requestedAccounts: Number(op.qty) || 0,
    clearedAccounts: 0,
    withdrawnAccounts: 0,
    deposit: Number(op.deposit) || 0,
    withdrawal: Number(op.withdrawal) || 0,
    blogger: Number(op.blogger) || 0,
    commission: Number(op.commission) || 0,
    commissionAbatement: 0,
    commissionRate: Number(state.rate) || 0,
    grossProfit: Number(op.gross) || 0,
    netProfit: Number(op.net) || 0,
    bankAccountId: '',
    notes: '',
    depositRange: panelRangeName(range) || '',
    rollover: '',
    promocao: false,
    verificado: !!op.verificado,
    discountApplied: Number(op.discount) || 0,
    clientId: 'none',
    clientName: op.client || '',
    clientPhone: op.phone || '',
  };
}
function roundMoney(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function foldText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
function normalizeCategory(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  const tagged = text.match(/^(lista|grupo)\s*0*(\d+)$/i);
  if (!tagged) return text;
  const kind = tagged[1].toLowerCase() === 'grupo' ? 'Grupo' : 'Lista';
  return kind + ' ' + tagged[2].padStart(2, '0');
}
function sameGroup(a, b) {
  const left = normalizeCategory(a).toLowerCase();
  const right = normalizeCategory(b).toLowerCase();
  if (!left && !right) return true;
  if (!left || !right) return false;
  if (left === right) return true;
  const numA = left.match(/^(?:grupo|lista)\s+(\d+)$/);
  const numB = right.match(/^(?:grupo|lista)\s+(\d+)$/);
  return !!(numA && numB && numA[1] === numB[1]);
}
function rangeGroupLabel(range) {
  if (!range) return '';
  const explicit = normalizeCategory(range.categoria || range.group || '');
  if (explicit) return explicit;
  const nome = String(range.nome || range.name || '').trim();
  const match = nome.match(/\s+((?:lista|grupo)\s*\d+)\s*$/i);
  return match ? normalizeCategory(match[1]) : '';
}
function spanOf(range) {
  if (!range) return null;
  if (range.somaInicio != null && range.somaInicio !== '' && range.somaFim != null && range.somaFim !== '') {
    const start = Number(range.somaInicio);
    const end = Number(range.somaFim);
    if (Number.isFinite(start) && Number.isFinite(end)) return [start, end];
  }
  if (range.start != null && range.start !== '' && range.end != null && range.end !== '' && range.nome == null) {
    const start = Number(range.start);
    const end = Number(range.end);
    if (Number.isFinite(start) && Number.isFinite(end)) return [start, end];
  }
  const nome = String(range.nome || range.name || '').replace(/(grupo|lista)\s*\d+/ig, ' ');
  const nums = nome.match(/\d+(?:[.,]\d+)?/g);
  if (!nums || !nums.length) return null;
  const values = nums.map((n) => Number(String(n).replace(',', '.')));
  if (!values.length) return null;
  return values.length === 1 ? [values[0], values[0]] : [values[0], values[1]];
}
function momentParts(value) {
  const text = panelDate(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(text);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), 0, 0);
  if (Number.isNaN(date.getTime())) return null;
  return {
    day: match[1] + '-' + match[2] + '-' + match[3],
    time: match[4] + ':' + match[5],
    week: ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'][date.getDay()],
  };
}
function ruleIsContas(rule) {
  return String((rule && rule.module) || '').trim().toLowerCase() === 'contas';
}
function isAllGroupsLabel(group) {
  const raw = String(group || '').trim().toLowerCase();
  return !raw || raw === 'todos' || raw === 'todos os grupos' || raw === 'all';
}
function campaignWindow(campaign, parts) {
  if (!campaign || !parts) return false;
  const startDate = String(campaign.startDate || '').trim();
  const endDate = String(campaign.endDate || '').trim();
  if (startDate && parts.day < startDate) return false;
  if (endDate && parts.day > endDate) return false;
  const startTime = String(campaign.startTime || '').trim();
  const endTime = String(campaign.endTime || '').trim();
  if (startTime && endTime && (parts.time < startTime || parts.time > endTime)) return false;
  const days = Array.isArray(campaign.weekDays) ? campaign.weekDays : [];
  if (days.length && !days.includes(parts.week)) return false;
  return true;
}
function campaignAppliesContas(campaign) {
  const rules = Array.isArray(campaign.groupDiscounts) ? campaign.groupDiscounts : [];
  if (rules.some(ruleIsContas)) return true;
  if ((Number(campaign.discountContas) || 0) > 0) return true;
  if (campaign.category === 'Contas') return true;
  if (campaign.category === 'Montantes') return false;
  return true;
}
function contasDiscountPercent(campaign, groupLabel) {
  const rules = (Array.isArray(campaign.groupDiscounts) ? campaign.groupDiscounts : []).filter(ruleIsContas);
  if (!rules.length) return Number(campaign.discountContas) || 0;
  const group = normalizeCategory(groupLabel || '');
  if (group) {
    const exact = rules.find((rule) => !isAllGroupsLabel(rule.group) && sameGroup(rule.group, group));
    if (exact) return Number(exact.percent) || 0;
  }
  const all = rules.find((rule) => isAllGroupsLabel(rule.group));
  if (all) return Number(all.percent) || 0;
  return 0;
}
function pickCampaign(campaigns, parts) {
  const live = (Array.isArray(campaigns) ? campaigns : []).filter((campaign) => (
    (campaign.status === 'Ativa' || campaign.status === 'Agendada')
    && campaignWindow(campaign, parts)
    && campaignAppliesContas(campaign)
  ));
  live.sort((a, b) => {
    const kind = (campaign) => (campaign.panelKind === 'semanal' ? 1 : 0);
    if (kind(a) !== kind(b)) return kind(a) - kind(b);
    const status = (campaign) => (campaign.status === 'Ativa' ? 0 : 1);
    return status(a) - status(b);
  });
  return live[0] || null;
}
function catalogBlock(catalog) {
  if (!catalog || !catalog.clientsOk) return 'O site não devolveu os clientes. Não enviei.';
  if (!catalog.rangesOk || !catalog.ranges.length) return 'O site não devolveu as faixas de depósito. Não enviei.';
  if (!catalog.campaignsOk) return 'O site não devolveu o desconto do dia. Não enviei.';
  return '';
}
function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}
function barePhone(value) {
  const digits = phoneDigits(value);
  if (digits.startsWith('55') && digits.length > 11) return digits.slice(2);
  return digits;
}
function samePhone(a, b) {
  const left = barePhone(a);
  const right = barePhone(b);
  return left.length >= 8 && left === right;
}
function sitePhone(client) {
  if (!client) return '';
  const typed = String(client.phone || client.contact || client.whatsapp || '').trim();
  if (typed) return typed;
  const digits = phoneDigits(client.normalizedPhone);
  return digits.length >= 8 ? digits : '';
}
function clientPhoneKeys(client) {
  if (!client) return [];
  return [client.phone, client.contact, client.whatsapp, client.normalizedPhone].filter((value) => String(value || '').trim());
}
function nameHits(catalog, name) {
  const wanted = foldText(name);
  if (!wanted) return [];
  return (catalog.clients || []).filter((item) => foldText(item.name) === wanted || foldText(item.normalizedName) === wanted);
}
function phoneHits(catalog, phone) {
  if (barePhone(phone).length < 8) return [];
  return (catalog.clients || []).filter((item) => clientPhoneKeys(item).some((value) => samePhone(value, phone)));
}
function narrowClients(hits, typedName) {
  if (hits.length === 1) return hits[0];
  const typed = String(typedName || '').replace(/\s+/g, ' ').trim();
  const exact = hits.filter((item) => String(item.name || '').replace(/\s+/g, ' ').trim() === typed);
  return exact.length === 1 ? exact[0] : null;
}
function matchClient(op, catalog) {
  const typedName = String(op.client || '').replace(/\s+/g, ' ').trim();
  if (!foldText(typedName)) return { error: 'Tem operação sem cliente. Não enviei.' };
  const byName = nameHits(catalog, typedName);
  const byPhone = phoneHits(catalog, op.phone);
  const named = narrowClients(byName, typedName);
  if (byName.length > 1 && !named) {
    if (byPhone.length === 1 && byName.some((item) => item.id === byPhone[0].id)) return { client: byPhone[0] };
    if (byPhone.length === 1) {
      return { error: 'O nome "' + typedName + '" e o telefone apontam para clientes diferentes no site. Não criei outro e não substituí.' };
    }
    return { error: 'Há mais de um cliente "' + typedName + '" no site. Não criei outro e não substituí.' };
  }
  const nameClient = named || (byName.length === 1 ? byName[0] : null);
  if (nameClient) return { client: nameClient };
  const phone = String(op.phone || '').trim();
  return {
    create: {
      name: typedName,
      normalizedName: foldText(typedName),
      phone,
      normalizedPhone: phoneDigits(phone),
    },
  };
}
function queueNewClients(ops, catalog) {
  const problems = [];
  const creates = [];
  const shadow = (catalog.clients || []).slice();
  (ops || []).forEach((op) => {
    const found = matchClient(op, { ...catalog, clients: shadow });
    if (found.error) {
      problems.push(found.error);
      return;
    }
    if (found.client) {
      if (found.client.pending && !sitePhone(found.client) && barePhone(op.phone).length >= 8) {
        found.client.phone = String(op.phone || '').trim();
        found.client.normalizedPhone = phoneDigits(op.phone);
      }
      return;
    }
    const draft = found.create;
    const client = {
      id: crypto.randomBytes(10).toString('hex'),
      name: draft.name,
      normalizedName: draft.normalizedName,
      phone: draft.phone,
      normalizedPhone: draft.normalizedPhone,
      pending: true,
    };
    shadow.push(client);
    creates.push(client);
  });
  return { problems: [...new Set(problems)], creates };
}
async function ensureSiteClients(ops, catalog, session) {
  const queued = queueNewClients(ops, catalog);
  if (queued.problems.length || !queued.creates.length) return queued;
  const now = new Date().toISOString();
  for (let index = 0; index < queued.creates.length; index += 8) {
    const slice = queued.creates.slice(index, index + 8);
    const result = await panelRequest('batch', {
      ops: slice.map((client) => ({
        type: 'set',
        collection: 'clients',
        id: client.id,
        merge: false,
        data: {
          id: client.id,
          name: client.name,
          normalizedName: client.normalizedName,
          phone: client.phone,
          normalizedPhone: client.normalizedPhone,
          companyId: session.companyId,
          createdAt: now,
          updatedAt: now,
          createdBy: session.userId,
          lastUsedAt: now,
          usageCount: 1,
          active: true,
        },
      })),
      dfs_token: session.token,
    });
    const json = result.json || {};
    if (result.status >= 400 || !Array.isArray(json.results)) {
      throw new Error(json.message || 'O site não cadastrou o cliente novo. Não enviei.');
    }
    catalog.clients = (catalog.clients || []).concat(slice);
  }
  catalog.clients.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  siteCatalog = catalog;
  return queued;
}
function matchSiteRange(op, state, catalog) {
  const list = catalog.ranges;
  const named = list.filter((item) => String(item.nome || '').trim());
  const byId = named.find((item) => item.id === op.range);
  if (byId) return { range: byId };
  const local = (Array.isArray(state.ranges) ? state.ranges : []).find((item) => item.id === op.range) || null;
  const localName = foldText(local && local.name);
  const label = foldText(op.rangeLabel);
  const exact = named.filter((item) => {
    const nome = foldText(item.nome);
    return nome && (nome === localName || nome === label);
  });
  if (exact.length === 1) return { range: exact[0] };
  const localSpan = local ? spanOf(local) : spanOf({ name: op.rangeLabel || '' });
  const localGroup = (local && local.group) || rangeGroupLabel({ nome: op.rangeLabel || '' });
  const spans = named.filter((item) => {
    const span = spanOf(item);
    if (!span || !localSpan || span[0] !== localSpan[0] || span[1] !== localSpan[1]) return false;
    const siteGroup = rangeGroupLabel(item);
    return !!(siteGroup && localGroup && sameGroup(siteGroup, localGroup));
  });
  if (spans.length === 1) return { range: spans[0] };
  if (spans.length > 1 && local) {
    const priced = spans.filter((item) => Number(item.valor) === Number(local.price));
    if (priced.length === 1) return { range: priced[0] };
  }
  const shown = (local && local.name) || op.rangeLabel || op.range || 'faixa';
  return { error: 'A faixa "' + shown + '" não é a mesma do site. Não enviei com outro nome.' };
}
function discountFor(op, siteRange, catalog) {
  const parts = momentParts(op.date);
  if (!parts) return { error: 'A data da operação não fecha com o desconto do site. Não enviei.' };
  const campaign = pickCampaign(catalog.campaigns, parts);
  if (!campaign) {
    if (op.discount == null || op.discount === '') {
      return { error: 'A sincronização do desconto não foi feita porque não há desconto configurado. Configure manualmente.' };
    }
    const manual = Number(op.discount);
    if (!Number.isFinite(manual)) {
      return { error: 'A sincronização do desconto não foi feita porque não há desconto configurado. Configure manualmente.' };
    }
    return { percent: manual };
  }
  const percent = contasDiscountPercent(campaign, rangeGroupLabel(siteRange));
  if (!Number.isFinite(percent)) return { error: 'O site não devolveu o desconto do dia. Não enviei.' };
  return { percent };
}
function sitePayload(op, state, catalog) {
  const blocked = catalogBlock(catalog);
  if (blocked) return { error: blocked };
  const client = matchClient(op, catalog);
  if (client.error) return client;
  if (client.create) return { create: client.create };
  const range = matchSiteRange(op, state, catalog);
  if (range.error) return range;
  const nome = String(range.range.nome || '').trim();
  if (!nome) return { error: 'O site devolveu uma faixa sem nome. Não enviei com outro nome.' };
  const price = Number(range.range.valor);
  if (!Number.isFinite(price)) return { error: 'A faixa "' + nome + '" do site não trouxe o valor. Não enviei com um número chute.' };
  const discount = discountFor(op, range.range, catalog);
  if (discount.error) return discount;
  const base = operationForPanel(op, state);
  const qty = Number(op.qty) || 0;
  const subtotal = price * qty;
  const blogger = roundMoney(Math.max(0, subtotal - subtotal * (discount.percent / 100)));
  const deposit = Number(op.deposit) || 0;
  const withdrawal = Number(op.withdrawal) || 0;
  const gross = roundMoney((withdrawal + blogger) - deposit);
  const rate = Math.max(0, Number(state.rate) || 0);
  const raw = roundMoney((gross * rate) / 100);
  const commission = gross >= 0 ? Math.abs(raw) : raw;
  const net = roundMoney(gross - commission);
  const phone = sitePhone(client.client);
  return {
    data: {
      ...base,
      accountName: client.client.name,
      phone,
      blogger,
      commission,
      grossProfit: gross,
      netProfit: net,
      depositRange: nome,
      discountApplied: discount.percent,
      clientId: client.client.id,
      clientName: client.client.name,
      clientPhone: phone,
    },
  };
}
function mapCompanyDocs(result) {
  const json = result.json || {};
  if (result.status >= 400 || !Array.isArray(json.docs)) {
    return { ok: false, rows: [] };
  }
  return { ok: true, rows: json.docs.map((doc) => ({ id: doc.id, ...(doc.data || {}) })) };
}
function settleCompany(session) {
  if (!session || session.companyId) return session;
  const links = Array.isArray(session.companyLinks) ? session.companyLinks : [];
  if (links.length === 1 && links[0] && links[0].companyId) {
    session.companyId = links[0].companyId;
    session.companyName = links[0].companyName || links[0].name || '';
    applyProfileAccess(session, { companyLinks: links });
    writeSession(session);
  }
  return session;
}
async function pullCatalog(session, key) {
  const filters = [{ field: 'companyId', op: '==', value: session.companyId }];
  const body = { filters, limit: 0, dfs_token: session.token };
  const [clientsRes, rangesRes, campaignsRes, ratesRes, rulesRes] = await Promise.all([
    panelRequest('query', { ...body, collection: 'clients' }),
    panelRequest('query', { ...body, collection: 'calculatorRanges' }),
    panelRequest('query', { ...body, collection: 'campaigns' }),
    panelRequest('query', { ...body, collection: 'calculatorMontanteRates' }),
    panelRequest('query', { ...body, collection: 'calculatorMontanteAccountRules' }),
  ]);
  const clients = mapCompanyDocs(clientsRes);
  const ranges = mapCompanyDocs(rangesRes);
  const campaigns = mapCompanyDocs(campaignsRes);
  const catalog = {
    key,
    companyId: session.companyId,
    clientsOk: clients.ok,
    rangesOk: ranges.ok,
    campaignsOk: campaigns.ok,
    clients: clients.ok ? clients.rows.map((item) => ({
      id: item.id,
      name: String(item.name || '').replace(/\s+/g, ' ').trim(),
      normalizedName: item.normalizedName || '',
      phone: String(item.phone || item.contact || item.whatsapp || '').trim(),
      normalizedPhone: phoneDigits(item.normalizedPhone),
    })).filter((item) => item.name).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')) : [],
    ranges: ranges.ok ? ranges.rows.map((item) => ({
      id: item.id,
      nome: String(item.nome || '').replace(/\s+/g, ' ').trim(),
      valor: item.valor,
      somaInicio: item.somaInicio,
      somaFim: item.somaFim,
      categoria: item.categoria || '',
      order: item.order,
    })).filter((item) => item.nome).sort((a, b) => {
      const ao = a.order != null ? Number(a.order) : 999999;
      const bo = b.order != null ? Number(b.order) : 999999;
      if (ao !== bo) return ao - bo;
      return a.nome.localeCompare(b.nome, 'pt-BR');
    }) : [],
    campaigns: campaigns.ok ? campaigns.rows.map((item) => ({
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
    })) : [],
    rates: mapCompanyDocs(ratesRes).ok ? mapCompanyDocs(ratesRes).rows.map((item) => ({
      id: item.id,
      multiplicador: Number(item.multiplicador) || 0,
      taxa: Number(item.taxa) || 0,
      observacao: String(item.observacao || ''),
      order: item.order,
    })).sort((a, b) => {
      const ao = a.order != null ? Number(a.order) : 999999;
      const bo = b.order != null ? Number(b.order) : 999999;
      if (ao !== bo) return ao - bo;
      return a.multiplicador - b.multiplicador;
    }) : [],
    accountRules: mapCompanyDocs(rulesRes).ok ? mapCompanyDocs(rulesRes).rows.map((item) => ({
      montante: Number(item.montante) || 0,
      qtdContas: Number(item.qtdContas) || 0,
    })).filter((item) => item.montante > 0).sort((a, b) => a.montante - b.montante) : [],
  };
  siteCatalog = catalog;
  return catalog;
}
function ensureCatalog(session, options) {
  settleCompany(session);
  if (!session || !session.token || !session.companyId) {
    return Promise.resolve({ clientsOk: false, rangesOk: false, campaignsOk: false, clients: [], ranges: [], campaigns: [], rates: [], accountRules: [] });
  }
  const key = session.companyId + '|' + session.userId;
  const fresh = !!(options && options.fresh);
  if (fresh) {
    siteCatalog = null;
    if (catalogKey === key) catalogKey = '';
  }
  if (!fresh && siteCatalog && siteCatalog.key === key) return Promise.resolve(siteCatalog);
  if (catalogFlight && catalogKey === key) return catalogFlight;
  catalogKey = key;
  catalogFlight = pullCatalog(session, key).finally(() => { catalogFlight = null; });
  return catalogFlight;
}
function publicCatalog(session, catalog) {
  const data = catalog || { clientsOk: false, rangesOk: false, campaignsOk: false, clients: [], ranges: [], campaigns: [], rates: [], accountRules: [] };
  const clients = data.clients || [];
  const ranges = data.ranges || [];
  const rates = data.rates || [];
  const accountRules = data.accountRules || [];
  const parts = [];
  if (data.clientsOk) parts.push(clients.length + ' cliente' + (clients.length === 1 ? '' : 's'));
  if (data.rangesOk) parts.push(ranges.length + ' faixa' + (ranges.length === 1 ? '' : 's'));
  if (rates.length) parts.push(rates.length + ' taxa' + (rates.length === 1 ? '' : 's'));
  if (accountRules.length) parts.push(accountRules.length + ' regra' + (accountRules.length === 1 ? '' : 's') + ' de montante');
  return {
    ok: !!(data.clientsOk && data.rangesOk && data.campaignsOk),
    name: (session && session.name) || '',
    email: (session && session.email) || '',
    companyId: (session && session.companyId) || '',
    companyName: (session && session.companyName) || '',
    clientsOk: !!data.clientsOk,
    rangesOk: !!data.rangesOk,
    campaignsOk: !!data.campaignsOk,
    clients,
    ranges,
    campaigns: data.campaigns || [],
    rates,
    accountRules,
    synced: {
      clients: clients.length,
      ranges: ranges.length,
      rates: rates.length,
      montante: accountRules.length,
    },
    message: catalogBlock(data) || (parts.length ? ('Sincronizado: ' + parts.join(', ') + '.') : ''),
  };
}
function prepareSiteOps(pending, state, catalog) {
  const problems = [];
  const prepared = [];
  const blocked = catalogBlock(catalog);
  if (blocked) return { problems: [blocked], prepared };
  pending.forEach((op) => {
    const built = sitePayload(op, state, catalog);
    if (built.error) problems.push(built.error);
    else if (built.create) problems.push('O cliente "' + built.create.name + '" não foi criado no site. Não enviei.');
    else prepared.push({ op, data: built.data });
  });
  return { problems: [...new Set(problems)], prepared };
}
function ownedBySession(data, session) {
  const operatorId = String((data && data.operatorId) || '');
  if (operatorId && session.userId && operatorId !== session.userId) return false;
  if (operatorId && operatorId === session.userId) return true;
  const mine = foldText(session.name);
  const names = [data.operatorName, data.operator, data.createdByName].map((item) => foldText(item)).filter(Boolean);
  return !!(mine && names.includes(mine));
}
function localOpFromSite(doc, session) {
  const data = (doc && doc.data) || {};
  const moduleName = data.module === 'montante' ? 'montante' : 'contas';
  const date = localMinute(data.date);
  const links = Array.isArray(data.houseLinks) && data.houseLinks.length ? data.houseLinks : [data.houseLink || ''];
  const withdrawal = Number(data.withdrawal) || 0;
  return {
    id: 'site-' + doc.id,
    panelId: doc.id,
    panelSentAt: data.updatedAt || data.createdAt || '',
    module: moduleName,
    verificado: !!data.verificado,
    date,
    dateLabel: date ? new Date(date).toLocaleString('pt-BR') : '',
    client: String(data.accountName || data.clientName || data.client || '').replace(/\s+/g, ' ').trim(),
    operator: session.name || data.operatorName || '',
    links,
    link: links[0] || '',
    phone: String(data.clientPhone || data.phone || ''),
    range: '',
    rangeLabel: moduleName === 'montante' ? String(data.rollover || data.depositRange || '') : String(data.depositRange || ''),
    qty: Number(data.requestedAccounts) || 0,
    deposit: Number(data.deposit) || 0,
    withdrawal,
    blogger: Number(data.blogger) || 0,
    gross: Number(data.grossProfit) || 0,
    commission: Number(data.commission) || 0,
    net: Number(data.netProfit) || 0,
    discount: data.discountApplied,
    saques: [String(withdrawal || '')],
    taxa: Number(data.taxa) || 0,
    taxaLabel: String(data.rollover || ''),
  };
}
function pullOwnedOps(session, from, to, moduleName) {
  return companyOperations(session).then((docs) => {
    const state = readOps();
    const known = new Set((state.ops || []).map((op) => op.panelId).filter(Boolean));
    const wanted = moduleName === 'montante' ? 'montante' : 'contas';
    let added = 0;
    docs.forEach((doc) => {
      const data = doc.data || {};
      const moduleOf = data.module === 'montante' ? 'montante' : 'contas';
      if (moduleOf !== wanted) return;
      if (!ownedBySession(data, session)) return;
      const day = localMinute(data.date).slice(0, 10);
      if (!day || day < from || day > to) return;
      if (known.has(doc.id)) return;
      const op = localOpFromSite(doc, session);
      if (!op.client || !op.date) return;
      state.ops.push(op);
      known.add(doc.id);
      added += 1;
    });
    if (added) writeOps(state);
    return { added, total: (state.ops || []).filter((op) => (op.module === 'montante' ? 'montante' : 'contas') === wanted).length };
  });
}
function dayKey(op) {
  const date = panelDate(op.date);
  return date ? date.slice(0, 10) : '';
}
function formatLocal(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}
function localMinute(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'number' || /^\d{12,}$/.test(String(value).trim())) {
    const date = new Date(Number(value));
    if (!Number.isNaN(date.getTime())) return formatLocal(date);
  }
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) return text;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return panelDate(text);
  return formatLocal(date);
}
function opName(data) {
  return String(data.accountName || data.clientName || data.client || '').replace(/\s+/g, ' ').trim().toLowerCase();
}
function operationKey(data) {
  const name = opName(data);
  const qty = Math.round(Number(data.requestedAccounts ?? data.qty) || 0);
  const deposit = Math.round((Number(data.deposit) || 0) * 100);
  const withdrawal = Math.round((Number(data.withdrawal) || 0) * 100);
  return [localMinute(data.date), name, qty, deposit, withdrawal].join('|');
}
function sameOperation(data) {
  const name = opName(data);
  const qty = Math.round(Number(data.requestedAccounts ?? data.qty) || 0);
  const deposit = Math.round((Number(data.deposit) || 0) * 100);
  const withdrawal = Math.round((Number(data.withdrawal) || 0) * 100);
  return [name, qty, deposit, withdrawal].join('|');
}
function nextDay(key) {
  const parts = String(key || '').split('-').map(Number);
  const date = new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1);
  date.setDate(date.getDate() + 1);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return date.getFullYear() + '-' + month + '-' + day;
}
async function companyOperations(session) {
  const result = await panelRequest('query', {
    collection: 'operations',
    filters: [{ field: 'companyId', op: '==', value: session.companyId }],
    limit: 0,
    dfs_token: session.token,
  });
  const json = result.json || {};
  if (result.status >= 400 || !Array.isArray(json.docs)) {
    throw new Error(json.message || 'Não consegui ler as operações do painel.');
  }
  return json.docs;
}
function alreadyThere(docs, op, state, ourIds) {
  const data = operationForPanel(op, state);
  const minute = localMinute(data.date);
  const money = sameOperation(data);
  const foreign = docs.filter((doc) => {
    if (!doc || ourIds.has(doc.id) || doc.id === op.panelId) return false;
    const row = doc.data || {};
    return sameOperation(row) === money;
  });
  if (foreign.length === 1) return foreign[0].id;
  const sameTime = foreign.filter((doc) => localMinute((doc.data || {}).date) === minute);
  if (sameTime.length === 1) return sameTime[0].id;
  return '';
}
async function removeRepeated(session, state, day) {
  const sent = (state.ops || []).filter((op) => op.panelId && (day === 'tudo' || dayKey(op) === day));
  if (!sent.length) return 0;
  const docs = await companyOperations(session);
  const ourIds = new Set((state.ops || []).map((op) => op.panelId).filter(Boolean));
  const present = new Set(docs.map((doc) => doc.id));
  const remove = [];
  const relink = new Map();
  sent.forEach((op) => {
    const kept = alreadyThere(docs, op, state, ourIds);
    if (!kept || !present.has(op.panelId)) return;
    remove.push(op.panelId);
    relink.set(op.id, kept);
  });
  for (let index = 0; index < remove.length; index += 8) {
    const slice = remove.slice(index, index + 8);
    const result = await panelRequest('batch', {
      ops: slice.map((id) => ({ type: 'delete', collection: 'operations', id })),
      dfs_token: session.token,
    });
    const json = result.json || {};
    if (result.status >= 400 || !Array.isArray(json.results)) {
      throw new Error(json.message || 'Não consegui tirar a cópia repetida.');
    }
  }
  if (!relink.size) return 0;
  const now = new Date().toISOString();
  state.ops = state.ops.map((op) => relink.has(op.id) ? { ...op, panelId: relink.get(op.id), panelSentAt: now } : op);
  writeOps(state);
  return relink.size;
}
function dayLabel(key) {
  const parts = String(key || '').split('-');
  if (parts.length !== 3) return key;
  return parts[2] + '/' + parts[1] + '/' + parts[0];
}
function pendingDays(state) {
  const counts = new Map();
  (state.ops || []).forEach((op) => {
    if (op.panelId) return;
    const key = dayKey(op);
    if (!key) return;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([id, count]) => ({
      id,
      count,
      label: dayLabel(id) + ' · ' + count + (count === 1 ? ' operação' : ' operações'),
    }));
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
    } catch (e) {
      return '';
    }
  }
  return text.replace(/^\/+|\/+$/g, '');
}
function panelGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 20000 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
let captchaCache = null;
let captchaOrigin = '';
async function captchaConfig() {
  const origin = readOrigin();
  if (captchaCache && captchaOrigin === origin) return captchaCache;
  const json = await panelGet(origin + '/?dfs_api=site');
  captchaOrigin = origin;
  captchaCache = {
    enabled: !!json.recaptchaEnabled && !!json.recaptchaSiteKey,
    siteKey: json.recaptchaSiteKey || '',
    origin,
  };
  return captchaCache;
}
function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2_000_000) {
        reject(new Error('grande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/dados/operacoes.json' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    const file = activeDataFile();
    res.end(file && fs.existsSync(file) ? fs.readFileSync(file) : JSON.stringify({ ops: [] }));
    return;
  }
  if (url === '/dados/operacoes.json' && req.method === 'POST') {
    readBody(req).then((body) => {
      if (!profileId()) {
        sendJson(res, 401, { message: 'Entre na conta para gravar o histórico.' });
        return;
      }
      if (!body || !Array.isArray(body.ops)) {
        sendJson(res, 400, { message: 'Não gravei: a lista de operações não veio completa.' });
        return;
      }
      try {
        const saved = persistState(body);
        if (!saved) {
          sendJson(res, 500, { message: 'Não gravei: o arquivo atual não pôde ser lido.' });
          return;
        }
        sendJson(res, 200, saved);
      } catch (e) {
        sendJson(res, 500, { message: 'Não gravei o arquivo.' });
      }
    }).catch(() => sendJson(res, 400, { message: 'Não gravei: não li os dados.' }));
    return;
  }
  if (url === '/painel/cadastro' && req.method === 'GET') {
    const session = readSession();
    if (!session || !session.token) {
      sendJson(res, 200, { ok: false });
      return;
    }
    settleCompany(session);
    if (!session.companyId) {
      sendJson(res, 200, { ok: false, name: session.name || '', email: session.email || '', message: 'A conta não tem empresa nesta sessão.' });
      return;
    }
    ensureCatalog(session, { fresh: true })
      .then((catalog) => sendJson(res, 200, publicCatalog(session, catalog)))
      .catch(() => sendJson(res, 200, { ok: false, name: session.name || '', message: 'O site não devolveu o cadastro.' }));
    return;
  }
  if (url === '/painel/captcha' && req.method === 'GET') {
    captchaConfig().then((cfg) => sendJson(res, 200, cfg)).catch(() => sendJson(res, 200, { enabled: false, siteKey: '', origin: readOrigin() }));
    return;
  }
  if (url === '/painel/site' && req.method === 'GET') {
    sendJson(res, 200, { origin: readOrigin(), link: readSavedLink() });
    return;
  }
  if (url === '/painel/site' && req.method === 'POST') {
    readBody(req).then((body) => {
      const raw = String(body.link || body.origin || body.companySlug || '').trim();
      let fromBody = '';
      let fromRaw = '';
      try {
        const parsed = new URL(String(body.origin || ''));
        if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
          fromBody = parsed.origin;
        }
      } catch (e) { fromBody = ''; }
      try {
        if (/^https?:\/\//i.test(raw) || /\./.test((raw.split('/')[0] || ''))) {
          const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
          if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
            fromRaw = parsed.origin;
          }
        }
      } catch (e) { fromRaw = ''; }
      const origin = fromBody || fromRaw || readOrigin();
      if (!origin) {
        sendJson(res, 400, { message: 'O link da empresa não serve. Use o endereço do site, com https.' });
        return;
      }
      writeOrigin(origin, raw || origin);
      captchaCache = null;
      captchaOrigin = '';
      sendJson(res, 200, { origin, link: readSavedLink() });
    }).catch(() => sendJson(res, 400, { message: 'Não li o link do site.' }));
    return;
  }
  if (url === '/painel/status' && req.method === 'GET') {
    const session = readSession();
    const perms = Array.isArray(session && session.permissions) ? session.permissions : [];
    const known = session && (session.role === 'ADM_MASTER' || perms.includes('contas') || perms.includes('montante'));
    const finish = () => sendJson(res, 200, publicSession(session));
    if (!session || !session.token || known) {
      finish();
      return;
    }
    panelRequest('auth/me', { dfs_token: session.token }).then((me) => {
      applyProfileAccess(session, (me.json && me.json.profile) || {});
      writeSession(session);
      finish();
    }).catch(() => finish());
    return;
  }
  if (url === '/painel/sair' && req.method === 'POST') {
    try { fs.unlinkSync(sessionFile); } catch (e) {}
    writeRemember(false);
    siteCatalog = null;
    catalogKey = '';
    sendJson(res, 200, { ok: true });
    return;
  }
  if (url === '/painel/lembrar' && req.method === 'POST') {
    readBody(req).then((body) => {
      writeRemember(!!body.save);
      sendJson(res, 200, { save: readRemember() });
    }).catch(() => sendJson(res, 400, { message: 'Não li a opção de salvar.' }));
    return;
  }
  if (url === '/painel/puxar' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const session = readSession();
      if (!session || !session.token) {
        sendJson(res, 401, { message: 'Entre no painel de novo.' });
        return;
      }
      settleCompany(session);
      const from = String(body.from || '').slice(0, 10);
      const to = String(body.to || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
        sendJson(res, 400, { message: 'Escolha a data inicial e a data final.' });
        return;
      }
      const moduleName = body.module === 'montante' ? 'montante' : 'contas';
      try {
        const result = await pullOwnedOps(session, from, to, moduleName);
        sendJson(res, 200, {
          added: result.added,
          message: result.added
            ? result.added + ' operações suas entraram no aplicativo.'
            : 'Nesse período não havia operação sua nova no site.',
        });
      } catch (e) {
        sendJson(res, 502, { message: e.message || 'Não consegui ler as operações do site.' });
      }
    }).catch(() => sendJson(res, 400, { message: 'Não li o período.' }));
    return;
  }
  if (url === '/painel/empresa' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const session = readSession();
      if (!session || !session.token) {
        sendJson(res, 401, { message: 'Entre no painel de novo.' });
        return;
      }
      session.companyId = String(body.companyId || '');
      session.companyName = String(body.companyName || '');
      applyProfileAccess(session, { companyLinks: session.companyLinks });
      writeSession(session);
      siteCatalog = null;
      catalogKey = '';
      try { await ensureCatalog(session); } catch (e) {}
      sendJson(res, 200, publicSession(session));
    }).catch(() => sendJson(res, 400, { message: 'Não li a empresa.' }));
    return;
  }
  if (url === '/painel/usar' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const token = String(body.token || '').trim();
      if (!token) {
        sendJson(res, 400, { message: 'A sessão do painel não veio.' });
        return;
      }
      try {
        const me = await panelRequest('auth/me', { dfs_token: token });
        const json = me.json || {};
        const profile = json.profile || {};
        const auth = json.auth || {};
        if (me.status >= 400 || !auth.uid) {
          sendJson(res, me.status >= 400 ? me.status : 401, { message: json.message || 'A sessão do painel não valeu.' });
          return;
        }
        writeSession({
          token,
          userId: auth.uid || profile.id || '',
          name: auth.displayName || profile.name || '',
          email: auth.email || '',
          companyId: profile.companyId || '',
          companyName: '',
          companyLinks: Array.isArray(profile.companyLinks) ? profile.companyLinks : [],
        });
        const session = applyProfileAccess(readSession(), profile);
        writeSession(session);
        try { await ensureCatalog(session); } catch (e) {}
        sendJson(res, 200, publicSession(session));
      } catch (e) {
        sendJson(res, 502, { message: 'Não consegui falar com o painel.' });
      }
    }).catch(() => sendJson(res, 400, { message: 'Não li a sessão.' }));
    return;
  }
  if (url === '/painel/entrar' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      try {
        const rawLink = String(body.link || body.companySlug || body.origin || '').trim();
        let fromBody = '';
        let fromRaw = '';
        try {
          const parsed = new URL(String(body.origin || ''));
          if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
            fromBody = parsed.origin;
          }
        } catch (e) { fromBody = ''; }
        try {
          if (/^https?:\/\//i.test(rawLink) || /\./.test((rawLink.split('/')[0] || ''))) {
            const parsed = new URL(/^https?:\/\//i.test(rawLink) ? rawLink : 'https://' + rawLink);
            if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
              fromRaw = parsed.origin;
            }
          }
        } catch (e) { fromRaw = ''; }
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
        writeSession({
          token: json.token,
          userId: (json.user && json.user.uid) || profile.id || '',
          name: (json.user && json.user.displayName) || profile.name || '',
          email: (json.user && json.user.email) || '',
          companyId: profile.companyId || '',
          companyName: '',
          companyLinks: Array.isArray(profile.companyLinks) ? profile.companyLinks : [],
        });
        const session = applyProfileAccess(readSession(), profile);
        writeSession(session);
        try { await ensureCatalog(session); } catch (e) {}
        sendJson(res, 200, publicSession(session));
      } catch (e) {
        sendJson(res, 502, { message: 'Não consegui falar com o painel.' });
      }
    }).catch(() => sendJson(res, 400, { message: 'Não li o login.' }));
    return;
  }
  if (url === '/painel/chamar' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const session = readSession();
      if (!session || !session.token) {
        sendJson(res, 401, { message: 'Entre no painel de novo.' });
        return;
      }
      const apiPath = String(body.path || '');
      if (!['query', 'auth/me'].includes(apiPath)) {
        sendJson(res, 400, { message: 'Chamada não permitida.' });
        return;
      }
      try {
        const result = await panelRequest(apiPath, { ...(body.json || {}), dfs_token: session.token });
        sendJson(res, result.status, result.json || {});
      } catch (e) {
        sendJson(res, 502, { message: 'Não consegui falar com o painel.' });
      }
    }).catch(() => sendJson(res, 400, { message: 'Não li a chamada.' }));
    return;
  }
  if (url === '/painel/dias' && req.method === 'GET') {
    const state = readOps();
    const open = pendingDays(state);
    sendJson(res, 200, { days: open, total: open.reduce((sum, day) => sum + day.count, 0) });
    return;
  }
  if (url === '/painel/enviar-dia' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const session = readSession();
      if (!session || !session.token || !session.userId) {
        sendJson(res, 401, { message: 'Entre no painel de novo.' });
        return;
      }
      if (!session.companyId && Array.isArray(session.companyLinks) && session.companyLinks.length === 1) {
        session.companyId = session.companyLinks[0].companyId || '';
        session.companyName = session.companyLinks[0].companyName || session.companyLinks[0].name || '';
        writeSession(session);
      }
      if (!session.companyId) {
        sendJson(res, 400, { message: 'Escolha a empresa antes de enviar.' });
        return;
      }
      const wanted = String(body.day || '');
      const loaded = readOpsFile();
      if (!loaded.ok) {
        sendJson(res, 500, { message: 'Não li as operações daqui. Nada foi regravado.' });
        return;
      }
      const state = loaded.data;
      const pending = (state.ops || []).filter((op) => !op.panelId && (wanted === 'tudo' || dayKey(op) === wanted));
      if (!pending.length) {
        sendJson(res, 200, {
          sent: 0,
          message: 'Nada novo para enviar.',
        });
        return;
      }
      let catalog;
      try {
        catalog = await ensureCatalog(session);
      } catch (e) {
        sendJson(res, 502, { message: 'O site não devolveu o cadastro. Não enviei.' });
        return;
      }
      const blocked = catalogBlock(catalog);
      if (blocked) {
        sendJson(res, 400, { message: blocked });
        return;
      }
      try {
        const placed = await ensureSiteClients(pending, catalog, session);
        if (placed.problems.length) {
          sendJson(res, 400, { message: placed.problems.slice(0, 6).join(' ') });
          return;
        }
      } catch (e) {
        sendJson(res, 502, { message: e.message || 'O site não cadastrou o cliente novo. Não enviei.' });
        return;
      }
      const ready = prepareSiteOps(pending, state, catalog);
      if (ready.problems.length) {
        sendJson(res, 400, { message: ready.problems.slice(0, 6).join(' ') });
        return;
      }
      const preparedById = new Map(ready.prepared.map((item) => [String(item.op.id), item.data]));
      let sent = 0;
      let linked = 0;
      try {
        const docs = await companyOperations(session);
        const ourIds = new Set((state.ops || []).map((op) => op.panelId).filter(Boolean));
        const now = new Date().toISOString();
        const fresh = [];
        pending.forEach((op) => {
          const already = alreadyThere(docs, op, state, ourIds);
          if (!already) {
            fresh.push(op);
            return;
          }
          linked += 1;
          state.ops = state.ops.map((item) => item.id === op.id ? { ...item, panelId: already, panelSentAt: now } : item);
        });
        if (linked) writeOps(state);
        if (!fresh.length) {
          sendJson(res, 200, { sent: 0, message: 'Essas operações já estavam no painel.' });
          return;
        }
        for (let index = 0; index < fresh.length; index += 8) {
          const slice = fresh.slice(index, index + 8);
          const items = slice.map((op) => ({
            localId: op.id,
            panelId: crypto.randomBytes(10).toString('hex'),
            data: preparedById.get(String(op.id)),
          }));
          if (items.some((item) => !item.data || !String(item.data.depositRange || '').trim() || !Number.isFinite(Number(item.data.discountApplied)) || !item.data.clientId || item.data.clientId === 'none')) {
            sendJson(res, 400, { message: 'O site não devolveu cliente, faixa ou desconto. Não enviei.' });
            return;
          }
          const ops = items.map((item) => ({
            type: 'set',
            collection: 'operations',
            id: item.panelId,
            data: {
              ...(item.data || {}),
              id: item.panelId,
              module: 'contas',
              operatorId: session.userId,
              companyId: session.companyId,
            },
            merge: false,
          }));
          const result = await panelRequest('batch', { ops, dfs_token: session.token });
          const json = result.json || {};
          if (result.status >= 400 || !Array.isArray(json.results)) {
            if (result.status === 401) {
              try { fs.unlinkSync(sessionFile); } catch (e) {}
            }
            sendJson(res, result.status >= 400 ? result.status : 502, {
              message: json.message || 'O painel não gravou.',
              sent,
            });
            return;
          }
          const ids = new Map(items.map((item, itemIndex) => [
            item.localId,
            (json.results[itemIndex] && json.results[itemIndex].id) || item.panelId,
          ]));
          const sentAt = new Date().toISOString();
          state.ops = (state.ops || []).map((op) => ids.has(op.id)
            ? { ...op, panelId: ids.get(op.id), panelSentAt: sentAt }
            : op);
          writeOps(state);
          sent += ids.size;
        }
        const skipped = linked ? ' ' + linked + (linked === 1 ? ' já estava no painel.' : ' já estavam no painel.') : '';
        sendJson(res, 200, {
          sent,
          message: (sent ? sent + (sent === 1 ? ' operação foi para o painel.' : ' operações foram para o painel.') : 'Nada novo para enviar.') + skipped,
        });
      } catch (e) {
        sendJson(res, 502, { message: e.message || 'Não consegui falar com o painel.', sent });
      }
    }).catch(() => sendJson(res, 400, { message: 'Não li o dia.' }));
    return;
  }
  if (url === '/painel/enviar' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const session = readSession();
      if (!session || !session.token || !session.userId) {
        sendJson(res, 401, { message: 'Entre no painel de novo.' });
        return;
      }
      settleCompany(session);
      if (!session.companyId) {
        sendJson(res, 400, { message: 'Escolha a empresa antes de enviar.' });
        return;
      }
      const items = Array.isArray(body.items) ? body.items.slice(0, 8) : [];
      if (!items.length) {
        sendJson(res, 200, { sent: [] });
        return;
      }
      const loaded = readOpsFile();
      if (!loaded.ok) {
        sendJson(res, 500, { message: 'Não li as operações daqui. Nada foi regravado.' });
        return;
      }
      const wantedIds = new Set(items.map((item) => String(item.localId)));
      const pending = (loaded.data.ops || []).filter((op) => wantedIds.has(String(op.id)));
      if (pending.length !== items.length) {
        sendJson(res, 400, { message: 'Não achei todas as operações daqui. Nada foi enviado.' });
        return;
      }
      let catalog;
      try {
        catalog = await ensureCatalog(session);
      } catch (e) {
        sendJson(res, 502, { message: 'O site não devolveu o cadastro. Não enviei.' });
        return;
      }
      const blocked = catalogBlock(catalog);
      if (blocked) {
        sendJson(res, 400, { message: blocked });
        return;
      }
      try {
        const placed = await ensureSiteClients(pending, catalog, session);
        if (placed.problems.length) {
          sendJson(res, 400, { message: placed.problems.slice(0, 6).join(' ') });
          return;
        }
      } catch (e) {
        sendJson(res, 502, { message: e.message || 'O site não cadastrou o cliente novo. Não enviei.' });
        return;
      }
      const ready = prepareSiteOps(pending, loaded.data, catalog);
      if (ready.problems.length) {
        sendJson(res, 400, { message: ready.problems.slice(0, 6).join(' ') });
        return;
      }
      const preparedById = new Map(ready.prepared.map((item) => [String(item.op.id), item.data]));
      const ops = items.map((item) => ({
        type: 'set',
        collection: 'operations',
        id: item.panelId,
        data: {
          ...(preparedById.get(String(item.localId)) || {}),
          id: item.panelId,
          module: 'contas',
          operatorId: session.userId,
          companyId: session.companyId,
        },
        merge: false,
      }));
      try {
        const result = await panelRequest('batch', { ops, dfs_token: session.token });
        const json = result.json || {};
        if (result.status >= 400 || !Array.isArray(json.results)) {
          if (result.status === 401) {
            try { fs.unlinkSync(sessionFile); } catch (e) {}
          }
          sendJson(res, result.status >= 400 ? result.status : 502, { message: json.message || 'O painel não gravou.' });
          return;
        }
        const sent = items.map((item, index) => ({
          localId: item.localId,
          panelId: (json.results[index] && json.results[index].id) || item.panelId,
        }));
        sendJson(res, 200, { sent });
      } catch (e) {
        sendJson(res, 502, { message: 'Não consegui falar com o painel.' });
      }
    }).catch(() => sendJson(res, 400, { message: 'Não li as operações.' }));
    return;
  }
  if (url === '/elite-cpa-logo-4.png' && req.method === 'GET') {
    if (!fs.existsSync(logoFile)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
    });
    res.end(fs.readFileSync(logoFile));
    return;
  }
  if (url === '/app/versao' && req.method === 'GET') {
    sendJson(res, 200, { version: readAppVersion() });
    return;
  }
  if ((url === '/' || url === '/contas-operacoes.html') && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(fs.readFileSync(htmlFile));
    return;
  }
  res.writeHead(404);
  res.end();
});

function selfTest() {
  const catalog = {
    clientsOk: true,
    rangesOk: true,
    campaignsOk: true,
    clients: [
      { id: 'c1', name: 'Leticia Souza', normalizedName: 'leticia souza', phone: '' },
      { id: 'c2', name: 'Pv Baiano', normalizedName: 'pv baiano', phone: '(11) 98888-7777', normalizedPhone: '11988887777' },
    ],
    ranges: [{ id: 's1', nome: '10 a 11 Grupo 01', valor: 5, somaInicio: 10, somaFim: 11, categoria: 'Grupo 01' }],
    campaigns: [{
      status: 'Ativa',
      panelKind: 'dia',
      category: 'Contas',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      startTime: '00:00',
      endTime: '23:59',
      weekDays: ['sex', 'sab'],
      groupDiscounts: [{ module: 'Contas', group: 'Grupo 01', percent: 10 }],
    }],
  };
  const local = { rate: 20, ranges: [{ id: 'g1-10-11', group: 'Grupo 01', name: 'De 10 a 11', start: 10, end: 11, price: 5 }] };
  const op = { id: '1', client: 'leticia souza', date: '2026-10-24T21:11', qty: 5, deposit: 52, withdrawal: 0, range: 'g1-10-11', phone: '' };
  const built = sitePayload(op, local, catalog);
  if (built.error) throw new Error(built.error);
  if (built.data.depositRange !== '10 a 11 Grupo 01') throw new Error('faixa não veio do site');
  if (built.data.clientName !== 'Leticia Souza' || built.data.clientId !== 'c1') throw new Error('cliente não veio do site');
  if (built.data.phone !== '' || built.data.clientPhone !== '') throw new Error('inventou telefone');
  if (built.data.discountApplied !== 10 || built.data.blogger !== 22.5) throw new Error('desconto não veio do site');
  const byPhone = matchClient({ client: 'outro nome', phone: '11988887777' }, catalog);
  if (byPhone.client || !byPhone.create || byPhone.create.name !== 'outro nome') throw new Error('trocou o nome por outro cliente');
  const byName = sitePayload({ ...op, client: 'pv baiano', phone: '11900000000' }, local, catalog);
  if (byName.error || byName.data.clientName !== 'Pv Baiano' || byName.data.clientId !== 'c2') throw new Error('substituiu o cliente que já existe');
  const queued = queueNewClients([
    { id: 'n1', client: 'Ana Nova', phone: '11977776666' },
    { id: 'n2', client: 'ana nova', phone: '(11) 97777-6666' },
  ], catalog);
  if (queued.problems.length || queued.creates.length !== 1 || queued.creates[0].name !== 'Ana Nova') throw new Error('criou cliente repetido');
  const doisNomes = queueNewClients([
    { id: 'n1', client: 'Ana Nova', phone: '11977776666' },
    { id: 'n2', client: 'Ana Diferente', phone: '(11) 97777-6666' },
  ], catalog);
  if (doisNomes.problems.length || doisNomes.creates.length !== 2 || doisNomes.creates[1].name !== 'Ana Diferente') throw new Error('juntou nomes diferentes pelo telefone');
  const clash = matchClient({ client: 'Leticia Souza', phone: '11988887777' }, catalog);
  if (!clash.client || clash.client.id !== 'c1' || clash.create) throw new Error('nome existente não ficou o do site');
  const kept = matchClient({ client: 'Leticia Souza', phone: '' }, catalog);
  if (!kept.client || kept.client.id !== 'c1' || kept.create) throw new Error('cliente existente ia ser criado de novo');
  const invented = sitePayload({ ...op, range: 'outra' }, { rate: 20, ranges: [] }, catalog);
  if (!invented.error || invented.data) throw new Error('inventou faixa');
  const noDay = sitePayload({ ...op, date: '2026-10-21T10:00' }, local, catalog);
  if (!noDay.error) throw new Error('inventou desconto');
  const noSite = sitePayload(op, local, { ...catalog, campaignsOk: false, campaigns: [] });
  if (!noSite.error) throw new Error('enviou sem desconto do site');
  const disk = {
    rate: 20,
    tier1: { min: 1, percent: 10 },
    tier2: { min: 30, percent: 10 },
    ops: [
      { id: 'sab', client: 'Leticia', date: '2026-10-24T21:11', deposit: 52, qty: 5 },
      { id: 'sex', client: 'Pv Baiano', date: '2026-10-23T23:49', deposit: 73, qty: 7 },
    ],
  };
  const incoming = {
    rate: 20,
    tier1: { min: 1, percent: 0 },
    tier2: { min: 30, percent: 0 },
    ops: [{ id: 'sex', client: 'Pv Baiano', date: '2026-10-23T23:49', deposit: 73, qty: 7, panelId: 'abc' }],
  };
  const merged = mergeState(disk, incoming);
  if (merged.ops.length !== 2 || !merged.ops.some((op) => op.id === 'sab')) throw new Error('sábado sumiu');
  if (merged.tier1.percent !== 10 || merged.tier2.percent !== 10) throw new Error('desconto do disco foi trocado');
  if (merged.ops.find((op) => op.id === 'sex').panelId !== 'abc') throw new Error('atualização do mesmo id não entrou');
  const stamped = stampSent(disk, { ops: [{ id: 'sex', panelId: 'novo', client: 'outro', deposit: 1, qty: 1 }] });
  if (stamped.ops.length !== 2 || stamped.ops.find((op) => op.id === 'sab').client !== 'Leticia') throw new Error('lançamento apagou o outro dia');
  if (stamped.ops.find((op) => op.id === 'sex').client !== 'Pv Baiano' || stamped.ops.find((op) => op.id === 'sex').panelId !== 'novo') throw new Error('carimbo do painel não ficou só no id');
  const noId = mergeState(
    { ops: [{ client: 'Ana', date: '2026-10-24T10:00', deposit: 10, qty: 2 }] },
    { ops: [] },
  );
  if (noId.ops.length !== 1) throw new Error('chave sem id não segurou o registro');
  const dropped = mergeState(disk, { ...incoming, removedIds: ['sex'] });
  if (dropped.ops.some((op) => op.id === 'sex') || !dropped.ops.some((op) => op.id === 'sab')) throw new Error('apagar um id levou o outro dia');
  const real = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const semSabado = {
    ...real,
    tier1: { ...(real.tier1 || {}), percent: 0 },
    tier2: { ...(real.tier2 || {}), percent: 0 },
    ops: (real.ops || []).filter((op) => !String(op.date || '').startsWith('2026-10-24')),
  };
  const unido = mergeState(real, semSabado);
  const doSabado = (list) => (list.ops || []).filter((op) => String(op.date || '').startsWith('2026-10-24')).length;
  if (doSabado(real) < 15) throw new Error('o arquivo real não está com os 15 de sábado');
  if (doSabado(unido) !== doSabado(real) || unido.ops.length !== real.ops.length) throw new Error('união perderia o sábado do arquivo');
  if (unido.tier1.percent !== real.tier1.percent || unido.tier2.percent !== real.tier2.percent) throw new Error('união mudaria o desconto do arquivo');
  const carimbo = stampSent(real, { ops: semSabado.ops.map((op) => ({ ...op, panelId: 'x' })) });
  if (doSabado(carimbo) !== doSabado(real) || carimbo.ops.length !== real.ops.length) throw new Error('lançamento da sexta apagaria o sábado');
  const folder = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMP || path.dirname(dataFile), 'dfs-teste-gravacao-'));
  const target = path.join(folder, 'operacoes.json');
  fs.writeFileSync(target, '{"ops":[{"id":"a"}]}');
  commitJson({ ops: [{ id: 'a' }, { id: 'b' }] }, target);
  const back = JSON.parse(fs.readFileSync(target, 'utf8'));
  const antes = JSON.parse(fs.readFileSync(path.join(folder, 'operacoes.antes.json'), 'utf8'));
  if (back.ops.length !== 2 || antes.ops.length !== 1 || fs.existsSync(target + '.tmp')) throw new Error('troca atômica falhou');
  fs.rmSync(folder, { recursive: true, force: true });
  function shownWeekday(now, key) {
    const keys = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
    const index = keys.indexOf(key);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const day = new Date(today);
    day.setDate(today.getDate() - today.getDay() + index);
    const month = String(day.getMonth() + 1).padStart(2, '0');
    const date = String(day.getDate()).padStart(2, '0');
    return day.getFullYear() + '-' + month + '-' + date;
  }
  const domingo = new Date(2026, 9, 25, 0, 29);
  if (shownWeekday(domingo, 'sab') !== '2026-10-31') throw new Error('domingo mostrou o sábado da semana passada');
  if (shownWeekday(domingo, 'sex') !== '2026-10-30') throw new Error('domingo mostrou a sexta da semana passada');
  if (shownWeekday(domingo, 'seg') !== '2026-10-26') throw new Error('domingo mostrou a segunda da semana passada');
  if (shownWeekday(domingo, 'ter') !== '2026-10-27') throw new Error('domingo mostrou a terça da semana passada');
  if (shownWeekday(domingo, 'dom') !== '2026-10-25') throw new Error('domingo não ficou hoje');
  if (shownWeekday(new Date(2026, 9, 24, 21, 11), 'sab') !== '2026-10-24') throw new Error('sábado à noite mudou de dia');
  const realBefore = fs.readFileSync(dataFile);
  const copyDir = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMP || path.dirname(dataFile), 'dfs-teste-sabado-'));
  const copyFile = path.join(copyDir, 'operacoes.json');
  fs.copyFileSync(dataFile, copyFile);
  fs.copyFileSync(dataFile, path.join(copyDir, 'operacoes.antes.json'));
  const copiado = JSON.parse(fs.readFileSync(copyFile, 'utf8'));
  const diasDe = (ops) => [...listDays(ops)].sort().join(',');
  const semSabadoNoDisco = persistState({
    ...copiado,
    ops: (copiado.ops || []).filter((op) => !String(op.date || '').startsWith('2026-10-24')),
  }, copyFile);
  const gravado = JSON.parse(fs.readFileSync(copyFile, 'utf8'));
  if (!semSabadoNoDisco || doSabado(gravado) !== doSabado(copiado) || gravado.ops.length !== copiado.ops.length) {
    throw new Error('gravação sem sábado apagou o sábado do disco');
  }
  if (diasDe(gravado.ops) !== diasDe(copiado.ops)) throw new Error('gravação sem sábado reduziu os dias');
  const sexta = (ops) => ops.filter((op) => String(op.date || '').startsWith('2026-10-23')).length;
  if (sexta(gravado.ops) !== sexta(copiado.ops)) throw new Error('gravação sem sábado alterou a sexta');
  const umId = (copiado.ops || []).find((op) => String(op.date || '').startsWith('2026-10-23'));
  const aposDelete = persistState({
    ...gravado,
    ops: gravado.ops.filter((op) => op.id !== umId.id),
    removedIds: [umId.id],
  }, copyFile);
  const semUm = JSON.parse(fs.readFileSync(copyFile, 'utf8'));
  if (!aposDelete || semUm.ops.some((op) => op.id === umId.id) || doSabado(semUm) !== doSabado(copiado)) {
    throw new Error('delete explícito não ficou só naquele id');
  }
  const depoisSemTombstone = persistState({
    ...semUm,
    dateRange: 'seg',
    viewStamp: Date.now(),
    ops: semUm.ops.filter((op) => op.id !== umId.id),
    removedIds: [],
  }, copyFile);
  const seguiuApagado = JSON.parse(fs.readFileSync(copyFile, 'utf8'));
  if (!depoisSemTombstone || seguiuApagado.ops.some((op) => op.id === umId.id)) {
    throw new Error('apagar voltou no save seguinte sem removedIds');
  }
  if (seguiuApagado.dateRange !== 'seg') throw new Error('filtro do dia não gravou no save seguinte');
  const domDir = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMP || path.dirname(dataFile), 'dfs-teste-domingo-'));
  const domFile = path.join(domDir, 'operacoes.json');
  const domBase = {
    rate: 20,
    dateRange: 'dom',
    viewStamp: 1,
    ops: [
      { id: 'dom1', client: 'A', date: '2026-10-25T01:00', deposit: 10, qty: 1 },
      { id: 'qui1', client: 'B', date: '2026-10-29T12:00', deposit: 20, qty: 2 },
    ],
  };
  fs.writeFileSync(domFile, JSON.stringify(domBase));
  fs.writeFileSync(path.join(domDir, 'operacoes.antes.json'), JSON.stringify({
    ...domBase,
    ops: [...domBase.ops, { id: 'old', client: 'C', date: '2026-10-20T10:00', deposit: 1, qty: 1 }],
  }));
  persistState({
    ...domBase,
    ops: domBase.ops.filter((op) => op.id !== 'dom1'),
    removedIds: ['dom1'],
    viewStamp: 2,
  }, domFile);
  persistState({
    ...JSON.parse(fs.readFileSync(domFile, 'utf8')),
    dateRange: 'qui',
    viewStamp: 3,
    removedIds: [],
  }, domFile);
  const domCurado = JSON.parse(fs.readFileSync(domFile, 'utf8'));
  if (domCurado.ops.some((op) => op.id === 'dom1')) throw new Error('domingo apagado voltou pelo backup');
  if (domCurado.dateRange !== 'qui') throw new Error('troca de Dom para Qui não ficou');
  fs.rmSync(domDir, { recursive: true, force: true });
  const danoDir = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMP || path.dirname(dataFile), 'dfs-teste-backup-'));
  const danoFile = path.join(danoDir, 'operacoes.json');
  fs.copyFileSync(dataFile, path.join(danoDir, 'operacoes.antes.json'));
  const danificado = {
    ...copiado,
    ops: (copiado.ops || []).filter((op) => !String(op.date || '').startsWith('2026-10-24')),
  };
  fs.writeFileSync(danoFile, JSON.stringify(danificado));
  persistState(danificado, danoFile);
  const curado = JSON.parse(fs.readFileSync(danoFile, 'utf8'));
  const backupCurado = JSON.parse(fs.readFileSync(path.join(danoDir, 'operacoes.antes.json'), 'utf8'));
  if (doSabado(curado) !== doSabado(copiado) || doSabado(backupCurado) !== doSabado(copiado)) {
    throw new Error('arquivo danificado não recuperou o sábado da cópia anterior');
  }
  fs.rmSync(copyDir, { recursive: true, force: true });
  fs.rmSync(danoDir, { recursive: true, force: true });
  if (!realBefore.equals(fs.readFileSync(dataFile))) throw new Error('o teste gravou o arquivo real');
  console.log('ok');
}
if (process.argv[2] === '--test') selfTest();
else {
  claimExistingHistory();
  server.listen(port, '127.0.0.1');
}
