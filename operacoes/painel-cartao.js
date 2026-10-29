(function () {
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', function () {
      if (window.dfsMontarCartao) window.dfsMontarCartao();
    });
  }
  window.dfsMontarCartao = function () {
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;
  if (!document.body) return;
  if (document.getElementById('dfs-enviar-programa')) return;
  var box = document.createElement('div');
  box.id = 'dfs-enviar-programa';
  box.innerHTML = ''
    + '<strong style="display:block;font-size:16px;margin:0 0 6px">Operações</strong>'
    + '<p id="dfs-enviar-hint" style="margin:0 0 10px;color:#a1a1aa;font-size:13px;line-height:1.4">Escolha o dia. Cada operação entra com a data e o horário do programa.</p>'
    + '<select id="dfs-enviar-dia" style="width:100%;margin:0 0 10px;padding:8px 10px;border-radius:8px;border:1px solid #3f3f46;background:#09090b;color:#fafafa;font:14px Segoe UI,sans-serif"></select>'
    + '<button id="dfs-enviar-go" type="button" style="width:100%;padding:10px 12px;border:0;border-radius:10px;background:#34d399;color:#052e16;font:700 14px Segoe UI,sans-serif;cursor:pointer">Enviar</button>'
    + '<p id="dfs-enviar-status" style="margin:10px 0 0;min-height:18px;color:#a1a1aa;font-size:13px"></p>';
  box.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;width:360px;padding:16px;border:1px solid #34d399;border-radius:16px;background:#18181b;color:#fafafa;font:14px Segoe UI,sans-serif;box-shadow:0 16px 40px rgba(0,0,0,.45)';
  (document.body || document.documentElement).appendChild(box);
  window.dfsSetDias = function (days) {
    var select = document.getElementById('dfs-enviar-dia');
    if (!select) return;
    var current = select.value;
    var list = Array.isArray(days) ? days : [];
    var html = '';
    if (list.length > 1) html += '<option value="tudo">Tudo que ainda não foi</option>';
    list.forEach(function (day) {
      html += '<option value="' + String(day.id).replace(/"/g, '') + '">' + String(day.label || day.id) + '</option>';
    });
    if (!list.length) html = '<option value="">Nada novo para enviar</option>';
    if (select.innerHTML !== html) select.innerHTML = html;
    if (current && select.querySelector('option[value="' + current.replace(/"/g, '') + '"]')) select.value = current;
  };
  window.dfsSetStatus = function (text) {
    var status = document.getElementById('dfs-enviar-status');
    var button = document.getElementById('dfs-enviar-go');
    if (status) status.textContent = text || '';
    if (button) button.disabled = false;
  };
  document.getElementById('dfs-enviar-go').onclick = function () {
    var select = document.getElementById('dfs-enviar-dia');
    var day = select ? select.value : '';
    if (!day) {
      window.dfsSetStatus('Não há operação nova para enviar.');
      return;
    }
    this.disabled = true;
    window.dfsSetStatus('Enviando...');
    if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage(JSON.stringify({ kind: 'enviar', day: day }));
  };
  };
  window.dfsMontarCartao();
})();
