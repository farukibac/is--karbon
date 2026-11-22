import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const apiKey = process.env.ORS_API_KEY?.trim();
const base = "https://api.heigit.org";
const assets = new Map([
  ["/", ["index.html", "text/html"]],
  ["/index.html", ["index.html", "text/html"]],
  ["/style.css", ["style.css", "text/css"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/route-config.js", ["route-config.js", "text/javascript"]],
  ["/regular-routes.js", ["regular-routes.js", "text/javascript"]],
  ["/campus-rings.js", ["campus-rings.js", "text/javascript"]],
  ["/route.js", ["route.js", "text/javascript"]],
  ["/pilot-rail.json", ["pilot-rail.json", "application/json"]]
]);
const profiles = new Map([["/api/route/car", "driving-car"], ["/api/route/walk", "foot-walking"], ["/api/route/bike", "cycling-regular"]]);
const inFlight = new Map();
const limits = { search: { minute: 30, day: 500 }, directions: { minute: 30, day: 500 } };
const usage = { search: [], directions: [] };
const cache = new Map();

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function inIstanbul([lon, lat]) {
  return Number.isFinite(lon) && Number.isFinite(lat) &&
    lon >= 27.95 && lon <= 30.0 && lat >= 40.78 && lat <= 41.62;
}

function point(value) {
  if (!/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(value ?? "")) return null;
  const coordinates = value.split(",").map(Number);
  return inIstanbul(coordinates) ? coordinates : null;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (request.method !== "GET") return json(response, 405, { error: "Geçersiz istek yöntemi." });
    const asset = assets.get(url.pathname);
    if (asset) {
      const data = await readFile(new URL(asset[0], import.meta.url));
      response.writeHead(200, { "Content-Type": asset[1] + "; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache" });
      return response.end(data);
    }

    const search = url.pathname === "/api/route/search";
    const profile = profiles.get(url.pathname);
    if (!search && !profile) return json(response, 404, { error: "Sayfa bulunamadı." });
    if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(request.headers.host ?? "") ||
        ["cross-site", "same-site"].includes(request.headers["sec-fetch-site"])) {
      return json(response, 403, { error: "Rota servisi yerel uygulamadan kullanılabilir." });
    }
    let upstream;
    let options;
    if (search) {
      const query = url.searchParams.get("q")?.trim() ?? "";
      if (query.length < 3 || query.length > 120) return json(response, 400, { error: "Arama için 3–120 karakter gir." });
      upstream = new URL("/pelias/v1/autocomplete", base);
      upstream.search = new URLSearchParams({
        text: query, size: "6", "boundary.country": "TUR",
        "boundary.rect.min_lon": "27.95", "boundary.rect.max_lon": "30",
        "boundary.rect.min_lat": "40.78", "boundary.rect.max_lat": "41.62"
      });
      options = { headers: { Authorization: apiKey ?? "" } };
    } else {
      const start = point(url.searchParams.get("start"));
      const end = point(url.searchParams.get("end"));
      if (!start || !end || start.join() === end.join()) {
        return json(response, 400, { error: "İstanbul’da birbirinden farklı iki geçerli nokta seç." });
      }
      upstream = new URL(`/openrouteservice/v2/directions/${profile}/geojson`, base);
      const body = { coordinates: [start, end] };
      if (profile !== "driving-car") body.options = { avoid_features: ["ferries"] };
      options = {
        method: "POST",
        headers: { Authorization: apiKey ?? "", "Content-Type": "application/json" },
        body: JSON.stringify(body)
      };
    }

    if (!apiKey) return json(response, 503, { error: "Rota servisi için sunucuda ORS_API_KEY eksik." });
    const cacheKey = search ? "search:" + url.searchParams.get("q").trim().toLocaleLowerCase("tr") : profile + ":" + options.body;
    const now = Date.now();
    const cached = cache.get(cacheKey);
    if (cached?.expires > now) return json(response, 200, search ? cached.data : { ...cached.data, cached: true });
    let pendingRequest = inFlight.get(cacheKey);
    if (!pendingRequest) {
      const service = search ? "search" : "directions";
      const pending = usage[service] = usage[service].filter(time => time > now - 86_400_000);
      if (pending.length >= limits[service].day || pending.filter(time => time > now - 60_000).length >= limits[service].minute) {
        return json(response, 429, { error: "Rota servisi istek sınırına ulaştı. Bir süre sonra tekrar dene." });
      }
      pending.push(now);
      pendingRequest = fetch(upstream, { ...options, signal: AbortSignal.timeout(9500) })
        .then(async result => ({ status: result.status, ok: result.ok, payload: await result.json().catch(error => {
          if (result.ok) throw error;
          return null;
        }) }))
        .finally(() => inFlight.delete(cacheKey));
      inFlight.set(cacheKey, pendingRequest);
    }
    const { status, ok, payload } = await pendingRequest;
    if (status === 429) return json(response, 429, { error: "Rota servisinin kotası doldu. Daha sonra tekrar dene." });
    if (status === 401 || status === 403) return json(response, 503, { error: "Rota servisi anahtarı reddetti. HeiGIT hesabındaki anahtarı ve kotayı kontrol et." });
    if (profile && (status === 404 || [2009, 2010, 2016].includes(payload?.error?.code))) return json(response, 404, { error: "Bu ulaşım türü için uygun rota bulunamadı. Haritada yola yakın başka bir nokta seçebilirsin." });
    if (profile && status === 501) return json(response, 503, { error: "Bu ulaşım profili şu anda kullanılamıyor." });
    if (!ok) return json(response, 502, { error: "OpenRouteService isteği başarısız oldu. Bir süre sonra tekrar dene." });

    let data;
    if (search) {
      data = (payload.features ?? []).filter(item =>
        typeof item.properties?.label === "string" && item.geometry?.type === "Point" &&
        ["address", "venue", "street"].includes(item.properties.layer) && Array.isArray(item.geometry.coordinates) &&
        inIstanbul(item.geometry.coordinates) &&
        /istanbul/i.test(String(item.properties.region ?? item.properties.label).normalize("NFD").replace(/\p{M}/gu, ""))
      ).map(item => ({ label: item.properties.label, coordinates: item.geometry.coordinates.slice(0, 2) }));
    } else {
      const feature = payload.features?.[0];
      const summary = feature?.properties?.summary;
      if (!Number.isFinite(summary?.distance) || summary.distance <= 0 ||
          !Number.isFinite(summary.duration) || summary.duration < 0 ||
          feature.geometry?.type !== "LineString" || !Array.isArray(feature.geometry.coordinates) ||
          feature.geometry.coordinates.length < 2 || !feature.geometry.coordinates.every(pair =>
            Array.isArray(pair) && Number.isFinite(pair[0]) && Number.isFinite(pair[1])) || !feature.geometry.coordinates.some(pair =>
            pair[0] !== feature.geometry.coordinates[0][0] || pair[1] !== feature.geometry.coordinates[0][1])) {
        return json(response, 404, { error: "Geçerli bir rota geometrisi bulunamadı." });
      }
      if (!feature.geometry.coordinates.every(inIstanbul)) {
        return json(response, 404, { error: "ORS güzergâhı İstanbul sınırlarının dışına çıkıyor. Bu ulaşım türü için uygun rota bulunamadı." });
      }
      data = { km: summary.distance / 1000, minutes: summary.duration / 60, coordinates: feature.geometry.coordinates, profile, source: "openrouteservice", fetchedAt: new Date().toISOString() };
    }
    if (cache.size >= 256) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, { expires: now + 900_000, data });
    return json(response, 200, data);
  } catch (error) {
    if (error.name === "TimeoutError") return json(response, 504, { error: "OpenRouteService isteği zaman aşımına uğradı." });
    if (error instanceof SyntaxError) return json(response, 502, { error: "OpenRouteService geçersiz bir yanıt döndürdü." });
    const message = error.code === "ENOENT" ? "Dosya bulunamadı." : "Sunucu OpenRouteService bağlantısını kuramadı. Tekrar dene.";
    return json(response, error.code === "ENOENT" ? 404 : 502, { error: message });
  }
});

server.on("error", error => {
  if (error.code !== "EADDRINUSE") throw error;
  console.error("İSÜ Karbon sunucusu başlatılamadı. Port kullanımda: " + (process.env.PORT ?? 4173) +
    ". Bu porttaki eski İSÜ Karbon sunucusunu durdurup yeniden başlat.");
  process.exitCode = 1;
});

server.listen(Number(process.env.PORT ?? 4173), "127.0.0.1", () => {
  console.log(`İSÜ Karbon http://127.0.0.1:${server.address().port}`);
});
