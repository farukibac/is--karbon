"use strict";

(() => {
  const element = id => document.getElementById(id);
  const fields = ["routeStart", "routeEnd"].map(id => ({
    input: element(id), results: element(id + "Results"), point: null
  }));
  const preset = element("routePreset");
  const status = element("routeStatus");
  const mapStatus = element("routeMapStatus");
  const saveStatus = element("routeSaveStatus");
  const passengers = element("routePassengers");
  const frequency = element("routeFrequency");
  const carToggle = element("showCarRoute");
  const railToggle = element("showRailRoute");
  const saveSelected = element("saveSelectedRoute");
  const choices = [...element("routeTransportChoices").querySelectorAll("input")];
  const busKm = element("routeBusKm");
  const confirmRail = element("routeConfirm");
  const confirmLabel = element("routeConfirmLabel");
  const calculate = element("routeCalculate");
  const regular = typeof regularRoutes === "undefined" ? null : regularRoutes;
  const number = (value, digits = 1) => value.toLocaleString("tr-TR", { maximumFractionDigits: digits });
  const emission = value => `${formatEmission(value)} kg CO₂e`;
  function coordinatesValid(coordinates) {
    if (!Array.isArray(coordinates)) return false;
    const [lon, lat] = coordinates;
    return Number.isFinite(lon) && Number.isFinite(lat) &&
      lon >= 27.95 && lon <= 30 && lat >= 40.78 && lat <= 41.62;
  }

  function pointValid(point) {
    return typeof point?.label === "string" && Boolean(point.label.trim()) && coordinatesValid(point.coordinates);
  }

  let map;
  let markers;
  const modes = {
    car: { toggle: carToggle, color: "#315f97" },
    rail: { toggle: railToggle, color: "#16734b", dash: "5 8" },
    walk: { toggle: element("showWalkRoute"), color: "#8745a3", dash: "2 8", longKm: 5 },
    bike: { toggle: element("showBikeRoute"), color: "#a34d00", dash: "12 7", longKm: 15 },
    bus: { toggle: element("showBusRoute"), color: "#8c4762", dash: "7 5" },
    ring: { toggle: element("showRingRoute"), color: "#137983", dash: "12 4 3 4" }
  };
  const roads = ["car", "walk", "bike"];
  let pickIndex = null;
  let revision = 0;
  let result;
  let saved = false;
  let calculation;
  let pilotData;

  element("routeFactors").textContent =
    `Otomobil: ${number(routeFactors.car.value, 2)} ${routeFactors.car.unit}, raylı sistem: ${number(routeFactors.metro.value, 2)} ${routeFactors.metro.unit}. ` +
    `Kaynak: ${routeFactors.source}. Güncelleme: ${routeFactors.reviewed}. Bunlar Türkiye için doğrulanmış katsayılar değildir. ` +
    "Pilot hesapta M2 ve elektrikli F3 için aynı raylı sistem katsayısı varsayılır. Yürüyüş ve bisikletin işletim emisyonu sıfır kabul edilir.";

  async function getData(path, signal) {
    let response;
    try {
      const timeout = AbortSignal.timeout(12000);
      response = await fetch(path, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      if (error.name === "TimeoutError") throw new Error("Rota isteği zaman aşımına uğradı. Tekrar dene.");
      throw new Error("Bağlantı kurulamadı. İnternet bağlantısını ve yerel rota sunucusunu kontrol et.");
    }
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw new Error("Yerel sunucu beklenen rota yanıtını vermedi. Sunucuyu node --env-file=.env server.mjs ile yeniden başlat.");
    }
    const data = await response.json();
    if (response.status === 404 && data.error === "Sayfa bulunamadı." && path.startsWith("/api/route/")) {
      throw new Error("Rota uç noktası sunucuda bulunamadı. Güncel Node.js sunucusunu yeniden başlat.");
    }
    if (!response.ok) throw Error(data.error || "Rota servisi yanıt vermedi.");
    return data;
  }

  function resetResult() {
    revision++;
    calculation?.abort();
    calculate.disabled = false;
    result = null;
    regular?.setCalculated(null);
    saved = false;
    confirmRail.checked = false;
    confirmLabel.hidden = true;
    for (const mode of Object.values(modes)) {
      mode.layer?.clearLayers();
      mode.toggle.disabled = true;
    }
    element("ringCard").hidden = true;
    modes.ring.toggle.parentElement.hidden = true;
    modes.bus.toggle.parentElement.hidden = true;
    element("routeResults").hidden = true;
    element("routeSave").hidden = true;
    element("routeImpact").hidden = true;
    element("routeSaveActions").hidden = true;
    element("routeBusInput").hidden = true;
    for (const choice of choices) choice.checked = false;
    busKm.value = "";
    saveSelected.disabled = true;
    showFeedback(saveStatus, "");
    showFeedback(status, "");
  }

  function focusMap(bounds, options) {
    try {
      map.fitBounds(bounds, options);
    } catch {
      showFeedback(mapStatus, "Harita konumlara odaklanamadı. Seçili noktalar rota hesabında kullanılabilir.", true);
    }
  }

  function drawMarkers(fit = true) {
    if (!map) return;
    markers.clearLayers();
    fields.forEach(({ point }, index) => {
      if (!point) return;
      const popup = document.createElement("span");
      popup.textContent = `${index ? "Varış" : "Başlangıç"} · ${point.label}`;
      L.marker([point.coordinates[1], point.coordinates[0]], { title: popup.textContent })
        .bindPopup(popup).addTo(markers);
    });
    if (fit && markers.getLayers().length) {
      focusMap(markers.getBounds(), { padding: [30, 30], maxZoom: 15 });
    }
  }

  function clearSearch(field) {
    clearTimeout(field.timer);
    field.search?.abort();
    field.results.hidden = true;
    field.results.replaceChildren();
  }

  function updateLocations(changes, { presetValue = "", fit = true } = {}) {
    for (const [field, point, text = point?.label ?? ""] of changes) {
      clearSearch(field);
      field.point = pointValid(point) ? point : null;
      field.input.value = text;
    }
    pickIndex = null;
    preset.value = presetValue;
    resetResult();
    drawMarkers(fit);
  }

  for (const [key, pair] of Object.entries(routePresets)) {
    const option = new Option(pair.label, key);
    option.disabled = !pointValid(pair.start) || !pointValid(pair.end) ||
      pair.start.coordinates.join() === pair.end.coordinates.join();
    preset.add(option, preset.options.length - 1);
  }

  preset.addEventListener("change", () => {
    const key = preset.value;
    if (key === "custom") {
      updateLocations(fields.map(field => [field, null]), { presetValue: key, fit: false });
      fields[0].input.focus();
      return;
    }
    const pair = routePresets[key];
    if (!pair || preset.selectedOptions[0]?.disabled) return;
    updateLocations([[fields[0], pair.start], [fields[1], pair.end]], { presetValue: key });
  });

  function showSuggestions(field, choices) {
    field.results.hidden = !choices.length;
    if (!choices.length) {
      showFeedback(status, "Kesin konum bulunamadı. Bir adres veya istasyon adı yaz ya da haritadan bir nokta seç.", true);
      return;
    }
    field.results.add(new Option("Bir konum seç", ""));
    choices.forEach((item, index) => field.results.add(new Option(item.label, String(index))));
    field.results.onchange = () => {
      if (field.results.value !== "") updateLocations([[field, choices[Number(field.results.value)]]]);
    };
    showFeedback(status, "Listeden kesin bir konum seç.");
  }

  async function suggest(field, query, controller) {
    if (controller.signal.aborted) return;
    const normalized = query.toLocaleLowerCase("tr");
    const local = [routePresets.rail.start, routePresets.rail.end].filter(point => point.label.toLocaleLowerCase("tr").includes(normalized));
    try {
      if (local.length) showSuggestions(field, local);
      const remote = await getData(`/api/route/search?q=${encodeURIComponent(query)}`, controller.signal);
      if (!controller.signal.aborted) {
        field.results.replaceChildren();
        showSuggestions(field, [...local, ...remote]);
      }
    } catch (error) {
      if (!controller.signal.aborted && !local.length) showFeedback(status, error.message, true);
    }
  }

  for (const field of fields) {
    field.input.addEventListener("input", () => {
      updateLocations([[field, null, field.input.value]], { fit: false });
      const query = field.input.value.trim();
      if (query.length < 3 || query.length > 120) return;
      field.search = new AbortController();
      const controller = field.search;
      field.timer = setTimeout(() => suggest(field, query, controller), 650);
    });
  }

  element("routeSwap").addEventListener("click", () => {
    const [start, end] = fields;
    updateLocations([[start, end.point, end.input.value], [end, start.point, start.input.value]]);
  });

  function initializeMap() {
    if (typeof L === "undefined") {
      showFeedback(mapStatus, "Harita yüklenemedi. Adres aramasını kullanabilirsin.", true);
      return;
    }
    map = L.map("routeMap").setView([41.055, 28.99], 11);
    const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      referrerPolicy: "strict-origin-when-cross-origin",
      updateWhenIdle: true,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    let tileFailed = false;
    tiles.on("loading", () => { tileFailed = false; });
    tiles.on("tileerror", () => {
      tileFailed = true;
      showFeedback(mapStatus, "OpenStreetMap görsellerinin bir bölümü yüklenemedi. Seçili noktalar ve rota çizgileri kullanılabilir.", true);
    });
    tiles.on("load", () => {
      if (!tileFailed) showFeedback(mapStatus, "");
    });
    markers = L.featureGroup().addTo(map);

    [element("pickStart"), element("pickEnd")].forEach((button, index) => {
      button.disabled = false;
      button.addEventListener("click", () => {
        pickIndex = index;
        showFeedback(status, "Noktayı seçmek için haritaya dokun.");
      });
    });
    map.on("click", ({ latlng }) => {
      if (pickIndex === null) return;
      const coordinates = [latlng.lng, latlng.lat].map(value => Number(value.toFixed(6)));
      if (!coordinatesValid(coordinates)) return showFeedback(status, "İstanbul arama alanı içinde bir nokta seç.", true);
      updateLocations([[fields[pickIndex], { coordinates, label: `${coordinates[1]}, ${coordinates[0]}` }]]);
    });
    for (const mode of Object.values(modes)) {
      mode.layer = L.featureGroup();
      if (mode.toggle.checked) mode.layer.addTo(map);
      mode.toggle.addEventListener("change", () => mode.toggle.checked ? mode.layer.addTo(map) : mode.layer.remove());
    }
  }

  function validLine(points) {
    return Array.isArray(points) && points.length >= 2 && points.every(point =>
      Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]) && coordinatesValid(point)
    ) && points.some(point => point[0] !== points[0][0] || point[1] !== points[0][1]);
  }

  function drawRoutes() {
    if (!map || !result) return;
    const bounds = L.latLngBounds(markers.getBounds());
    const { car, rail, walk, bike, ring, bus } = result;
    const segments = {
      car: [car?.coordinates], rail: rail?.segments ?? [], walk: [walk?.coordinates],
      bike: [bike?.coordinates], bus: [bus?.coordinates], ring: [ring?.verified ? ring.coordinates : null]
    };
    for (const [key, mode] of Object.entries(modes)) {
      mode.layer.clearLayers();
      const lines = segments[key].filter(validLine);
      mode.toggle.disabled = !lines.length;
      if (key === "ring" || key === "bus") mode.toggle.parentElement.hidden = !lines.length;
      for (const coordinates of lines) {
        const line = L.polyline(coordinates.map(([lon, lat]) => [lat, lon]), {
          color: mode.color, weight: key === "car" ? 6 : 4, dashArray: mode.dash
        }).addTo(mode.layer);
        bounds.extend(line.getBounds());
      }
    }
    if (bounds.isValid()) focusMap(bounds, { padding: [28, 28], maxZoom: 16 });
  }

  function samePoint(selected, known) {
    return Math.hypot(selected.coordinates[0] - known.coordinates[0], selected.coordinates[1] - known.coordinates[1]) <= 0.00045;
  }

  function matchBus(start, end) {
    return verifiedBusLines.find(line => line.verified && pointValid(line.start) && pointValid(line.end) &&
      samePoint(start, line.start) && samePoint(end, line.end) && validLine(line.coordinates) &&
      Number.isFinite(line.km) && line.km > 0 && typeof line.source === "string" && line.source.trim());
  }

  function matchRing(start, end) {
    if (samePoint(start, campusRing.start) && samePoint(end, campusRing.end)) return campusRing;
    if (samePoint(start, campusRing.end) && samePoint(end, campusRing.start)) {
      return { ...campusRing, coordinates: null, verified: false };
    }
    return null;
  }

  function matchPilot(pilot, start, end) {
    if (!pointValid(pilot?.start) || !pointValid(pilot.end) || !Number.isFinite(pilot.km) || pilot.km <= 0 ||
        !Array.isArray(pilot.segments) || !pilot.segments.length || !pilot.segments.every(validLine)) return null;
    if (samePoint(start, pilot.start) && samePoint(end, pilot.end)) return { ...pilot, transfers: pilot.forward };
    if (samePoint(start, pilot.end) && samePoint(end, pilot.start)) return { ...pilot, transfers: pilot.reverse };
    return null;
  }

  calculate.addEventListener("click", async () => {
    const [start, end] = fields.map(({ point, input }) => pointValid(point) && input.value === point.label ? point : null);
    if (!start || !end) return showFeedback(status, "Başlangıç ve varış için listeden veya haritadan kesin bir nokta seç.", true);
    if (start.coordinates.join() === end.coordinates.join()) {
      return showFeedback(status, "İstanbul’da birbirinden farklı iki geçerli nokta seç.", true);
    }
    resetResult();
    pickIndex = null;
    const current = revision;
    calculation = new AbortController();
    const { signal } = calculation;
    calculate.disabled = true;
    showFeedback(status, "Rota hesaplanıyor…");
    const query = new URLSearchParams({ start: start.coordinates.join(), end: end.coordinates.join() });
    const responses = await Promise.allSettled([...roads.map(mode => getData(`/api/route/${mode}?${query}`, signal)), pilotData]);
    if (current !== revision) return;
    const routes = Object.fromEntries(roads.map((mode, index) => [mode, responses[index].value ?? null]));
    const errors = Object.fromEntries(roads.map((mode, index) => [mode, responses[index].reason?.message]));
    const rail = matchPilot(responses.at(-1).value, start, end);
    const ring = matchRing(start, end);
    calculate.disabled = false;
    showFeedback(status, roads.some(mode => routes[mode]) ? "" : errors.car || "Yol ağı rotası bulunamadı.", !roads.some(mode => routes[mode]));
    result = { ...routes, rail, ring, bus: matchBus(start, end), errors, start, end };
    try {
      renderResult();
    } catch {
      showFeedback(status, "Rota yanıtı alındı ancak sonuç kartları gösterilemedi.", true);
    }
    try {
      drawRoutes();
    } catch {
      showFeedback(mapStatus, "Rota geometrisi haritada çizilemedi.", true);
    }
  });

  function roadSource(road) {
    return road.cached ? "ORS yol ağı · en fazla 15 dk önbellek" : "ORS yol ağı";
  }

  function renderResult() {
    if (!result) return;
    const { car, rail, ring, errors } = result;
    const occupants = passengers.valueAsNumber;
    const tripsPerWeek = frequency.valueAsNumber;
    const valid = passengers.validity.valid;
    const impact = valid && car ? compareRouteEmissions(car.km, rail?.km ?? null, occupants) : null;
    const railEmission = rail ? rail.km * routeFactors.metro.value : null;
    const options = routeOptions(impact, railEmission);
    for (const [mode, option] of Object.entries(options)) option.emissionModel = emissionModelFor(mode, option);
    regular?.setCalculated({ start: result.start, end: result.end, options, weekly: frequency.validity.valid ? tripsPerWeek : 5 });
    element("routeResults").hidden = false;
    element("routeSave").hidden = false;
    element("routeSaveActions").hidden = false;
    element("carMetrics").textContent = car
      ? `${number(car.km, 2)} km · openrouteservice yol ağı\nTahmini süre: ${number(car.minutes)} dk${car.cached ? " · en fazla 15 dk önbellek" : ""}\n${impact ? emission(impact.car) + " / kişi" : "Geçerli bir kişi sayısı gir."}`
      : errors.car || "Otomobil mesafesi alınamadı.";
    renderActiveRoutes();
    element("ringCard").hidden = !ring;
    if (ring) renderRing(options.ring);
    element("railMetrics").textContent = rail
      ? `${number(rail.km, 2)} km · pilot ray geometrisinden yaklaşık mesafe\n${emission(railEmission)} / kişi\n${rail.transfers}\nSüre ve yaya bağlantısı: veri yok. Pilot hat, canlı sefer bilgisi içermez.`
      : "Bu güzergâh için doğrulanmış toplu taşıma alternatifi henüz bulunmuyor.";
    renderSelection(options);
  }

  function routeOptions(impact, railEmission) {
    const { car, rail, ring, bus } = result;
    const options = {};
    if (impact) options.car = { km: car.km, minutes: car.minutes, emission: impact.car, passengers: passengers.valueAsNumber, source: roadSource(car), dataStatus: "Canlı ORS" };
    for (const mode of ["walk", "bike"]) {
      const road = result[mode];
      if (road) options[mode] = { km: road.km, minutes: road.minutes, emission: calculateEmission(mode, road.km), source: roadSource(road), dataStatus: "Canlı ORS" };
    }
    if (rail) options.metro = { km: rail.km, emission: railEmission, source: "Pilot ray geometrisi", dataStatus: "Pilot raylı sistem" };
    const busDistance = bus?.km ?? (busKm.validity.valid ? busKm.valueAsNumber : NaN);
    if (Number.isFinite(busDistance) && busDistance > 0) {
      options.bus = {
        km: busDistance, minutes: bus?.minutes, emission: calculateEmission("bus", busDistance),
        source: bus?.source ?? "Kullanıcının girdiği mesafe", dataStatus: bus ? "Doğrulanmış otobüs hattı" : "Tahmini – kullanıcı beyanı"
      };
    }
    const ringOption = ring && campusRingOption(ring);
    if (ringOption) options.ring = ringOption;
    return options;
  }

  const selectedTransport = () => choices.find(choice => choice.checked)?.value;
  let availableOptions = {};

  function renderSelection(options) {
    availableOptions = options;
    const selected = selectedTransport();
    const actual = options[selected];
    const missing = {
      car: result.errors.car || "Geçerli rota ve kişi sayısı gerekli.",
      walk: result.errors.walk || "Rota bulunamadı.",
      bike: result.errors.bike || "Rota bulunamadı.",
      bus: "Otobüsle katettiğin 0–1000 km arası pozitif mesafeyi gir.",
      metro: "Doğrulanmış rota bulunamadı.",
      ring: result.ring ? "Pilot ring girdilerini tamamla." : "Bu güzergâhta kampüs ringi bulunmuyor."
    };
    element("routeBusInput").hidden = selected !== "bus" || Boolean(result.bus);
    for (const { value } of choices) {
      const option = options[value];
      element("choice" + value[0].toUpperCase() + value.slice(1)).textContent = option
        ? `${number(option.km, 2)} km${Number.isFinite(option.minutes) ? " · " + number(option.minutes) + " dk" : ""} · ${emission(option.emission)} / kişi\n${option.dataStatus}`
        : missing[value];
    }
    showFeedback(element("routeSelectionStatus"), selected && !actual ? missing[selected] : "", Boolean(selected && !actual));
    saveSelected.disabled = !actual || saved;
    confirmLabel.hidden = !actual || selected === "car" || !options.car || options.car.emission <= actual.emission || saved;
    if (confirmLabel.hidden) confirmRail.checked = false;
    const alternatives = Object.entries(options).filter(([mode]) => mode !== selected).sort((a, b) => a[1].emission - b[1].emission);
    element("routeImpact").hidden = !actual || !alternatives.length;
    if (!actual || !alternatives.length) return;
    const [alternativeMode, alternative] = alternatives[0];
    const difference = actual.emission - alternative.emission;
    const actualLabel = transportNames[selected];
    const alternativeLabel = transportNames[alternativeMode];
    element("routeDifference").textContent = `Karşılaştırma referansı: ${actualLabel} · ${emission(actual.emission)} / kişi.`;
    element("carBarLabel").textContent = `${actualLabel} · ${emission(actual.emission)}`;
    element("railBarLabel").textContent = `${alternativeLabel} · ${emission(alternative.emission)}`;
    const max = Math.max(actual.emission, alternative.emission);
    element("carBar").style.width = `${max ? actual.emission / max * 100 : 0}%`;
    element("railBar").style.width = `${max ? alternative.emission / max * 100 : 0}%`;
    element("routeAlternatives").replaceChildren(...alternatives.map(([mode, option]) => {
      const item = document.createElement("li");
      const delta = actual.emission - option.emission;
      const comparison = delta > 0 ? "azaltım potansiyeli" : delta < 0 ? "tahmini emisyon artışı" : "fark yok";
      item.textContent = `${transportNames[mode]} · ${emission(option.emission)} / kişi · ${comparison}${delta ? " " + emission(Math.abs(delta)) : ""}`;
      return item;
    }));
    element("routeProjection").textContent = difference > 0 && frequency.validity.valid
      ? `${alternativeLabel} alternatifi için haftada ${frequency.valueAsNumber} yolculukta ${emission(difference * frequency.valueAsNumber)} azaltım potansiyeli.` : "";
  }

  function renderActiveRoutes() {
    for (const mode of ["walk", "bike"]) {
      const route = result[mode];
      const metrics = element(mode + "Metrics");
      const card = element(mode + "Card");
      const long = route?.km > modes[mode].longKm;
      card.classList.toggle("route-lowest", Boolean(route && !long));
      if (!route) {
        metrics.textContent = result.errors[mode] || "Uygun rota bulunamadı.";
        continue;
      }
      const estimate = calculateEmission(mode, route.km);
      const lines = [
        `${number(route.km, 2)} km · openrouteservice yol ağı`,
        `Tahmini süre: ${number(route.minutes)} dk${route.cached ? " · en fazla 15 dk önbellek" : ""}`,
        `${emission(estimate)} / kişi · işletim emisyonu`
      ];
      if (long) lines.push("Uzun rota. Sürenin ve yol koşullarının sana uygunluğunu kontrol et.");
      else lines.push("En düşük tahmini emisyon");
      metrics.textContent = lines.join("\n");
    }
  }

  function renderRing(option) {
    element("ringMetrics").textContent = option
      ? `${option.vehicleType} · ${option.dataStatus} · ${emission(option.emission)} / kişi · ${emission(option.vehicleEmission)} / sefer`
      : "Ring emisyonu hesaplanamadı.";
  }

  function record() {
    const transport = selectedTransport();
    const actual = result && availableOptions[transport];
    if (!actual || saved) return;
    const car = availableOptions.car;
    const declared = transport !== "car" && confirmRail.checked && car && car.emission > actual.emission;
    const trip = {
      id: createTripId(), transport, distance: actual.km, emission: actual.emission,
      replacedCar: Boolean(declared), emissionModel: emissionModelFor(transport, actual), createdAt: new Date().toISOString(),
      route: {
        start: result.start, end: result.end, passengers: actual.passengers ?? 1, actualTransport: transport,
        source: actual.source, dataStatus: actual.dataStatus, vehicleType: actual.vehicleType,
        assumptionVersion: actual.assumptionVersion, emissionFactor: actual.kgPerVehicleKm, emissionFactorUnit: actual.factorUnit,
        referenceEmission: declared ? car.emission : null,
        declaredReduction: declared ? car.emission - actual.emission : null
      }
    };
    const minute = date => Math.floor(Date.parse(date) / 60000);
    const duplicate = trips.some(previous => previous.transport === transport && minute(previous.createdAt) === minute(trip.createdAt) &&
      pointValid(previous.route?.start) && pointValid(previous.route?.end) &&
      samePoint(previous.route.start, result.start) && samePoint(previous.route.end, result.end));
    if (duplicate || regular?.hasRecordedOccurrence(trip)) return showFeedback(saveStatus, "Bu yolculuk bu dakika için zaten kaydedilmiş.", true);
    if (!saveTrip(trip)) return showFeedback(saveStatus, "Yolculuk tarayıcıya kaydedilemedi. Tekrar deneyebilirsin.", true);
    saved = true;
    showFeedback(saveStatus, "Yolculuk geçmişine kaydedildi.");
    refreshApp();
    renderResult();
  }

  for (const input of [busKm, passengers, frequency]) input.addEventListener("input", renderResult);
  for (const choice of choices) choice.addEventListener("change", () => {
    confirmRail.checked = false;
    renderResult();
  });
  saveSelected.addEventListener("click", record);
  const routeView = element("akilli-rota");
  let mapRequested = false;
  function showMap() {
    if (!mapRequested) {
      mapRequested = true;
      initializeMap();
      drawMarkers();
      drawRoutes();
    }
    if (map) requestAnimationFrame(() => map.invalidateSize({ pan: false }));
  }
  routeView.addEventListener("routeviewshown", showMap);
  routeView.addEventListener("campusmap", ({ detail: { start, end } }) => {
    updateLocations([[fields[0], start], [fields[1], end]]);
  });
  if (!routeView.hidden) showMap();
  pilotData = getData("/pilot-rail.json").catch(() => null);
  if (!regular) showFeedback(status, "Düzenli Rotalarım dosyası yüklenemedi. Güncel Node.js sunucusunu yeniden başlat.", true);
})();
