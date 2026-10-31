import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(dir, 'dados');
const dataFile = path.join(dataDir, 'operacoes.json');
const sessionFile = path.join(dataDir, 'painel-sessao.json');
const rememberFile = path.join(dataDir, 'lembrar-login.json');
const siteFile = path.join(dataDir, 'painel-site.json');
const catalogCacheFile = path.join(dataDir, 'painel-cadastro-cache.json');
const defaultOrigin = 'https://renovanow.online';
const versionFile = [
  path.join(dir, 'app-versao-operacoes.txt'),
  path.join(dir, 'app-versao.txt'),
].find((file) => fs.existsSync(file)) || path.join(dir, 'app-versao-operacoes.txt');
const logoLocal = path.join(dir, 'elite-cpa-logo-4.png');
const logoFile = fs.existsSync(logoLocal)
  ? logoLocal
  : path.join(dir, '..', '..', 'releases', 'elite-cpa-logo-4.png');
const sealJs = fs.existsSync(path.join(dir, 'ui-seal.mjs'))
  ? path.join(dir, 'ui-seal.mjs')
  : path.join(dir, '..', 'ui-seal.mjs');
const { loadUi } = await import(pathToFileURL(sealJs).href);
function uiHtml(name) {
  const raw = loadUi(dir, name);
  let html = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  if (name !== 'contas-operacoes' && name !== 'contas-operacoes.html') return html;

  html = html.replace(
    /if\s*\(\s*session\.ok\s*&&\s*\(\s*session\.remember\s*\|\|\s*flag\s*===\s*'1'\s*\)\s*\)/g,
    'if (session.ok)'
  );

  // Some a 2ª linha visual; mantém pull-from/to hidden pra UI selada antiga não quebrar o boot.
  if (/class=["']pull-row["']/.test(html)) {
    html = html.replace(
      /<div class="pull-row">[\s\S]*?<\/div>/,
      '<div class="pull-row" style="display:none!important" aria-hidden="true">'
        + '<input id="pull-from" type="hidden" />'
        + '<input id="pull-to" type="hidden" />'
        + '</div>'
    );
  } else if (!/id=["']pull-from["']/.test(html)) {
    html = html.replace(
      /<body[^>]*>/i,
      '$&<div class="pull-row" style="display:none!important" aria-hidden="true">'
        + '<input id="pull-from" type="hidden" />'
        + '<input id="pull-to" type="hidden" />'
        + '</div>'
    );
  }

  // NÃO reescreve o listener com regex (isso quebrava o JS e a tela perdia o login).
  // Só garante botão + aviso e um script final seguro.
  if (!/id=["']pull-site["']/.test(html) && /id=["']custom-dates["']/.test(html)) {
    html = html.replace(
      /(<div class="custom-dates"[^>]*>)([\s\S]*?)(<\/div>)/,
      '$1$2<button class="ghost" id="pull-site" type="button">Puxar do site</button>$3'
    );
  }
  if (!/id=["']pull-status["']/.test(html) && /id=["']pull-site["']/.test(html)) {
    html = html.replace(
      /(<button[^>]*id=["']pull-site["'][^>]*>[\s\S]*?<\/button>)/,
      '$1<span class="pull-status" id="pull-status" aria-live="polite"></span>'
    );
  }
  if (!html.includes('.pull-status{') && !html.includes('.pull-status {')) {
    html = html.replace(
      /<\/style>/i,
      '.pull-status{margin:0;min-height:18px;font-size:12px;font-weight:700;color:#a1a1aa;max-width:min(420px,100%)}'
        + '.pull-status.ok{color:#34d399}.pull-status.warn{color:#fbbf24}'
        + '.pull-status.err{color:#fb7185}.pull-status.busy{color:#93c5fd}</style>'
    );
  }

  // boot antigo: getElementById('pull-from').value estourava sem o input.
  html = html.replace(
    /if\s*\(!document\.getElementById\('pull-from'\)\.value\)\s*document\.getElementById\('pull-from'\)\.value\s*=\s*today\s*;/g,
    "try { var __pf=document.getElementById('pull-from'); var __ps=document.getElementById('custom-start'); if (__pf && !__pf.value) __pf.value = (__ps && __ps.value) || today; } catch(__e){}"
  );
  html = html.replace(
    /if\s*\(!document\.getElementById\('pull-to'\)\.value\)\s*document\.getElementById\('pull-to'\)\.value\s*=\s*today\s*;/g,
    "try { var __pt=document.getElementById('pull-to'); var __pe=document.getElementById('custom-end'); if (__pt && !__pt.value) __pt.value = (__pe && __pe.value) || today; } catch(__e){}"
  );

  html = html.replace(
    /from:\s*document\.getElementById\('pull-from'\)\.value,\s*to:\s*document\.getElementById\('pull-to'\)\.value,/g,
    "from: ((document.getElementById('custom-start')||document.getElementById('pull-from')||{}).value), to: ((document.getElementById('custom-end')||document.getElementById('pull-to')||{}).value),"
  );

  // Listener duro antigo: deixa de estourar se o botão não existir.
  html = html.replace(
    /document\.getElementById\('pull-site'\)\.addEventListener\(/g,
    "(document.getElementById('pull-site')||{addEventListener:function(){}}).addEventListener("
  );

  // Filtro por dia YYYY-MM-DD (UI selada antiga quebrava timezone e sumia a lista).
  if (!html.includes('function opDayKey')) {
    html = html.replace(
      /function inPeriod\(op\)\s*\{[\s\S]*?\n\}/,
      "function opDayKey(op){var raw=String((op&&op.date)||'');var m=raw.match(/(\\d{4})-(\\d{2})-(\\d{2})/);if(m)return m[1]+'-'+m[2]+'-'+m[3];var d=new Date(raw);return isNaN(d.getTime())?'':ymd(d);}"
        + "function inPeriod(op){if(state.dateRange==='all')return true;var day=opDayKey(op);if(!day)return false;var b=bounds();return day>=ymd(b.start)&&day<=ymd(b.end);}"
    );
  }

  if (!html.includes('id="dfs-pull-safe"')) {
    html = html.replace(/<\/body>/i, `<script id="dfs-pull-safe">
(function () {
  function setPullStatus(text, kind) {
    var el = document.getElementById('pull-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'pull-status' + (kind ? (' ' + kind) : '');
  }
  function showPulledPeriod(from, to, saved) {
    state = normalize(saved);
    state.dateRange = 'custom';
    state.customStart = from;
    state.customEnd = to;
    state.viewStamp = Date.now();
    usingFile = true;
    try {
      if (typeof currentUserId !== 'undefined' && currentUserId) {
        localStorage.setItem(storageKey(currentUserId), JSON.stringify(state));
      }
    } catch (e) {}
    if (typeof rememberView === 'function') rememberView();
    var startInput = document.getElementById('custom-start');
    var endInput = document.getElementById('custom-end');
    if (startInput) startInput.value = from;
    if (endInput) endInput.value = to;
    if (typeof paint === 'function') paint();
    return (typeof periodOps === 'function') ? periodOps().length : ((state.ops || []).length);
  }
  function bindPull() {
    var old = document.getElementById('pull-site');
    if (!old || old.getAttribute('data-dfs-pull') === '1') return;
    var btn = old.cloneNode(true);
    btn.setAttribute('data-dfs-pull', '1');
    old.parentNode.replaceChild(btn, old);
    if (!document.getElementById('pull-status') && btn.parentNode) {
      var span = document.createElement('span');
      span.className = 'pull-status';
      span.id = 'pull-status';
      span.setAttribute('aria-live', 'polite');
      btn.parentNode.insertBefore(span, btn.nextSibling);
    }
    btn.addEventListener('click', async function () {
      var session = { ok: false };
      try { session = await panelJson('/painel/status'); } catch (e) { session = { ok: false }; }
      if (!session.ok) {
        setPullStatus('Entre na conta pra puxar.', 'warn');
        var modal = document.getElementById('panel-modal');
        if (modal) modal.classList.add('gate');
        if (typeof openPanel === 'function') await openPanel({ login: true });
        return;
      }
      var fromEl = document.getElementById('custom-start') || document.getElementById('pull-from');
      var toEl = document.getElementById('custom-end') || document.getElementById('pull-to');
      var from = (fromEl && fromEl.value) || (typeof ymd === 'function' ? ymd(new Date()) : '');
      var to = (toEl && toEl.value) || from;
      if (!from || !to || from > to) {
        setPullStatus('Escolha a data inicial e a final.', 'warn');
        return;
      }
      var pf = document.getElementById('pull-from');
      var pt = document.getElementById('pull-to');
      if (pf) pf.value = from;
      if (pt) pt.value = to;
      btn.disabled = true;
      btn.textContent = 'Puxando…';
      setPullStatus('Puxando…', 'busy');
      try {
        var result = await panelJson('/painel/puxar', { from: from, to: to, module: screen });
        var response = await fetch('/dados/operacoes.json?ts=' + Date.now(), { cache: 'no-store' });
        if (!response.ok) throw new Error('Puxei no site, mas não reli o histórico deste PC.');
        var saved = await response.json();
        var visible = showPulledPeriod(from, to, saved);
        var msg = ((result && result.message) || 'Concluído.') + ' Mostrando ' + visible + ' neste período.';
        setPullStatus(msg, visible ? 'ok' : 'warn');
        if (typeof copyNote === 'function') copyNote(msg);
      } catch (e) {
        var em = (e && e.message) || 'Não puxei do site.';
        setPullStatus(em, 'err');
        if (typeof copyNote === 'function') copyNote(em);
      }
      btn.disabled = false;
      btn.textContent = 'Puxar do site';
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(bindPull, 0); });
  else setTimeout(bindPull, 0);
})();
</script></body>`);
  }
  // Sempre: crédito certo + menu da faixa por cima (UI do site/cache pode estar velha).
  html = html
    .replace(/Criado por\s*Cau[eêé](?:\s*BR)?/gi, 'Criado por Cauehbr')
    .replace(/Criado por\s*Kau[eêéiíy]+(?:\s*BR)?/gi, 'Criado por Cauehbr');
  if (!html.includes('id="dfs-ui-fix"')) {
    html = html.replace(/<\/body>/i, `<style id="dfs-ui-fix-css">
.range-menu{position:fixed!important;z-index:2147483000!important;margin:0!important;max-height:220px!important;box-shadow:0 18px 44px rgba(0,0,0,.55)!important}
.grid,.fields,.panel,.wrap,form{overflow:visible!important}
section.panel:has(.range-trigger.open){position:relative;z-index:4000}
section.panel:has(.range-trigger.open)~section.panel{z-index:1}
</style>
<script id="dfs-ui-fix">
(function(){
  function pin(menu, trigger, open){
    if(!menu) return;
    if(!open || !trigger){
      menu.style.top=menu.style.left=menu.style.width=menu.style.maxHeight='';
      return;
    }
    if(menu.parentElement !== document.body) document.body.appendChild(menu);
    var box=trigger.getBoundingClientRect();
    var gap=4;
    var below=window.innerHeight-box.bottom-12;
    var above=box.top-12;
    var prefer=below>=140||below>=above;
    var maxH=Math.max(120,Math.min(220, prefer?below:above));
    menu.style.width=Math.round(box.width)+'px';
    menu.style.left=Math.round(box.left)+'px';
    menu.style.maxHeight=maxH+'px';
    menu.style.top=prefer
      ? Math.round(box.bottom+gap)+'px'
      : Math.round(Math.max(8, box.top-gap-maxH))+'px';
  }
  function hook(renderName, openName, menuId, triggerId){
    var tries=0;
    (function wait(){
      tries++;
      if(typeof window[renderName] !== 'function'){
        if(tries<80) return setTimeout(wait,100);
        return;
      }
      var orig=window[renderName];
      window[renderName]=function(){
        var out=orig.apply(this, arguments);
        try{
          var trigger=document.getElementById(triggerId);
          var open=!!(trigger && trigger.classList.contains('open'));
          pin(document.getElementById(menuId), trigger, open);
        }catch(e){}
        return out;
      };
    })();
  }
  function isOpen(triggerId){
    var t=document.getElementById(triggerId);
    return !!(t && t.classList.contains('open'));
  }
  function syncAll(){
    try{
      pin(document.getElementById('range-menu'), document.getElementById('range-trigger'), isOpen('range-trigger'));
      pin(document.getElementById('taxa-menu'), document.getElementById('taxa-trigger'), isOpen('taxa-trigger'));
    }catch(e){}
  }
  hook('renderRanges','rangeOpen','range-menu','range-trigger');
  hook('renderTaxas','taxaOpen','taxa-menu','taxa-trigger');
  // Menu no body: seleciona a faixa/taxa aqui (não depende do range-box).
  document.addEventListener('click', function(event){
    try{
      var t=event.target;
      var rangeMenu=document.getElementById('range-menu');
      var rangeOpt=t && t.closest && t.closest('[data-range-id]');
      if(rangeOpt && rangeMenu && rangeMenu.contains(rangeOpt)){
        event.preventDefault();
        event.stopPropagation();
        var hidden=document.getElementById('range');
        if(hidden){
          hidden.value=rangeOpt.getAttribute('data-range-id')||'';
          try{ rangeOpen=false; }catch(e){ try{ window.rangeOpen=false; }catch(e2){} }
          if(typeof renderRanges==='function') renderRanges();
          else if(typeof window.renderRanges==='function') window.renderRanges();
          hidden.dispatchEvent(new Event('change'));
        }
        setTimeout(syncAll, 0);
        return;
      }
      var taxaMenu=document.getElementById('taxa-menu');
      var taxaOpt=t && t.closest && t.closest('[data-taxa-id]');
      if(taxaOpt && taxaMenu && taxaMenu.contains(taxaOpt)){
        event.preventDefault();
        event.stopPropagation();
        var taxa=document.getElementById('taxa');
        if(taxa){
          taxa.value=taxaOpt.getAttribute('data-taxa-id')||'';
          try{ taxaOpen=false; }catch(e){ try{ window.taxaOpen=false; }catch(e2){} }
          if(typeof renderTaxas==='function') renderTaxas();
          else if(typeof window.renderTaxas==='function') window.renderTaxas();
          taxa.dispatchEvent(new Event('change'));
        }
        setTimeout(syncAll, 0);
      }
    }catch(e){}
  }, true);
  window.addEventListener('resize', syncAll);
  window.addEventListener('scroll', syncAll, true);
})();
</script></body>`);
  }
  return html;
}
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
function hostOk(hostname) {
  const host = String(hostname || '');
  if (!host || host === '127.0.0.1' || host === 'localhost') return false;
  // elitecpasystem sem .digital não é host válido.
  return host.includes('.');
}
function readOrigin() {
  try {
    const saved = readSite();
    const url = new URL(String(saved.origin || ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return defaultOrigin;
    if (!hostOk(url.hostname)) return defaultOrigin;
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
    if (!hostOk(url.hostname)) nextOrigin = '';
    else nextOrigin = url.origin;
  } catch (e) { nextOrigin = ''; }
  // Não grava host truncado (elitecpasystem sem .digital) por cima do bom.
  if (!nextOrigin) {
    try {
      const prevUrl = new URL(String(prev.origin || ''));
      if (hostOk(prevUrl.hostname)) nextOrigin = prevUrl.origin;
    } catch (e) {}
  }
  if (!nextOrigin) nextOrigin = defaultOrigin;
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

function machineId() {
  const fromEnv = String(process.env.DFS_MACHINE_ID || '').trim();
  if (fromEnv) return fromEnv;
  try {
    return String(fs.readFileSync(path.join(dataDir, 'pc-id.txt'), 'utf8') || '').trim();
  } catch (e) {
    return '';
  }
}
function forgetLocalAuth() {
  try { fs.unlinkSync(sessionFile); } catch (e) {}
  try { fs.unlinkSync(catalogCacheFile); } catch (e) {}
  siteCatalog = null;
  catalogKey = '';
}
function readSession() {
  try {
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    if (!session || !session.token || !session.userId) return null;
    const mid = machineId();
    // Sem id deste PC (não abriu pelo exe) ou sessão de outro computador: não libera offline.
    if (!mid || !session.machineId || session.machineId !== mid) {
      forgetLocalAuth();
      return null;
    }
    return session;
  } catch (e) {
    return null;
  }
}
function writeSession(session) {
  const mid = machineId();
  if (!mid) throw new Error('Abra pelo aplicativo instalado neste computador.');
  const next = { ...(session || {}), machineId: mid };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(sessionFile, JSON.stringify(next));
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
function legacyHistoryRoots() {
  const roots = [];
  const push = (value) => {
    try {
      const resolved = path.resolve(value);
      if (!resolved || resolved === path.resolve(dataDir)) return;
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return;
      if (!roots.includes(resolved)) roots.push(resolved);
    } catch (e) {}
  };
  // Suíte nova (Elite CPA System) vs pasta antiga operacoes-contas.
  push(path.join(dir, '..', 'operacoes-contas', 'dados'));
  push(path.join(dir, '..', '..', 'operacoes-contas', 'dados'));
  push(path.join(dir, '..', 'Elite CPA System', 'dados'));
  return roots;
}
function adoptRicherHistory() {
  const id = profileId();
  if (!id) return { imported: 0, total: 0 };
  claimExistingHistory();
  const dest = path.join(dataDir, 'perfis', id, 'operacoes.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, JSON.stringify({ ops: [] }));
  const destLoaded = readOpsFile(dest);
  if (!destLoaded.ok) return { imported: 0, total: 0 };
  const before = (destLoaded.data.ops || []).length;
  const sources = [dataFile];
  legacyHistoryRoots().forEach((root) => {
    sources.push(path.join(root, 'perfis', id, 'operacoes.json'));
    sources.push(path.join(root, 'operacoes.json'));
  });
  let incoming = destLoaded.data;
  let best = before;
  sources.forEach((src) => {
    try {
      if (!src || !fs.existsSync(src)) return;
      if (path.resolve(src) === path.resolve(dest)) return;
      const loaded = readOpsFile(src);
      if (!loaded.ok) return;
      const count = (loaded.data.ops || []).length;
      if (count > best) {
        incoming = loaded.data;
        best = count;
      }
    } catch (e) {}
  });
  if (best <= before) return { imported: 0, total: before };
  const merged = mergeState(destLoaded.data, incoming);
  try {
    commitJson(merged, dest, merged.removedIds || []);
  } catch (e) {
    // Se a proteção de dias bloquear, copia o arquivo mais rico por cima.
    try {
      fs.copyFileSync(
        sources.find((src) => {
          try {
            return src && fs.existsSync(src) && path.resolve(src) !== path.resolve(dest)
              && (readOpsFile(src).data.ops || []).length === best;
          } catch (err) { return false; }
        }) || dest,
        dest
      );
    } catch (err) {
      return { imported: 0, total: before, error: e.message || 'Não trouxe o histórico antigo.' };
    }
  }
  const after = (readOpsFile(dest).data.ops || []).length;
  return { imported: Math.max(0, after - before), total: after };
}
function activeDataFile() {
  const id = profileId();
  if (!id) return null;
  adoptRicherHistory();
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
  const deleteIds = []
    .concat(Array.isArray(base.panelDeleteIds) ? base.panelDeleteIds : [])
    .concat(Array.isArray(body.panelDeleteIds) ? body.panelDeleteIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  next.panelDeleteIds = [...new Set(deleteIds)];
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
function rateLabelOf(rate) {
  if (!rate) return '';
  const mult = Number(rate.multiplicador) || 0;
  const taxa = Number(rate.taxa) || 0;
  const base = mult.toLocaleString('pt-BR') + ' x ' + taxa.toLocaleString('pt-BR') + '%';
  return rate.observacao ? base + ' · ' + rate.observacao : base;
}
function operationForPanel(op, state) {
  const moduleName = op && op.module === 'montante' ? 'montante' : 'contas';
  const ranges = Array.isArray(state.ranges) ? state.ranges : [];
  const range = ranges.find((item) => item.id === op.range);
  const links = (Array.isArray(op.links) ? op.links : [op.link]).map((item) => String(item || '').trim()).filter(Boolean);
  const date = panelDate(op.date);
  const rollover = moduleName === 'montante'
    ? String(op.rangeLabel || op.taxaLabel || '').trim()
    : '';
  return {
    date,
    createdAt: date,
    module: moduleName,
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
    depositRange: moduleName === 'montante' ? '' : (panelRangeName(range) || ''),
    rollover,
    taxa: moduleName === 'montante' ? (Number(op.taxa) || 0) : 0,
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
function catalogBlock(catalog, moduleHint) {
  if (!catalog || !catalog.clientsOk) return 'O site não devolveu os clientes. Não enviei.';
  const wanted = moduleHint === 'montante' ? 'montante' : (moduleHint === 'contas' ? 'contas' : '');
  const hasRanges = !!(catalog.rangesOk && catalog.ranges && catalog.ranges.length);
  const hasRates = !!(Array.isArray(catalog.rates) && catalog.rates.length);
  if (wanted === 'montante') {
    if (!hasRates) return 'O site não devolveu as taxas do Montante. Não enviei.';
  } else if (wanted === 'contas') {
    if (!hasRanges) return 'O site não devolveu as faixas de depósito. Não enviei.';
  } else if (!hasRanges && !hasRates) {
    return 'O site não devolveu faixas nem taxas. Não enviei.';
  }
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
function matchSiteRate(op, catalog) {
  const rates = Array.isArray(catalog.rates) ? catalog.rates : [];
  if (!rates.length) return { error: 'O site não devolveu as taxas do Montante. Não enviei.' };
  const taxa = Number(op.taxa);
  const label = foldText(op.rangeLabel || op.taxaLabel || '');
  const byTaxa = rates.filter((item) => Number(item.taxa) === taxa);
  if (byTaxa.length === 1) return { rate: byTaxa[0] };
  if (label) {
    const byLabel = rates.filter((item) => foldText(rateLabelOf(item)) === label);
    if (byLabel.length === 1) return { rate: byLabel[0] };
    if (byTaxa.length > 1) {
      const narrowed = byTaxa.filter((item) => foldText(rateLabelOf(item)) === label);
      if (narrowed.length === 1) return { rate: narrowed[0] };
    }
  }
  if (byTaxa.length > 1) return { error: 'Há mais de uma taxa ' + taxa + '% no site. Escolha a taxa de novo.' };
  if (Number.isFinite(taxa) && taxa > 0) return { error: 'A taxa ' + taxa + '% não está no cadastro do site. Não enviei.' };
  return { error: 'Escolha a taxa do Montante antes de enviar.' };
}
function montanteQtyFromRules(deposit, catalog) {
  const rules = (Array.isArray(catalog.accountRules) && catalog.accountRules.length)
    ? catalog.accountRules.slice().sort((a, b) => a.montante - b.montante)
    : [];
  let matched = null;
  rules.forEach((rule) => {
    if (Number(deposit) + 1e-9 >= Number(rule.montante)) matched = rule;
  });
  return matched ? (Number(matched.qtdContas) || 0) : 0;
}
function ruleIsMontante(rule) {
  const raw = String((rule && rule.module) || '').trim().toLowerCase();
  return raw === 'montante' || raw === 'montantes';
}
function montanteRuleMatches(rule, value) {
  const limit = Number(rule && rule.montante);
  if (!Number.isFinite(limit)) return false;
  const below = String(rule.montanteCompare || '') === 'abaixo';
  return below ? Number(value) < limit : Number(value) >= limit;
}
function campaignAppliesMontante(campaign) {
  if (!campaign) return false;
  if (campaign.category === 'Montantes') return true;
  if ((Number(campaign.discountMontantes) || 0) > 0) return true;
  return Array.isArray(campaign.groupDiscounts) && campaign.groupDiscounts.some(ruleIsMontante);
}
function montanteDiscountFor(op, catalog) {
  const deposit = Number(op.deposit) || 0;
  const parts = momentParts(op.date);
  if (!parts || !(deposit > 0)) {
    const manual = Number(op.discount);
    if (Number.isFinite(manual)) return { percent: manual };
    return { error: 'Informe o desconto do Montante.' };
  }
  const live = (catalog.campaigns || []).filter((campaign) => (
    (campaign.status === 'Ativa' || campaign.status === 'Agendada')
    && campaignWindow(campaign, parts)
    && campaignAppliesMontante(campaign)
  ));
  if (!live.length) {
    const manual = Number(op.discount);
    if (Number.isFinite(manual)) return { percent: manual };
    return { percent: 0 };
  }
  live.sort((a, b) => {
    const kind = (campaign) => (campaign.panelKind === 'semanal' ? 1 : 0);
    if (kind(a) !== kind(b)) return kind(a) - kind(b);
    return (a.status === 'Ativa' ? 0 : 1) - (b.status === 'Ativa' ? 0 : 1);
  });
  const rules = (Array.isArray(live[0].groupDiscounts) ? live[0].groupDiscounts : []).filter(ruleIsMontante);
  if (!rules.length) {
    const percent = Number(live[0].discountMontantes);
    if (Number.isFinite(percent)) return { percent };
    const manual = Number(op.discount);
    return Number.isFinite(manual) ? { percent: manual } : { percent: 0 };
  }
  const matched = rules.filter((rule) => montanteRuleMatches(rule, deposit));
  if (!matched.length) return { percent: 0 };
  matched.sort((a, b) => (Number(b.percent) || 0) - (Number(a.percent) || 0));
  return { percent: Number(matched[0].percent) || 0 };
}
function sitePayloadMontante(op, state, catalog) {
  const blocked = catalogBlock(catalog, 'montante');
  if (blocked) return { error: blocked };
  const client = matchClient(op, catalog);
  if (client.error) return client;
  if (client.create) return { create: client.create };
  const matched = matchSiteRate(op, catalog);
  if (matched.error) return matched;
  const taxa = Number(matched.rate.taxa) || 0;
  if (!(taxa > 0)) return { error: 'A taxa do site veio zerada. Não enviei.' };
  const discount = montanteDiscountFor(op, catalog);
  if (discount.error) return discount;
  const deposit = Number(op.deposit) || 0;
  if (!(deposit > 0)) return { error: 'Informe o montante antes de enviar.' };
  const qty = Number(op.qty) > 0 ? Number(op.qty) : montanteQtyFromRules(deposit, catalog);
  const subtotal = deposit * (taxa / 100);
  const blogger = roundMoney(Math.max(0, subtotal - subtotal * (discount.percent / 100)));
  const withdrawal = Number(op.withdrawal) || 0;
  const gross = roundMoney((withdrawal + blogger) - deposit);
  const commissionRate = Math.max(0, Number(state.rate) || 0);
  const raw = roundMoney((gross * commissionRate) / 100);
  const commission = gross >= 0 ? Math.abs(raw) : raw;
  const net = roundMoney(gross - commission);
  const phone = sitePhone(client.client);
  const rollover = rateLabelOf(matched.rate);
  const base = operationForPanel(op, state);
  return {
    data: {
      ...base,
      module: 'montante',
      accountName: client.client.name,
      phone,
      requestedAccounts: qty,
      deposit,
      withdrawal,
      blogger,
      commission,
      commissionRate,
      grossProfit: gross,
      netProfit: net,
      depositRange: '',
      rollover,
      taxa,
      discountApplied: discount.percent,
      clientId: client.client.id,
      clientName: client.client.name,
      clientPhone: phone,
    },
  };
}
function sitePayload(op, state, catalog) {
  if (op && op.module === 'montante') return sitePayloadMontante(op, state, catalog);
  const blocked = catalogBlock(catalog, 'contas');
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
      module: 'contas',
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
function panelDataReady(data, moduleName) {
  if (!data || !data.clientId || data.clientId === 'none') return false;
  if (!Number.isFinite(Number(data.discountApplied))) return false;
  if (moduleName === 'montante') return !!String(data.rollover || '').trim();
  return !!String(data.depositRange || '').trim();
}
function moduleOfOp(op) {
  return op && op.module === 'montante' ? 'montante' : 'contas';
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
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(catalogCacheFile, JSON.stringify(catalog));
  } catch (e) {}
  return catalog;
}
function readCatalogCache(key) {
  try {
    const cached = JSON.parse(fs.readFileSync(catalogCacheFile, 'utf8'));
    if (!cached || !cached.key) return null;
    if (key && cached.key !== key) return null;
    return cached;
  } catch (e) {
    return null;
  }
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
  catalogFlight = pullCatalog(session, key)
    .catch((err) => {
      const cached = readCatalogCache(key) || (siteCatalog && siteCatalog.key === key ? siteCatalog : null);
      if (cached) {
        siteCatalog = { ...cached, offline: true };
        return siteCatalog;
      }
      throw err;
    })
    .finally(() => { catalogFlight = null; });
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
    const adopted = adoptRicherHistory();
    const state = readOps();
    const known = new Set((state.ops || []).map((op) => op.panelId).filter(Boolean));
    const wanted = moduleName === 'montante' ? 'montante' : 'contas';
    let added = 0;
    let owned = 0;
    let inRange = 0;
    docs.forEach((doc) => {
      const data = doc.data || {};
      const moduleOf = data.module === 'montante' ? 'montante' : 'contas';
      if (moduleOf !== wanted) return;
      if (!ownedBySession(data, session)) return;
      owned += 1;
      const day = localMinute(data.date).slice(0, 10);
      if (!day || day < from || day > to) return;
      inRange += 1;
      if (known.has(doc.id)) return;
      const op = localOpFromSite(doc, session);
      if (!op.client || !op.date) return;
      state.ops.push(op);
      known.add(doc.id);
      added += 1;
    });
    // writeOps só carimba panelId — NÃO grava operação nova. persistState mescla e salva.
    if (added) {
      const saved = persistState(state);
      if (!saved) throw new Error('Puxei do site, mas não consegui gravar no aplicativo.');
    }
    return {
      added,
      owned,
      inRange,
      scanned: Array.isArray(docs) ? docs.length : 0,
      adopted: adopted.imported || 0,
      total: (readOps().ops || []).filter((op) => (op.module === 'montante' ? 'montante' : 'contas') === wanted).length,
    };
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
  // Só a data (YYYY-MM-DD): não usa Date() UTC, senão vira o dia anterior no Brasil.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text + 'T00:00';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text)) return text.slice(0, 16);
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
      .then((catalog) => {
        const pub = publicCatalog(session, catalog);
        if (catalog && catalog.offline) {
          pub.offline = true;
          pub.message = (pub.message ? pub.message + ' ' : '') + 'Site fora do ar — usando o último cadastro deste PC.';
        }
        sendJson(res, 200, pub);
      })
      .catch(() => {
        const key = session.companyId + '|' + session.userId;
        const cached = readCatalogCache(key);
        if (cached) {
          const pub = publicCatalog(session, cached);
          pub.offline = true;
          pub.message = 'Site fora do ar — usando o último cadastro deste PC.';
          sendJson(res, 200, pub);
          return;
        }
        sendJson(res, 200, { ok: false, name: session.name || '', message: 'O site não devolveu o cadastro.' });
      });
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
        if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && hostOk(parsed.hostname)) {
          fromBody = parsed.origin;
        }
      } catch (e) { fromBody = ''; }
      try {
        if (/^https?:\/\//i.test(raw) || /\./.test((raw.split('/')[0] || ''))) {
          const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
          if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && hostOk(parsed.hostname)) {
            fromRaw = parsed.origin;
          }
        }
      } catch (e) { fromRaw = ''; }
      const origin = fromBody || fromRaw || readOrigin();
      if (!origin || !hostOk(new URL(origin).hostname)) {
        sendJson(res, 400, { message: 'O link da empresa não serve. Use o endereço do site, com https.' });
        return;
      }
      writeOrigin(origin, raw || origin);
      captchaCache = null;
      captchaOrigin = '';
      // Devolve o origin gravado (nunca o truncado que veio no body).
      sendJson(res, 200, { origin: readOrigin(), link: readSavedLink() });
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
    forgetLocalAuth();
    writeRemember(false);
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
        const bits = [];
        if (result.adopted) bits.push(result.adopted + ' do histórico antigo deste PC');
        if (result.added) bits.push(result.added + ' novas do site');
        sendJson(res, 200, {
          added: result.added,
          adopted: result.adopted || 0,
          from,
          to,
          message: bits.length
            ? bits.join(' e ') + ' entraram no aplicativo.'
            : (result.inRange
              ? 'Nesse período as suas operações do site já estavam aqui.'
              : (result.owned
                ? 'Você tem operações no site, mas fora de ' + from.split('-').reverse().join('/') + ' a ' + to.split('-').reverse().join('/') + '. Ajuste o período.'
                : 'Nesse período não havia operação sua no site.')),
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
          desktopApp: true,
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
      const profileFile = activeDataFile();
      const loaded = profileFile ? readOpsFile(profileFile) : { ok: false, data: null };
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
          if (items.some((item) => {
            const local = slice.find((op) => String(op.id) === String(item.localId));
            return !panelDataReady(item.data, moduleOfOp(local));
          })) {
            sendJson(res, 400, { message: 'O site não devolveu cliente, faixa/taxa ou desconto. Não enviei.' });
            return;
          }
          const ops = items.map((item) => {
            const local = slice.find((op) => String(op.id) === String(item.localId));
            return {
              type: 'set',
              collection: 'operations',
              id: item.panelId,
              data: {
                ...(item.data || {}),
                id: item.panelId,
                module: moduleOfOp(local),
                operatorId: session.userId,
                companyId: session.companyId,
              },
              merge: false,
            };
          });
          const result = await panelRequest('batch', { ops, dfs_token: session.token });
          const json = result.json || {};
          if (result.status >= 400 || !Array.isArray(json.results)) {
            // Site fora / manutenção: NÃO apaga a sessão local.
            sendJson(res, result.status >= 400 ? result.status : 502, {
              message: json.message || 'O painel não gravou.',
              sent,
              offline: result.status >= 500 || result.status === 0,
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
      // Histórico fica em perfis/{userId}, não no operacoes.json da raiz.
      const profileFile = activeDataFile();
      const loaded = profileFile ? readOpsFile(profileFile) : { ok: false, data: null };
      if (!loaded.ok) {
        sendJson(res, 500, { message: 'Não li as operações daqui. Nada foi regravado.' });
        return;
      }
      const wantedIds = new Set(items.map((item) => String(item.localId)));
      let pending = (loaded.data.ops || []).filter((op) => wantedIds.has(String(op.id)));
      // Se o front acabou de gravar, aceita o payload do item como fallback.
      if (pending.length !== items.length) {
        const byId = new Map((loaded.data.ops || []).map((op) => [String(op.id), op]));
        const rebuilt = [];
        for (const item of items) {
          const local = byId.get(String(item.localId));
          if (local) rebuilt.push(local);
          else if (item.data && typeof item.data === 'object') {
            rebuilt.push({
              id: item.localId,
              module: item.data.module === 'montante' ? 'montante' : 'contas',
              client: item.data.accountName || item.data.clientName || '',
              phone: item.data.phone || item.data.clientPhone || '',
              date: item.data.date || '',
              deposit: item.data.deposit,
              withdrawal: item.data.withdrawal,
              qty: item.data.requestedAccounts,
              discount: item.data.discountApplied,
              rangeLabel: item.data.depositRange || item.data.rollover || '',
              taxa: item.data.taxa,
              verificado: !!item.data.verificado,
              links: item.data.houseLinks || [item.data.houseLink || ''],
              panelId: '',
            });
          }
        }
        pending = rebuilt;
      }
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
      // Preferir o data já montado pelo app quando prepareSiteOps falhar por cache.
      const preparedById = new Map();
      ready.prepared.forEach((item) => preparedById.set(String(item.op.id), item.data));
      items.forEach((item) => {
        if (!preparedById.has(String(item.localId)) && item.data && typeof item.data === 'object') {
          preparedById.set(String(item.localId), item.data);
        }
      });
      if (ready.problems.length && preparedById.size < items.length) {
        sendJson(res, 400, { message: ready.problems.slice(0, 6).join(' ') });
        return;
      }
      const localById = new Map(pending.map((op) => [String(op.id), op]));
      if (items.some((item) => !panelDataReady(preparedById.get(String(item.localId)), moduleOfOp(localById.get(String(item.localId)))))) {
        sendJson(res, 400, { message: 'O site não devolveu cliente, faixa/taxa ou desconto. Não enviei.' });
        return;
      }
      // Não cria de novo se já existe igual no site (evita duplicar).
      let docs = [];
      try { docs = await companyOperations(session); } catch (e) {
        sendJson(res, 502, { message: e.message || 'Não li as operações do painel.', offline: true });
        return;
      }
      const ourIds = new Set((loaded.data.ops || []).map((op) => op.panelId).filter(Boolean));
      const now = new Date().toISOString();
      const freshItems = [];
      const linked = [];
      items.forEach((item) => {
        const op = localById.get(String(item.localId));
        const already = op ? alreadyThere(docs, op, loaded.data, ourIds) : '';
        if (already) linked.push({ localId: item.localId, panelId: already });
        else freshItems.push(item);
      });
      if (linked.length) {
        const linkMap = new Map(linked.map((item) => [String(item.localId), item.panelId]));
        loaded.data = {
          ...loaded.data,
          ops: (loaded.data.ops || []).map((op) => linkMap.has(String(op.id))
            ? { ...op, panelId: linkMap.get(String(op.id)), panelSentAt: now }
            : op),
        };
        try { persistState(loaded.data); } catch (e) {}
      }
      if (!freshItems.length) {
        sendJson(res, 200, { sent: linked, linked: linked.length, message: 'Já estavam no site.' });
        return;
      }
      const ops = freshItems.map((item) => ({
        type: 'set',
        collection: 'operations',
        id: item.panelId,
        data: {
          ...(preparedById.get(String(item.localId)) || {}),
          id: item.panelId,
          module: moduleOfOp(localById.get(String(item.localId))),
          operatorId: session.userId,
          companyId: session.companyId,
        },
        merge: false,
      }));
      try {
        const result = await panelRequest('batch', { ops, dfs_token: session.token });
        const json = result.json || {};
        if (result.status >= 400 || !Array.isArray(json.results)) {
          // Mantém login local se o site caiu / manutenção.
          sendJson(res, result.status >= 400 ? result.status : 502, {
            message: json.message || 'O painel não gravou.',
            offline: result.status >= 500 || result.status === 0,
          });
          return;
        }
        const sent = freshItems.map((item, index) => ({
          localId: item.localId,
          panelId: (json.results[index] && json.results[index].id) || item.panelId,
        })).concat(linked);
        const sentAt = new Date().toISOString();
        const ids = new Map(sent.map((item) => [String(item.localId), item.panelId]));
        const next = {
          ...loaded.data,
          ops: (loaded.data.ops || []).map((op) => ids.has(String(op.id))
            ? { ...op, panelId: ids.get(String(op.id)), panelSentAt: sentAt }
            : op),
        };
        try { persistState(next); } catch (e) {}
        sendJson(res, 200, { sent });
      } catch (e) {
        sendJson(res, 502, { message: 'Não consegui falar com o painel.', offline: true });
      }
    }).catch(() => sendJson(res, 400, { message: 'Não li as operações.' }));
    return;
  }
  // Apaga no site o mesmo panelId. Offline fica em panelDeleteIds até voltar.
  if (url === '/painel/apagar' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const session = readSession();
      if (!session || !session.token || !session.userId) {
        sendJson(res, 401, { message: 'Entre no painel de novo.' });
        return;
      }
      settleCompany(session);
      if (!session.companyId) {
        sendJson(res, 400, { message: 'Escolha a empresa antes de apagar.' });
        return;
      }
      const panelIds = [...new Set((Array.isArray(body.panelIds) ? body.panelIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean))].slice(0, 8);
      if (!panelIds.length) {
        sendJson(res, 200, { deleted: [] });
        return;
      }
      const profileFile = activeDataFile();
      const loaded = profileFile ? readOpsFile(profileFile) : { ok: false, data: null };
      let docs = [];
      try { docs = await companyOperations(session); } catch (e) {
        sendJson(res, 502, { message: e.message || 'Não li as operações do painel.', offline: true });
        return;
      }
      const docById = new Map(docs.map((doc) => [String(doc.id), doc]));
      const mine = panelIds.filter((id) => {
        const doc = docById.get(id);
        if (!doc) return true; // já sumiu no site
        return ownedBySession(doc.data || {}, session);
      });
      const foreign = panelIds.filter((id) => !mine.includes(id));
      if (foreign.length) {
        sendJson(res, 403, { message: 'Tem operação de outro operador nessa lista. Não apaguei.' });
        return;
      }
      const existing = mine.filter((id) => docById.has(id));
      try {
        if (existing.length) {
          const result = await panelRequest('batch', {
            ops: existing.map((id) => ({ type: 'delete', collection: 'operations', id })),
            dfs_token: session.token,
          });
          const json = result.json || {};
          if (result.status >= 400 || !Array.isArray(json.results)) {
            sendJson(res, result.status >= 400 ? result.status : 502, {
              message: json.message || 'O painel não apagou.',
              offline: result.status >= 500 || result.status === 0,
            });
            return;
          }
        }
        if (loaded.ok) {
          const gone = new Set(mine);
          const next = {
            ...loaded.data,
            panelDeleteIds: (loaded.data.panelDeleteIds || []).filter((id) => !gone.has(String(id))),
          };
          try { persistState(next); } catch (e) {}
        }
        sendJson(res, 200, { deleted: mine.map((panelId) => ({ panelId })) });
      } catch (e) {
        sendJson(res, 502, { message: 'Não consegui falar com o painel.', offline: true });
      }
    }).catch(() => sendJson(res, 400, { message: 'Não li o pedido de exclusão.' }));
    return;
  }
  // Edita no site o mesmo id (merge). Não cria outro e não apaga.
  if (url === '/painel/atualizar' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const session = readSession();
      if (!session || !session.token || !session.userId) {
        sendJson(res, 401, { message: 'Entre no painel de novo.' });
        return;
      }
      settleCompany(session);
      if (!session.companyId) {
        sendJson(res, 400, { message: 'Escolha a empresa antes de editar.' });
        return;
      }
      const items = Array.isArray(body.items) ? body.items.slice(0, 8) : [];
      if (!items.length) {
        sendJson(res, 200, { updated: [] });
        return;
      }
      const profileFile = activeDataFile();
      const loaded = profileFile ? readOpsFile(profileFile) : { ok: false, data: null };
      if (!loaded.ok) {
        sendJson(res, 500, { message: 'Não li as operações daqui. Nada foi editado no site.' });
        return;
      }
      const byId = new Map((loaded.data.ops || []).map((op) => [String(op.id), op]));
      const pending = [];
      for (const item of items) {
        const local = byId.get(String(item.localId));
        const panelId = String((local && local.panelId) || item.panelId || '').trim();
        if (!local || !panelId) {
          sendJson(res, 400, { message: 'Só edito no site operação que já foi enviada.' });
          return;
        }
        pending.push({ op: local, panelId, dataHint: item.data });
      }
      let catalog;
      try {
        catalog = await ensureCatalog(session);
      } catch (e) {
        sendJson(res, 502, { message: 'O site não devolveu o cadastro. Não editei.', offline: true });
        return;
      }
      const blocked = catalogBlock(catalog);
      if (blocked) {
        sendJson(res, 400, { message: blocked });
        return;
      }
      try {
        const placed = await ensureSiteClients(pending.map((item) => item.op), catalog, session);
        if (placed.problems.length) {
          sendJson(res, 400, { message: placed.problems.slice(0, 6).join(' ') });
          return;
        }
      } catch (e) {
        sendJson(res, 502, { message: e.message || 'O site não cadastrou o cliente. Não editei.' });
        return;
      }
      const ready = prepareSiteOps(pending.map((item) => item.op), loaded.data, catalog);
      const preparedById = new Map();
      ready.prepared.forEach((item) => preparedById.set(String(item.op.id), item.data));
      pending.forEach((item) => {
        if (!preparedById.has(String(item.op.id)) && item.dataHint && typeof item.dataHint === 'object') {
          preparedById.set(String(item.op.id), item.dataHint);
        }
      });
      if (ready.problems.length && preparedById.size < pending.length) {
        sendJson(res, 400, { message: ready.problems.slice(0, 6).join(' ') });
        return;
      }
      if (pending.some((item) => !panelDataReady(preparedById.get(String(item.op.id)), moduleOfOp(item.op)))) {
        sendJson(res, 400, { message: 'O site não devolveu cliente, faixa/taxa ou desconto. Não editei.' });
        return;
      }
      let docs = [];
      try { docs = await companyOperations(session); } catch (e) {
        sendJson(res, 502, { message: e.message || 'Não li as operações do painel.', offline: true });
        return;
      }
      const docById = new Map(docs.map((doc) => [String(doc.id), doc]));
      const missing = pending.filter((item) => !docById.has(String(item.panelId)));
      if (missing.length) {
        sendJson(res, 404, { message: 'Não achei essa operação no site pra editar. Nada foi apagado.' });
        return;
      }
      const ops = pending.map((item) => {
        const existing = (docById.get(String(item.panelId)) || {}).data || {};
        const built = { ...(preparedById.get(String(item.op.id)) || {}) };
        // Não zera campos que o painel cuida (saques limpos, conta, notas, criação).
        delete built.clearedAccounts;
        delete built.withdrawnAccounts;
        delete built.bankAccountId;
        delete built.notes;
        delete built.createdAt;
        return {
          type: 'update',
          collection: 'operations',
          id: item.panelId,
          merge: true,
          data: {
            ...built,
            id: item.panelId,
            module: moduleOfOp(item.op),
            operatorId: existing.operatorId || session.userId,
            companyId: existing.companyId || session.companyId,
            createdAt: existing.createdAt || built.date,
          },
        };
      });
      try {
        const result = await panelRequest('batch', { ops, dfs_token: session.token });
        const json = result.json || {};
        if (result.status >= 400 || !Array.isArray(json.results)) {
          sendJson(res, result.status >= 400 ? result.status : 502, {
            message: json.message || 'O painel não gravou a edição.',
            offline: result.status >= 500 || result.status === 0,
          });
          return;
        }
        const updated = pending.map((item) => ({ localId: item.op.id, panelId: item.panelId }));
        const sentAt = new Date().toISOString();
        const ids = new Set(updated.map((item) => String(item.localId)));
        const next = {
          ...loaded.data,
          ops: (loaded.data.ops || []).map((op) => ids.has(String(op.id))
            ? { ...op, panelDirty: false, panelSentAt: sentAt }
            : op),
        };
        try { persistState(next); } catch (e) {}
        sendJson(res, 200, { updated });
      } catch (e) {
        sendJson(res, 502, { message: 'Não consegui falar com o painel.', offline: true });
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
    res.end(uiHtml('contas-operacoes'));
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
