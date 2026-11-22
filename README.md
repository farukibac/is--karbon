# İSÜ Karbon ve İSÜ Lojistik

Uygulama Node.js 24 LTS ile çalışır. Sunucu harici npm paketi kullanmaz. Haritalar Leaflet 1.9.4'ü CDN üzerinden, harita karolarını OpenStreetMap üzerinden yükler. Canlı güzergâhlar için sunucu OpenRouteService'e bağlanır.

## Yerelde çalıştırma

1. `npm ci` çalıştır.
2. `.env.example` dosyasını `.env` adıyla kopyala ve kendi anahtarını `ORS_API_KEY` değişkenine yerel olarak gir.
3. `npm run dev` çalıştır ve [yerel uygulamayı](http://127.0.0.1:4173/) aç.
4. Otomatik testler için `npm test` çalıştır.

Edge tarayıcı testlerini çalıştırmak için sunucu açıkken PowerShell'de aşağıdaki komutları kullan. Gerekirse Edge dosya yolunu kendi kurulumuna göre değiştir.

```powershell
node route-test.mjs 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' http://127.0.0.1:4173
node logistics-test.mjs 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' http://127.0.0.1:4173
```

## Render üzerinde yayımlama

1. Render Dashboard'da **New → Blueprint** seçip GitHub deposunu ve `main` dalını bağla. Blueprint, depodaki `render.yaml` dosyasını okur.
2. Render anahtarı istediğinde gerçek değeri Dashboard'daki `ORS_API_KEY` gizli ortam değişkenine gir. Mevcut bir hizmete sonradan ekliyorsan **Environment** ekranını kullan.
3. Dağıtımı başlat. Render'ın hizmet adresinde `/healthz` yolunun HTTP 200 döndürdüğünü, ardından kişisel rota ve lojistik hesaplarının çalıştığını doğrula.

Hizmeti elle kurmak için **Web Service** ve **Node** seç. Derleme komutu `npm ci`, başlatma komutu `npm start`, sağlık kontrol yolu `/healthz`. Sunucu, Render'da `0.0.0.0` üzerinden platformun sağladığı `PORT` değerini dinler. Canlı rota yapılandırması eksik olsa da sağlık uç noktası sunucunun ayakta olduğunu bildirir. [Render Web Services](https://render.com/docs/web-services) · [Blueprint yapılandırması](https://render.com/docs/blueprint-spec)

## Veriler ve servisler

- Yolculuklar, düzenli rotalar, sevkiyatlar ve bütçe tarayıcının LocalStorage alanında tutulur. Yerel adres ve yayın adresi ayrı depolama alanları kullanır. Yereldeki kayıtlar yayın adresine otomatik taşınmaz.
- ORS anahtarı yalnızca sunucuda kalır. Tarayıcı aynı adres üzerindeki göreli API yollarını kullanır. Sunucu dış site kaynaklı tarayıcı isteklerini reddeder ve ORS için süreç başına istek sınırı uygular. Yayındaki rota kotası o hizmetin kullanıcıları arasında paylaşılır.
- Harita atfı harita üzerinde görünür. Karolar HTTPS üzerinden doğrudan yüklenir, tarayıcı önbelleği kullanılır. [OpenStreetMap karo kullanım politikası](https://operations.osmfoundation.org/policies/tiles/)
