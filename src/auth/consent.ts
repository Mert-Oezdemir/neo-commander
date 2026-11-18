const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ESC[c]!);
}

export interface ConsentView {
  clientName: string;
  redirectHost: string;
  pending: string;
  nonce: string;
  error?: string;
  /** When true, no form is shown. */
  locked?: boolean;
  scope: string;
}

export function renderConsent(v: ConsentView): string {
  const form = v.locked
    ? ''
    : `<form method="post" action="/authorize/decision" autocomplete="off">
  <input type="hidden" name="pending" value="${esc(v.pending)}">
  <label for="pin">Sahip PIN'i</label>
  <input id="pin" name="pin" type="password" inputmode="text" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="40" placeholder="XXXX-XXXX-XXXX-XXXX" required autofocus>
  <div class="row">
    <button type="submit" name="decision" value="deny" class="deny" formnovalidate>Reddet</button>
    <button type="submit" name="decision" value="allow" class="allow">İzin ver</button>
  </div>
</form>`;
  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Neo Commander — Bağlantı isteği</title>
<style nonce="${esc(v.nonce)}">
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1218;color:#e7eaf0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px}
.card{width:100%;max-width:440px;background:#181d27;border:1px solid #2a3142;border-radius:14px;padding:24px}
h1{font-size:20px;margin:0 0 4px}p{margin:8px 0;color:#aab2c5}.k{color:#e7eaf0;font-weight:600;word-break:break-all}
dl{margin:16px 0;padding:12px;background:#10141c;border-radius:10px}dt{font-size:12px;color:#7d879c;text-transform:uppercase;letter-spacing:.04em}dd{margin:2px 0 10px;font-weight:600;word-break:break-all}dd:last-child{margin-bottom:0}
label{display:block;margin:16px 0 6px;font-size:14px;color:#aab2c5}
input[type=password]{width:100%;padding:12px;font-size:18px;letter-spacing:.08em;border-radius:10px;border:1px solid #3a4258;background:#10141c;color:#fff}
.row{display:flex;gap:12px;margin-top:18px}button{flex:1;padding:13px;font-size:16px;font-weight:600;border-radius:10px;border:0;cursor:pointer}
.allow{background:#3b82f6;color:#fff}.deny{background:#2a3142;color:#e7eaf0}
.err{margin:12px 0;padding:10px 12px;border-radius:10px;background:#3a1c20;color:#ffb4b4;border:1px solid #6b2a31}
.warn{font-size:13px;color:#d9a441}
</style></head><body><main class="card">
<h1>Neo Commander — Bağlantı isteği</h1>
<p>Bir uygulama bu bilgisayara uzaktan erişmek istiyor.</p>
<dl><dt>İstemci</dt><dd>${esc(v.clientName)}</dd><dt>Yönlendirme adresi</dt><dd>${esc(v.redirectHost)}</dd><dt>Yetki</dt><dd>${esc(v.scope)}</dd></dl>
${v.error ? `<div class="err" role="alert">${esc(v.error)}</div>` : ''}
${form}
<p class="warn">Yalnızca kendi başlattığınız bir bağlantıysa izin verin. PIN, Neo Commander panelinde görünür.</p>
</main></body></html>`;
}
