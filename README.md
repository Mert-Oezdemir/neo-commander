# Neo Commander

**Claude.ai'nin kendi bilgisayarınızı kullanmasını sağlayan, tamamen sizin kontrolünüzdeki bir köprü.**
Ücretli aracı servis yok. Her şey sizin bilgisayarınızda çalışır; Claude'a yalnızca sizin verdiğiniz link ve PIN ile erişim açılır.

## Hızlı başlangıç (Windows)

1. Bu sayfadan **Code → Download ZIP** ile indirip bir klasöre çıkarın (veya `git clone` kullanın).
2. **`Neo-Commander.cmd`** dosyasına çift tıklayın. İlk seferde gerekli dosyalar kurulur (birkaç dakika sürebilir). Node.js yoksa otomatik kurulmaya çalışılır; kurulursa pencereyi kapatıp dosyaya tekrar çift tıklayın.
3. Tarayıcıda **kontrol paneli** açılır. "Hazır ✅" yazısını bekleyin.
4. Panelde **Kopyala** düğmesiyle bağlayıcı adresini kopyalayın.
5. Claude.ai → **Ayarlar → Bağlayıcılar → Özel bağlayıcı ekle** → adresi yapıştırın.
6. Açılan sayfada panelde gördüğünüz **PIN**'i girip izin verin. Bitti.

macOS / Linux: `./neo-commander.sh` (macOS'ta `Neo-Commander.command` dosyasına çift tıklanabilir).

## Güvenlik modeli (özet)

- Sunucu yalnızca `127.0.0.1`'de dinler; internete açılan tek şey tünel üzerinden gelen `/mcp` yoludur.
- `/mcp` geçerli bir OAuth 2.1 erişim anahtarı olmadan çalışmaz. Yeni bir istemci bağlamak için **sahip PIN'i** gerekir.
- **Kontrol paneli** yalnızca bu bilgisayardan, doğrudan bağlantıyla açılır; tünel üzerinden görünmez (404). CSRF ve Host denetimi vardır.
- Her araç çağrısı tek bir politika katmanından geçer ve kayda alınır (panelde canlı görünür).
- Tüm kayıtlı veriler (PIN, anahtarlar, ayarlar) yalnızca sizin kullanıcı klasörünüzdedir (`%LOCALAPPDATA%\NeoCommander`).

## Yetki seviyeleri

| Mod | Ne yapabilir |
|---|---|
| **Tam yetki** | Dosya, komut, ekran, fare ve klavye dahil her şey |
| **Standart** | Dosya ve komutlar; fare/klavye kontrolü ve ayar araçları yok |
| **Salt okunur** | Yalnızca okuma, listeleme, arama, ekran görüntüsü |

Panelden **İzinli klasörler** ekleyerek dosya erişimini sınırlayabilirsiniz (boşsa tüm disk).

## Acil Durdur

Panelde büyük kırmızı **ACİL DURDUR** düğmesi tüm araç çağrılarını anında reddeder. Tekrar basınca devam eder. Ayrıca **Bağlı istemciler** bölümünden herhangi bir istemcinin erişimini kaldırabilir, PIN'i yenileyebilirsiniz.

## Sabit link seçenekleri

Varsayılan **hızlı tünel** (Cloudflare, hesap gerekmez) her açılışta farklı bir adres üretir; adres değişince Claude'da bağlayıcıyı yeniden eklemeniz gerekir. Sabit adres için panelde **Bağlantı türü**:

- **Tailscale Funnel** (önerilen): ücretsiz Tailscale hesabı açın, uygulamayı kurup giriş yapın, yönetim panelinde HTTPS ve Funnel'ı etkinleştirin. Panelde "Tailscale Funnel"i seçin.
- **Cloudflare (token)**: kendi alan adınız varsa Cloudflare Zero Trust'ta bir tünel oluşturup token ve adresi panele girin.
- **Elle adres**: kendi kurduğunuz bir tünelin `https://` adresi.

Bilgisayar açılınca otomatik başlaması için panelde **Otomatik başlat** kutusunu işaretleyin (Windows).

## Sorun giderme

- **Pencere hemen kapanıyor / hata var:** hata mesajını okumak için pencere açık kalır; mesajı kopyalayıp yardım isteyin.
- **"Node.js bulunamadı":** https://nodejs.org adresinden LTS sürümünü (22.12+) kurun.
- **Tünel "Hazırlanıyor"da kalıyor:** İnternet/güvenlik duvarını kontrol edin; panelde **Tüneli yeniden başlat**'a basın. Kurumsal ağlarda Tailscale veya Cloudflare token seçeneğini deneyin.
- **Tailscale "Funnel açık değil":** hata mesajındaki bağlantıdan Funnel'ı etkinleştirin.
- **Claude bağlanamıyor:** adres değişmiş olabilir (hızlı tünel); panelden yeni adresi kopyalayıp bağlayıcıyı yeniden ekleyin.
- Windows SmartScreen uyarısı çıkarsa "Ek bilgi → Yine de çalıştır".

## Geliştirici notları

`npm ci --ignore-scripts && npm rebuild @vscode/ripgrep && npm run build && npm start`. Testler: `npm test`.
cloudflared sürümü `src/tunnel/cloudflared.ts` içinde sabitlenmiştir; indirilen dosyanın SHA-256 değeri doğrulanmadan çalıştırılmaz (`scripts/pin-cloudflared.mjs` ile hash tablosu doldurulur).

## English summary

Neo Commander is a self-hosted remote MCP server that lets Claude.ai operate your own computer without a paid relay. Double-click `Neo-Commander.cmd` (Windows) or run `./neo-commander.sh` (macOS/Linux); wait for the local control panel to show "Ready", copy the connector URL, add it in Claude.ai under Settings → Connectors → Add custom connector, and enter the owner PIN on the consent page. Security: loopback-only server, OAuth 2.1 with owner PIN, a control panel reachable only by direct loopback (CSRF + Host checks), one policy and audit layer for all tools, three permission modes (full / standard / read-only), allowed-folder restriction and a kill switch. Quick Cloudflare tunnels change URL on restart; use Tailscale Funnel or a named Cloudflare tunnel for a stable link.

## Credits & license

Neo Commander is MIT licensed. File, search, edit and process tools come from [Desktop Commander](https://github.com/wonderwhy-er/DesktopCommanderMCP) by Eduard Ruzga (MIT License), used as a pinned upstream dependency with telemetry disabled. Tunnels use Cloudflare's `cloudflared` (Apache-2.0) or Tailscale.
