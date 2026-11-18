'use strict';
(function () {
  var csrf = document.querySelector('meta[name="neo-csrf"]').content;
  var $ = function (id) { return document.getElementById(id); };
  var state = null;
  var pinShown = false;
  var dirty = { tunnel: false };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.hidden = true; }, 2600);
  }
  function api(method, path, body) {
    var opts = { method: method, headers: {} };
    if (method === 'POST') { opts.headers['x-neo-csrf'] = csrf; opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body || {}); }
    return fetch('api' + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }
  function copy(text, what) {
    function done() { toast((what || 'Metin') + ' kopyalandı'); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
    function fallback() {
      var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('Kopyalanamadı'); }
      document.body.removeChild(ta);
    }
  }
  function fail(e) { toast('Hata: ' + (e && e.message ? e.message : e)); }

  function fmtTime(ts) {
    var d = new Date(typeof ts === 'number' ? ts : Date.parse(ts));
    return isNaN(d) ? '' : d.toLocaleTimeString('tr-TR');
  }
  function fmtDate(ts) {
    var d = new Date(ts);
    return isNaN(d) ? '' : d.toLocaleString('tr-TR');
  }

  function render() {
    if (!state) return;
    var s = state, t = s.tunnel || {}, e = s.engine || {};
    // status card
    var card = $('status');
    var ready = e.state === 'ready' && (t.state === 'online' || t.kind === 'none');
    var bad = e.state === 'error' || t.state === 'error';
    card.className = 'card status ' + (s.paused ? 'paused' : bad ? 'error' : ready ? 'ready' : 'starting');
    var title, sub = '';
    if (s.paused) { title = 'Durduruldu ⛔'; sub = 'Acil durdur açık: hiçbir araç çalışmıyor.'; }
    else if (bad) { title = 'Sorun var'; sub = (e.state === 'error' ? (e.message || 'Motor başlatılamadı.') : (t.message || 'Tünel hatası.')); }
    else if (ready) { title = 'Hazır ✅'; sub = e.toolCount + ' araç hazır' + (t.kind === 'none' ? ' (yalnızca bu bilgisayarda)' : ''); }
    else { title = 'Hazırlanıyor…'; sub = t.message || (e.state === 'starting' ? 'Motor başlıyor…' : ''); }
    $('status-title').textContent = title; $('status-sub').textContent = sub;

    // connect card
    $('url-box').textContent = s.connectorUrl || (t.state === 'error' ? 'Bağlantı kurulamadı' : t.kind === 'none' ? 'Tünel kapalı' : 'Bağlantı hazırlanıyor…');
    $('copy-url').disabled = !s.connectorUrl;
    $('quick-warning').hidden = !(t.kind === 'cloudflare-quick' && t.state === 'online');
    $('pin-box').textContent = pinShown ? s.pin : '••••-••••-••••-••••';
    $('toggle-pin').textContent = pinShown ? 'Gizle' : 'Göster';
    $('unlock-pin').hidden = !s.pinLocked;

    // kill
    var k = $('kill');
    k.textContent = s.paused ? 'DEVAM ET' : 'ACİL DURDUR';
    k.classList.toggle('on', !!s.paused);
    $('kill-hint').textContent = s.paused ? 'Şu an her şey durdurulmuş. Devam etmek için tıklayın.' : 'Tüm araç çağrılarını anında engeller.';

    // mode
    document.querySelectorAll('input[name=mode]').forEach(function (r) { r.checked = r.value === s.mode; });

    // dirs
    var ul = $('dirs'); ul.replaceChildren();
    if (!s.allowedDirectories.length) ul.appendChild(el('li', 'empty', 'Kısıt yok — tüm disk erişilebilir.'));
    s.allowedDirectories.forEach(function (d) {
      var li = el('li'); li.appendChild(el('span', 't mono', d));
      var b = el('button', 'btn subtle', 'Kaldır');
      b.onclick = function () { post('/settings', { removeDirectory: d }); };
      li.appendChild(b); ul.appendChild(li);
    });

    // clients
    var cl = $('clients'); cl.replaceChildren();
    if (!s.clients.length) cl.appendChild(el('li', 'empty', 'Henüz bağlı istemci yok.'));
    s.clients.forEach(function (c) {
      var li = el('li'); var info = el('span', 't');
      info.appendChild(el('b', null, c.clientName || c.clientId));
      info.appendChild(el('div', 'muted', 'Eklendi: ' + fmtDate(c.createdAt) + (c.lastUsedAt ? ' · Son kullanım: ' + fmtDate(c.lastUsedAt) : '')));
      li.appendChild(info);
      var b = el('button', 'btn subtle', 'Erişimi kaldır');
      b.onclick = function () { if (confirm('Bu istemcinin erişimi kaldırılsın mı?')) post('/clients/' + encodeURIComponent(c.clientId) + '/revoke'); };
      li.appendChild(b); cl.appendChild(li);
    });
    $('revoke-all').hidden = !s.clients.length;

    // tunnel
    if (!dirty.tunnel) {
      var ts = s.tunnelSettings;
      document.querySelectorAll('input[name=tkind]').forEach(function (r) { r.checked = r.value === ts.kind; });
      $('t-url').value = ts.publicUrl || '';
      $('t-token').value = '';
      $('t-token').placeholder = ts.hasToken ? 'Kayıtlı (değiştirmek için yenisini yapıştırın)' : 'Token yapıştırın';
      tunnelExtra();
    }
    $('tunnel-msg').textContent = t.message || (t.state === 'online' ? 'Tünel çevrimiçi.' : '');
    $('autostart').checked = !!s.autostart;
  }

  function selectedKind() { var r = document.querySelector('input[name=tkind]:checked'); return r ? r.value : 'cloudflare-quick'; }
  function tunnelExtra() {
    var k = selectedKind();
    $('tunnel-extra').hidden = !(k === 'manual' || k === 'cloudflare-named');
    $('t-token-wrap').hidden = k !== 'cloudflare-named';
  }

  function post(path, body) {
    return api('POST', path, body).then(function (j) {
      if (j.version !== undefined) state = Object.assign({}, state, j);
      else if (j.clients) state.clients = j.clients;
      if (j.note) toast(j.note);
      render(); return j;
    }).catch(fail);
  }

  function addRow(e) {
    var tb = $('feed');
    var tr = el('tr');
    var allowed = e.allowed !== undefined ? e.allowed : (e.decision ? e.decision === 'allow' || e.decision === 'allowed' : e.ok);
    tr.appendChild(el('td', null, fmtTime(e.ts || e.time || e.at || Date.now())));
    tr.appendChild(el('td', 'mono', String(e.tool || e.toolName || e.name || '?')));
    tr.appendChild(el('td', null, String(e.clientName || e.client || e.clientId || '')));
    var r = el('td', allowed === false ? 'no' : 'ok', allowed === false ? 'Reddedildi' : 'İzin verildi');
    if (allowed === false && e.reason) r.title = String(e.reason);
    tr.appendChild(r);
    tr.appendChild(el('td', null, e.durationMs !== undefined ? e.durationMs + ' ms' : (e.duration !== undefined ? e.duration + ' ms' : '')));
    tb.insertBefore(tr, tb.firstChild);
    while (tb.children.length > 100) tb.removeChild(tb.lastChild);
    $('feed-empty').hidden = true;
  }

  function connectEvents() {
    var es = new EventSource('api/events');
    es.addEventListener('audit', function (m) { try { addRow(JSON.parse(m.data)); } catch (x) { /* ignore */ } });
    es.addEventListener('status', function (m) {
      try { var j = JSON.parse(m.data); if (state) { state.tunnel = j.tunnel; state.engine = j.engine; state.connectorUrl = j.connectorUrl; render(); } } catch (x) { /* ignore */ }
    });
    es.onerror = function () { /* browser auto-reconnects */ };
  }

  function load() {
    return api('GET', '/state').then(function (j) {
      var firstLoad = !state;
      state = j; render();
      if (firstLoad && j.recent) { $('feed').replaceChildren(); j.recent.slice().sort(function (a, b) { return (Date.parse(a.ts || a.time) || a.ts || 0) - (Date.parse(b.ts || b.time) || b.ts || 0); }).forEach(addRow); if (!j.recent.length) $('feed-empty').hidden = false; }
    }).catch(function () { /* server restarting */ });
  }

  $('copy-url').onclick = function () { if (state && state.connectorUrl) copy(state.connectorUrl, 'Adres'); };
  $('copy-pin').onclick = function () { if (state) copy(state.pin, 'PIN'); };
  $('toggle-pin').onclick = function () { pinShown = !pinShown; render(); };
  $('regen-pin').onclick = function () {
    if (!confirm('PIN yenilensin mi? Yeni bağlantılar yeni PIN\'i girmek zorunda kalır.')) return;
    api('POST', '/pin/regenerate').then(function (j) { state.pin = j.pin; render(); toast('PIN yenilendi'); }).catch(fail);
  };
  $('unlock-pin').onclick = function () {
    api('POST', '/pin/unlock').then(function () { state.pinLocked = false; render(); toast('PIN kilidi açıldı'); }).catch(fail);
  };
  $('kill').onclick = function () { post('/settings', { paused: !state.paused }); };
  document.querySelectorAll('input[name=mode]').forEach(function (r) { r.onchange = function () { post('/settings', { mode: r.value }); }; });
  $('dir-form').onsubmit = function (ev) {
    ev.preventDefault();
    var v = $('dir-input').value.trim(); if (!v) return;
    post('/settings', { addDirectory: v }).then(function () { $('dir-input').value = ''; });
  };
  $('revoke-all').onclick = function () { if (confirm('Tüm istemcilerin erişimi kaldırılsın mı?')) post('/clients/revoke-all'); };
  document.querySelectorAll('input[name=tkind]').forEach(function (r) { r.onchange = function () { dirty.tunnel = true; tunnelExtra(); }; });
  ['t-url', 't-token'].forEach(function (id) { $(id).oninput = function () { dirty.tunnel = true; }; });
  $('tunnel-save').onclick = function () {
    var k = selectedKind(); var t = { kind: k };
    if (k === 'manual' || k === 'cloudflare-named') t.publicUrl = $('t-url').value.trim();
    if (k === 'cloudflare-named' && $('t-token').value.trim()) t.cloudflareToken = $('t-token').value.trim();
    post('/settings', { tunnel: t }).then(function () { dirty.tunnel = false; render(); });
  };
  $('tunnel-restart').onclick = function () { api('POST', '/tunnel/restart').then(function () { toast('Tünel yeniden başlatılıyor'); }).catch(fail); };
  $('autostart').onchange = function (ev) {
    var box = ev.target;
    post('/settings', { autostart: box.checked }).then(function (j) { if (!j) { box.checked = !box.checked; } });
  };

  load().then(connectEvents);
  setInterval(load, 10000);
})();
