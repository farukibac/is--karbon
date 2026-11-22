import { cities, classes, LOGISTICS_MODEL, FACTOR_SOURCE } from "./logistics-config.js";
import { automaticProfile, budgetMonth, budgetPosition, compareEstimates, estimateShipment, historyComparison, inLogisticsArea, screeningScenarios, shipmentError, validHgvRoute } from "./logistics-emissions.js";

const element = id => document.getElementById(id);
const view = element("lojistik");
const form = element("logisticsForm");
const scenario = element("logisticsScenario");
const efficiency = element("logisticsEfficiency");
const field = name => form.elements.namedItem(name);
const status = element("logisticsStatus");
const mapStatus = element("logisticsMapStatus");
const save = element("logisticsSave");
const calculate = element("logisticsCalculate");
const storageKey = "isu-logistics-shipments-v1";
const budgetKey = "isu-logistics-budget-v1";
const budgetInput = element("logisticsBudgetInput");
const budgetUnit = element("logisticsBudgetUnit");
const preset = element("logisticsPreset");
const fieldsets = [...form.querySelectorAll("[data-logistics-step]")];
const stepItems = [...view.querySelectorAll(".logistics-steps li")];
let step = 1;
const statuses = { planned: "Planlanan", realized: "Gerçekleşen", unknown: "Durumu doğrulanmamış" };
const recordStatus = item => ["planned", "realized"].includes(item.shipmentStatus) ? item.shipmentStatus : "unknown";
let currentMonth = budgetMonth();
let vehicleComparison;
let efficiencyComparison;
let shownRoutes = [];
let shownResponse;
let shownInput;
let vehicleCheck = 0;

const format = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 3 });
const number = value => format.format(value);
const kg = value => number(value) + " kg CO₂e";
const budgetAmount = value => Math.abs(value) >= 1000 ? number(value / 1000) + " ton CO₂e" : kg(value);
const points = {};
let map, markers, lines, pending, picking, result;
let saved = false;
let savedId;

function feedback(target, message, error = false) {
  target.textContent = message;
  target.toggleAttribute("data-error", error);
}

function readHistory() {
  try {
    const raw = localStorage.getItem(storageKey);
    const data = raw === null ? { version: 1, shipments: [] } : JSON.parse(raw);
    return data?.version === 1 && Array.isArray(data.shipments) && data.shipments.every(item =>
      typeof item?.id === "string" && Number.isFinite(item.emission) && item.emission >= 0 &&
      typeof item.start?.label === "string" && typeof item.end?.label === "string"
    ) ? data : null;
  } catch { return null; }
}

function updateHistory(update) {
  const data = readHistory();
  if (!data) return false;
  try {
    localStorage.setItem(storageKey, JSON.stringify({ ...data, shipments: update(data.shipments) }));
  } catch { return false; }
  renderHistory();
  renderBudget();
  return true;
}

function renderHistory() {
  const history = readHistory();
  const list = element("logisticsHistory");
  list.replaceChildren();
  element("logisticsTotal").textContent = history
    ? history.shipments.length + " sevkiyat · " + kg(history.shipments.reduce((sum, item) => sum + item.emission, 0))
    : "Sevkiyat geçmişi okunamadı.";
  const filter = element("logisticsHistoryFilter").value;
  for (const item of [...(history?.shipments ?? [])].reverse()) {
    const state = recordStatus(item);
    if (filter && state !== filter) continue;
    const row = document.createElement("li");
    const summary = document.createElement("article");
    const title = document.createElement("h3");
    title.textContent = item.start.label + " → " + item.end.label;
    const stateLabel = document.createElement("span");
    stateLabel.className = "logistics-state";
    stateLabel.dataset.state = state;
    stateLabel.textContent = statuses[state];
    const main = document.createElement("p");
    main.textContent = (classes[item.vehicle]?.label ?? "Yük aracı") + " · " + number(item.load) + " ton · " +
      kg(item.emission) + " · " + new Date(item.createdAt).toLocaleDateString("tr-TR", { timeZone: "Europe/Istanbul" });
    const technical = document.createElement("details");
    const toggle = document.createElement("summary");
    toggle.textContent = "Sevkiyat detayları";
    const text = document.createElement("p");
    const method = { vehicle: "Araç-km", tonne: "Ton-km", fuel: "Yakıt tüketimi" };
    text.textContent = [
      item.cargo, Number.isFinite(item.km) ? number(item.km) + " km" : null,
      Number.isFinite(item.minutes) ? number(item.minutes) + " dk" : null,
      item.profile, item.routeStatus, method[item.factor?.method],
      item.factor?.label, Number.isFinite(item.factor?.value) ? item.factor.value.toLocaleString("tr-TR", { maximumFractionDigits: 8 }) + " " + item.factor.unit : null,
      item.factor?.geography, item.factor?.year, item.factor?.boundary, item.model
    ].filter(Boolean).join(" · ");
    technical.append(toggle, text);
    if (item.factor?.source === FACTOR_SOURCE) {
      const source = document.createElement("a");
      source.href = FACTOR_SOURCE;
      source.textContent = "DESNZ katsayı dosyası";
      technical.append(source);
    }
    summary.append(title, stateLabel, main, technical);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete-button";
    remove.textContent = "Sil";
    remove.setAttribute("aria-label", item.start.label + " → " + item.end.label + " sevkiyatını sil");
    const confirmation = document.createElement("div");
    confirmation.hidden = true;
    confirmation.className = "logistics-history-actions";
    const question = document.createElement("p");
    question.textContent = title.textContent + " sevkiyatı silinsin mi?";
    const confirmDelete = document.createElement("button");
    confirmDelete.type = "button";
    confirmDelete.className = "delete-button";
    confirmDelete.textContent = "Sevkiyatı sil";
    confirmDelete.addEventListener("click", () => {
      if (!updateHistory(records => records.filter(record => record.id !== item.id))) {
        feedback(element("logisticsHistoryStatus"), "Sevkiyat silinemedi.", true);
      } else {
        feedback(element("logisticsHistoryStatus"), "Sevkiyat silindi.");
        element("logisticsHistoryFilter").focus();
      }
    });
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "route-secondary";
    cancel.textContent = "Vazgeç";
    cancel.addEventListener("click", () => {
      confirmation.hidden = true;
      remove.focus();
    });
    confirmation.append(question, cancel, confirmDelete);
    remove.addEventListener("click", () => {
      confirmation.hidden = false;
      cancel.focus();
    });
    const actions = document.createElement("div");
    actions.className = "logistics-history-actions";
    for (const target of ["planned", "realized"]) {
      if (state === target) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "route-secondary";
      button.textContent = target === "planned" ? "Planlanan olarak işaretle" : "Gerçekleşti olarak işaretle";
      button.addEventListener("click", () => {
        const success = updateHistory(records => records.map(record => record.id === item.id
          ? { ...record, shipmentStatus: target, realizedAt: target === "realized" ? new Date().toISOString() : null }
          : record));
        feedback(element("logisticsHistoryStatus"), success ? "Durum güncellendi. Emisyon değeri korundu." : "Durum kaydedilemedi.", !success);
      });
      actions.append(button);
    }
    actions.append(remove);
    const historyAnalysis = document.createElement("details");
    const analysisToggle = document.createElement("summary");
    analysisToggle.textContent = "Karbon azaltımını analiz et";
    const analysis = document.createElement("p");
    analysis.setAttribute("role", "status");
    historyAnalysis.append(analysisToggle, analysis);
    historyAnalysis.addEventListener("toggle", () => {
      if (!historyAnalysis.open) return;
      const comparison = item.comparison ?? (() => {
        const calculated = historyComparison(item);
        return calculated?.best ? {
          ...comparisonMetadata(calculated.base, calculated.best, false, item.id),
          separateBaseline: !calculated.original
        } : null;
      })();
      analysis.textContent = "Kayıtlı emisyon " + kg(item.emission) + ". " + (comparison
        ? (comparison.applied ? (comparison.difference > 0 ? "Uygulanan planın referansa göre tahmini emisyon avantajı"
          : "Uygulanan planın referansa göre emisyon karşılaştırması")
          : state === "realized" ? "Kaçırılan Karbon Azaltım Fırsatı · Geçmiş sevkiyat için varsayımsal iyileştirme potansiyeli"
            : "Potansiyel azaltım") + ". " +
          (comparison.separateBaseline ? "Güncel yöntemle ayrı karşılaştırma. " : "") +
          "Referans " + kg(comparison.baselineEmission) + " · Alternatif " + kg(comparison.alternativeEmission) +
          " · Tahmini fark " + kg(comparison.difference) +
          (comparison.percent === null ? ". " : " (%" + number(comparison.percent) + "). ") +
          comparison.title + " · " + comparison.verification + "."
        : "Karşılaştırılabilir hesaplama verisi bulunamadı.");
      if (!item.comparison && comparison) {
        const current = readHistory();
        const fresh = current?.shipments.find(entry => entry.id === item.id);
        if (!fresh || fresh.comparison || fresh.emission !== item.emission) return;
        try {
          localStorage.setItem(storageKey, JSON.stringify({ ...current,
            shipments: current.shipments.map(entry => entry.id === item.id ? { ...entry, comparison } : entry) }));
          item.comparison = comparison;
          renderBudget();
        } catch { feedback(element("logisticsHistoryStatus"), "Analiz kaydedilemedi.", true); }
      }
    });
    row.append(summary, historyAnalysis, actions, confirmation);
    list.append(row);
  }
}

function clearResult() {
  pending?.abort();
  pending = null;
  result = null;
  vehicleComparison = null;
  efficiencyComparison = null;
  vehicleCheck++;
  saved = false;
  savedId = undefined;
  calculate.disabled = false;
  lines?.clearLayers();
  element("logisticsAnalysis").hidden = element("logisticsScenarios").hidden = true;
  element("logisticsRoads").replaceChildren();
  for (const id of ["logisticsStatus", "logisticsRouteStatus", "logisticsSaveStatus", "logisticsScenarioStatus", "logisticsEfficiencyStatus"]) {
    feedback(element(id), "");
  }
}

const leafletPoint = ([lon, lat]) => [lat, lon];

function drawPoints() {
  element("logisticsMapEmpty").hidden = Boolean(points.start && points.end);
  if (!map) return;
  markers.clearLayers();
  for (const point of Object.values(points)) {
    const label = document.createElement("span");
    label.textContent = point.label;
    L.marker(leafletPoint(point.coordinates), { title: point.label }).bindTooltip(label).addTo(markers);
  }
  if (markers.getLayers().length) map.fitBounds(markers.getBounds(), { maxZoom: 13, padding: [20, 20] });
}

function selectPoint(name, point) {
  preset.value = "";
  if (point) points[name] = point;
  else delete points[name];
  clearResult();
  drawPoints();
}

function showMap() {
  if (!globalThis.L) return feedback(mapStatus, "Harita yüklenemedi. Listeden konum seçebilirsin.", true);
  if (!map) {
    map = L.map("logisticsMap").setView([40.1, 31.1], 7);
    const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    tiles.on("tileerror", () => feedback(mapStatus, "Bazı harita karoları yüklenemedi.", true));
    markers = L.featureGroup().addTo(map);
    lines = L.featureGroup().addTo(map);
    map.on("click", ({ latlng }) => {
      if (!picking) return;
      const coordinates = [latlng.lng, latlng.lat].map(value => Number(value.toFixed(6)));
      if (!inLogisticsArea(coordinates)) return feedback(mapStatus, "Türkiye çevresindeki harita alanından bir nokta seç.", true);
      const input = field(picking);
      input.querySelector('[value="map"]')?.remove();
      const label = coordinates.slice().reverse().join(", ");
      input.add(new Option(label, "map", false, true));
      selectPoint(picking, { label, coordinates, source: "Harita seçimi" });
      picking = null;
      feedback(mapStatus, "");
    });
    drawPoints();
  }
  requestAnimationFrame(() => map.invalidateSize());
}

for (const name of ["start", "end"]) {
  const input = field(name);
  input.add(new Option("Konum seç", ""));
  for (const [id, city] of Object.entries(cities)) input.add(new Option(city.label, id));
  input.addEventListener("change", () => {
    picking = null;
    feedback(mapStatus, "");
    if (input.value !== "map") {
      input.querySelector('[value="map"]')?.remove();
      selectPoint(name, cities[input.value]);
    }
  });
  element(name === "start" ? "logisticsPickStart" : "logisticsPickEnd").addEventListener("click", () => {
    if (!map) return feedback(mapStatus, "Harita kullanılamıyor.", true);
    picking = name;
    if (matchMedia("(max-width: 760px)").matches) element("logisticsMap").scrollIntoView({ block: "center" });
    feedback(mapStatus, name === "start" ? "Başlangıç için haritaya dokun." : "Varış için haritaya dokun.");
  });
}
preset.addEventListener("change", () => {
  const [start, end] = preset.value.split(":");
  if (!Object.hasOwn(cities, start) || !Object.hasOwn(cities, end) || start === end) return;
  for (const [name, id] of [["start", start], ["end", end]]) {
    field(name).querySelector('[value="map"]')?.remove();
    field(name).value = id;
    points[name] = cities[id];
  }
  picking = null;
  feedback(mapStatus, "");
  clearResult();
  drawPoints();
});

function setStep(next, focus = true) {
  step = next;
  fieldsets.forEach((fieldset, index) => { fieldset.hidden = index + 1 !== step; });
  stepItems.forEach((item, index) => {
    if (index + 1 === step) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  });
  element("logisticsBack").hidden = step === 1;
  element("logisticsNext").hidden = step === 3;
  if (step === 3) {
    const input = shipmentInputs();
    element("logisticsStepSummary").textContent = (points.start?.label ?? "—") + " → " + (points.end?.label ?? "—") +
      " · " + (classes[input.vehicle]?.label ?? "") + " · " + number(input.load) + " ton";
  }
  if (focus) fieldsets[step - 1].querySelector("legend").focus();
}

element("logisticsBack").addEventListener("click", () => setStep(step - 1));
element("logisticsNext").addEventListener("click", () => {
  if (step === 1 && (!points.start || !points.end || points.start.coordinates.join() === points.end.coordinates.join())) {
    return feedback(status, "Başlangıç ve varış için iki farklı konum seç.", true);
  }
  for (const control of fieldsets[step - 1].querySelectorAll("input, select")) {
    if (!control.validity.valid) {
      const details = control.closest("details");
      if (details) details.open = true;
      control.reportValidity();
      return;
    }
  }
  const error = step === 2 ? shipmentError(shipmentInputs()) : "";
  if (error) return feedback(status, error, true);
  feedback(status, "");
  setStep(step + 1);
});
form.addEventListener("invalid", event => {
  const owner = event.target.closest("[data-logistics-step]");
  if (!owner) return;
  setStep(Number(owner.dataset.logisticsStep), false);
  const details = event.target.closest("details");
  if (details) details.open = true;
}, true);
form.addEventListener("keydown", event => {
  if (event.key !== "Enter" || step === 3 || event.target.tagName !== "INPUT") return;
  event.preventDefault();
  element("logisticsNext").click();
});

for (const select of [field("vehicle"), scenario.elements.vehicle]) {
  for (const [id, item] of Object.entries(classes)) select.add(new Option(item.label, id));
}

function shipmentInputs() {
  const vehicle = field("vehicle").value;
  const model = automaticProfile(vehicle, { fuel: field("fuel").value,
    consumption: field("consumption").valueAsNumber, evidence: field("evidence").value });
  return {
    ...model, vehicle, cargo: field("cargo").value, shipmentStatus: field("shipmentStatus").value,
    load: field("load").valueAsNumber, capacity: field("capacity").valueAsNumber,
    gross: field("weight").value ? field("weight").valueAsNumber : undefined
  };
}

function addMetric(list, label, value) {
  const group = document.createElement("div");
  const title = document.createElement("dt");
  const detail = document.createElement("dd");
  title.textContent = label;
  detail.textContent = value;
  group.append(title, detail);
  list.append(group);
}

function renderResult(routes, response, input, reference, comparison) {
  shownRoutes = routes;
  shownResponse = response;
  shownInput = input;
  const ranked = routes.map(route => ({ route, estimate: estimateShipment({ ...input, km: route.km }) }));
  const { route, estimate } = ranked[0];
  if (!estimate) throw new Error("Hesaplama girdileri geçerli değil.");
  const routeStatus = route.profile === "manual" ? "Beyan edilen mesafe · HGV doğrulanmadı"
    : response.cached ? "ORS driving-hgv · en fazla 15 dk önbellek" : "ORS driving-hgv · tahmini süre";
  result = { ...input, ...estimate, start: points.start, end: points.end, profile: route.profile, routeStatus,
    reference, comparison, minutes: route.minutes, restrictions: response.restrictions, routeFetchedAt: response.fetchedAt };
  const list = element("logisticsMetrics");
  list.replaceChildren();
  addMetric(list, "Tahmini sevkiyat emisyonu", kg(estimate.emission));
  addMetric(list, "Güzergâh mesafesi", number(route.km) + " km");
  addMetric(list, "Bütçe etkisi", "");
  const details = element("logisticsDetails");
  details.replaceChildren();
  for (const [label, value] of [
    ["Yük", number(input.load) + " t"], ["Mesafe", number(route.km) + " km"],
    ["Taşıma faaliyeti", number(estimate.tonneKm) + " ton-km"],
    ["Ton başına", kg(estimate.perTonne) + "/ton"], ["Taşıma yoğunluğu", kg(estimate.intensity) + "/ton-km"]
  ]) addMetric(details, label, value);
  element("logisticsMethod").textContent = input.factor.label + " · " + input.factor.value + " " + input.factor.unit +
    " · DESNZ " + input.factor.year + " · " + input.factor.geography + " · " + input.factor.boundary + " · " + input.dataStatus + ". " +
    (input.factor.method === "fuel" ? number(estimate.litres) + " L = mesafe × tüketim / 100. Litre × katsayı."
      : input.factor.method === "tonne" ? "Yük × mesafe × ton-km katsayısı." : "Mesafe × araç-km katsayısı.");
  element("logisticsRouteStatus").textContent = routeStatus +
    (Number.isFinite(route.minutes) ? " · " + number(route.minutes) + " dk" : "") +
    (route.profile !== "manual" && !Object.keys(response.restrictions).length ? " · Araca özgü ölçüler girilmedi." : "");
  const shortest = ranked.reduce((best, item) => item.route.km < best.route.km ? item : best);
  const roads = element("logisticsRoads");
  roads.replaceChildren();
  if (ranked.length === 1 && route.profile !== "manual") {
    const note = document.createElement("li");
    note.textContent = response.alternativesRequested
      ? "ORS bu istek için ikinci bir ağır vasıta yolu döndürmedi."
      : "Bu hesaplamada ana ağır vasıta güzergâhı kullanıldı.";
    roads.append(note);
  }
  lines?.clearLayers();
  ranked.forEach((item, index) => {
    const line = document.createElement("li");
    line.textContent = (index ? "Alternatif " + index : "Ana yol") + " · " + number(item.route.km) + " km" +
      (Number.isFinite(item.route.minutes) ? " · " + number(item.route.minutes) + " dk" : "") +
      " · " + kg(item.estimate.emission) + " · " + routeStatus +
      (ranked.length > 1 && item === shortest ? " · En kısa ve bu modelde en düşük emisyonlu" : "");
    roads.append(line);
    if (map && item.route.coordinates) {
      L.polyline(item.route.coordinates.map(leafletPoint), { color: index ? "#706092" : "#16734b", dashArray: index ? "6 6" : undefined }).addTo(lines);
    }
  });
  if (map && lines.getBounds().isValid()) map.fitBounds(lines.getBounds(), { padding: [20, 20] });
  const advice = ["Doluluk %" + number(estimate.occupancy) + ". Sonuçlar seçilen aracın referans profiline dayanır."];
  if (estimate.occupancy < 50) advice.push("Sevkiyat birleştirme değerlendirilebilir. Ek tüketim ve sefer sayısı olmadan tasarruf hesaplanamaz.");
  element("logisticsAdvice").textContent = advice.join(" ");
  renderRecommendations();
  renderBudget();
  element("logisticsAnalysis").hidden = element("logisticsScenarios").hidden = false;
  setStep(3, false);
  save.disabled = saved;
}

form.addEventListener("input", event => {
  if (event.target !== preset && !["start", "end"].includes(event.target.name)) clearResult();
});
form.addEventListener("submit", async event => {
  event.preventDefault();
  if (pending) return;
  const input = shipmentInputs();
  const error = shipmentError(input);
  if (error) return feedback(status, error, true);
  if (!points.start || !points.end || points.start.coordinates.join() === points.end.coordinates.join()) {
    return feedback(status, "Başlangıç ve varış için iki farklı konum seç.", true);
  }
  if (!input.factor || !estimateShipment({ ...input, km: 1 })) {
    return feedback(status, "Bu araç için hesaplanabilir profil bulunamadı.", true);
  }
  clearResult();
  const restrictions = Object.fromEntries(["weight", "height", "width", "length"].filter(name => field(name).value)
    .map(name => [name, field(name).valueAsNumber]));
  const query = new URLSearchParams({ start: points.start.coordinates.join(), end: points.end.coordinates.join(), ...restrictions });
  const [lon, lat] = points.start.coordinates;
  const [endLon, endLat] = points.end.coordinates;
  const approximateKm = 111.2 * Math.hypot(endLat - lat, (endLon - lon) * Math.cos((lat + endLat) * Math.PI / 360));
  if (approximateKm <= 75) query.set("alternatives", "1");
  if (field("manual").checked) {
    const km = field("manualKm").valueAsNumber;
    if (!field("manualKm").validity.valid || !estimateShipment({ ...input, km })) {
      return feedback(status, "Geçerli bir beyan mesafesi gir.", true);
    }
    renderResult([{ profile: "manual", km, minutes: field("manualMinutes").valueAsNumber }], { restrictions: {} }, input);
    return;
  }
  const controller = new AbortController();
  pending = controller;
  calculate.disabled = true;
  feedback(status, "Ağır vasıta güzergâhı hesaplanıyor…");
  try {
    let data;
    try { data = await requestRoutes(query, controller.signal); }
    catch (error) {
      if (!query.has("alternatives") || ![400, 404, 502, 503, 504].includes(error.status)) throw error;
      query.delete("alternatives");
      data = await requestRoutes(query, controller.signal);
    }
    if (pending === controller) {
      renderResult(data.routes, { ...data, restrictions, alternativesRequested: query.has("alternatives") }, input);
      feedback(status, "");
    }
  } catch (error) {
    if (pending === controller) {
      clearResult();
      feedback(status, (error.name === "TimeoutError" ? "Rota isteği zaman aşımına uğradı." : error.message) +
        " İstersen bilinen mesafeyi beyan edebilirsin.", true);
    }
  } finally {
    if (pending === controller) {
      pending = null;
      calculate.disabled = false;
    }
  }
});

async function requestRoutes(query, signal) {
  const response = await fetch("/api/logistics/route?" + query, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000)
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || "Ağır vasıta rotası alınamadı."), { status: response.status });
  if (!Array.isArray(data.routes) || !data.routes.length || !data.routes.every(validHgvRoute)) throw new Error("Geçersiz rota yanıtı.");
  return data;
}

function comparisonMetadata(base, alternative, applied, id = crypto.randomUUID()) {
  return {
    referenceId: id + ":reference", alternativeId: id + ":" + alternative.id,
    model: LOGISTICS_MODEL, sources: [...new Set([base.factor.source, alternative.factor.source,
      alternative.input?.evidence, alternative.route?.profile === "driving-hgv" && "OpenRouteService driving-hgv"].filter(Boolean))],
    baselineEmission: base.emission, alternativeEmission: alternative.emission,
    baselineFactor: base.factor, alternativeFactor: alternative.factor,
    load: base.load, baselineKm: base.km, alternativeKm: alternative.km,
    difference: alternative.difference, percent: alternative.percent, applied,
    comparedAt: new Date().toISOString(), verification: alternative.quality, title: alternative.title
  };
}

function renderRecommendations() {
  const cards = element("logisticsRecommendations");
  cards.replaceChildren();
  if (!result) return;
  const candidates = shownRoutes.slice(1).map((route, index) => ({
    id: "road-" + (index + 1),
    title: "Güzergâh alternatifi " + (index + 1),
    message: number(route.km) + " km · " + number(route.minutes) + " dk · ORS ağır vasıta profili, aynı araç ve yük.",
    route, input: shownInput, response: shownResponse, actionable: true,
    quality: "ORS HGV geometrisi · saha uygunluğu ayrıca doğrulanır"
  }));
  candidates.push(...screeningScenarios(result).filter(item => item.id !== "fleet-" + vehicleComparison?.input.vehicle));
  if (vehicleComparison) candidates.push(vehicleComparison);
  if (efficiencyComparison) candidates.push(efficiencyComparison);
  const comparisons = [];
  for (const candidate of candidates) {
    if (!candidate.input) {
      comparisons.push(candidate);
      continue;
    }
    const route = candidate.route ?? shownRoutes[0];
    const estimate = estimateShipment({ ...candidate.input, km: route.km });
    const delta = compareEstimates(result, estimate && { ...estimate, factor: candidate.input.factor });
    if (delta) comparisons.push({ ...candidate, route, response: candidate.response ?? shownResponse, estimate, ...delta });
  }
  const best = comparisons.filter(item => item.difference > 0)
    .sort((a, b) => Number(!!b.actionable) - Number(!!a.actionable) || b.difference - a.difference)[0];
  element("logisticsBest").textContent = best
    ? kg(best.difference) + " · " + best.title : "Pozitif karşılaştırılabilir fark bulunamadı";
  if (!result.comparison?.applied) result.comparison = best
    ? comparisonMetadata(result, { ...best, ...best.estimate, factor: best.input.factor }, false) : undefined;
  const placeholder = (title, message) => comparisons.push({ title, message });
  if (shownRoutes.length < 2 && result.profile !== "manual") {
    placeholder("Güzergâh", shownResponse.alternativesRequested
      ? "ORS bu istek için ikinci bir ağır vasıta yolu döndürmedi."
      : "Bu hesaplamada ana ağır vasıta güzergâhı kullanıldı. Araç ve tüketim senaryoları değerlendirildi.");
  }
  if (!efficiencyComparison) placeholder("Belgeli tüketim", "Aynı araç, yakıt, yük ve güzergâh için ölçülen alternatif tüketimi ve kaynağını gir.");
  if (best) comparisons.splice(0, 0, ...comparisons.splice(comparisons.indexOf(best), 1));
  for (const item of comparisons) {
    const card = document.createElement("article");
    card.className = "logistics-suggestion";
    const title = document.createElement("h3");
    title.textContent = item.title;
    const body = document.createElement("p");
    body.textContent = item.message;
    card.append(title, body);
    if (item.estimate) {
      const quality = document.createElement("p");
      quality.className = "logistics-note";
      quality.textContent = item.quality + " · " + item.input.factor.label + " · " + item.input.factor.value + " " + item.input.factor.unit +
        " · " + item.input.factor.boundary + " · DESNZ " + item.input.factor.year +
        (item.input.factor.method === "fuel" ? " · " + number(item.input.consumption) + " L/100 km" : "");
      card.append(quality);
      const detail = document.createElement("p");
      const change = item.difference > 0 ? "Potansiyel azaltım " : item.difference < 0 ? "Tahmini artış " : "Fark ";
      detail.textContent = "Mevcut " + kg(result.emission) + " · Alternatif " + kg(item.estimate.emission) +
        " · " + change + kg(Math.abs(item.difference)) + (item.percent === null ? "." : " (%" + number(Math.abs(item.percent)) + ").");
      card.append(detail);
      if (item.difference > 0) {
        const impact = document.createElement("p");
        const position = budgetPosition(readBudget(), readHistory()?.shipments ?? []);
        const projection = position.projected + (saved ? 0 : result.emission);
        impact.textContent = result.shipmentStatus === "planned"
          ? "Aylık projeksiyon " + kg(projection) + " → " + kg(projection - item.difference) +
            " · Olası düşüş " + kg(item.difference) + "."
          : "Gelecek benzer sevkiyatlarda " + kg(item.difference) + " potansiyel azaltım.";
        card.append(impact);
      }
      if (item.actionable && result.shipmentStatus === "planned") {
        const apply = document.createElement("button");
        apply.type = "button";
        apply.className = "route-secondary";
        apply.textContent = "Alternatifi plana uygula";
        apply.addEventListener("click", () => {
          const previous = result.reference ?? Object.fromEntries(["emission", "km", "vehicle", "factor", "load", "capacity", "fuel",
            "consumption", "evidence", "profile", "restrictions", "routeFetchedAt"].map(key => [key, result[key]]));
          const baseline = { ...previous, load: previous.load ?? result.load };
          const delta = compareEstimates(baseline, { ...item.estimate, factor: item.input.factor });
          if (!delta) return feedback(element("logisticsSaveStatus"), "Referans plan ile alternatif karşılaştırılamadı.", true);
          const comparison = comparisonMetadata(baseline, { ...item, ...item.estimate, ...delta, factor: item.input.factor }, true);
          if (saved) {
            const record = readHistory()?.shipments.find(entry => entry.id === savedId);
            if (record?.shipmentStatus !== "planned") {
              return feedback(element("logisticsSaveStatus"), "Bu kayıt artık değiştirilebilir bir plan değil.", true);
            }
            const updated = { ...record, ...item.input, ...item.estimate, reference: previous, comparison,
              id: savedId, createdAt: record.createdAt, shipmentStatus: "planned", realizedAt: null,
              minutes: item.route.minutes, profile: item.route.profile, routeFetchedAt: item.response.fetchedAt,
              routeStatus: item.route.profile === "manual" ? record.routeStatus : "ORS driving-hgv · güncellenen plan", restrictions: item.response.restrictions };
            if (!updateHistory(entries => entries.map(entry => entry.id === savedId ? updated : entry))) {
              return feedback(element("logisticsSaveStatus"), "Alternatif plan kaydedilemedi.", true);
            }
          }
          field("vehicle").value = item.input.vehicle;
          field("capacity").value = item.input.capacity;
          field("fuel").value = item.input.evidence ? item.input.fuel : "";
          field("consumption").value = item.input.consumption ?? "";
          field("evidence").value = item.input.evidence ?? "";
          for (const name of ["weight", "height", "width", "length"]) field(name).value = item.response.restrictions[name] ?? "";
          vehicleComparison = null;
          efficiencyComparison = null;
          renderResult([item.route], item.response, item.input, previous, comparison);
          feedback(element("logisticsSaveStatus"), saved ? "Kayıtlı plan güncellendi." : "Alternatif taslağa uygulandı.");
        });
        card.append(apply);
      }
    }
    cards.append(card);
  }
}

scenario.addEventListener("submit", async event => {
  event.preventDefault();
  const snapshot = result;
  if (!snapshot) return;
  const vehicle = scenario.elements.vehicle.value;
  const input = { ...snapshot, ...automaticProfile(vehicle), vehicle, capacity: scenario.elements.capacity.valueAsNumber,
    gross: scenario.elements.weight.valueAsNumber };
  const target = element("logisticsScenarioStatus");
  const error = shipmentError(input);
  if (error || vehicle === snapshot.vehicle) return feedback(target, error || "Farklı bir araç sınıfı seç.", true);
  if (input.gross - input.load + input.capacity > classes[vehicle].max + 1e-9) {
    return feedback(target, "Beyan edilen kapasite ve boş araç ağırlığı bu sınıfın azami kütlesini aşıyor.", true);
  }
  const restrictions = Object.fromEntries(["weight", "height", "width", "length"]
    .map(name => [name, scenario.elements.namedItem(name).valueAsNumber]));
  const query = new URLSearchParams({ start: snapshot.start.coordinates.join(), end: snapshot.end.coordinates.join(), ...restrictions });
  const check = ++vehicleCheck;
  vehicleComparison = null;
  renderRecommendations();
  feedback(target, "Alternatif aracın ağır vasıta rotası kontrol ediliyor…");
  try {
    const response = await requestRoutes(query);
    if (result !== snapshot || check !== vehicleCheck) return;
    vehicleComparison = {
      id: "vehicle-" + vehicle,
      title: "Alternatif araç · " + classes[vehicle].label,
      message: "Beyan edilen kapasite yeterli. ORS, verilen araç ölçüleriyle rota döndürdü. Emisyon UK filo tahminidir.",
      route: response.routes[0], response: { ...response, restrictions }, input, actionable: true,
      quality: "Kapasite kullanıcı belgesine dayalı · verilen ölçülerle ORS HGV"
    };
    renderRecommendations();
    feedback(target, "Alternatif araç karşılaştırıldı.");
  } catch {
    if (result === snapshot && check === vehicleCheck) feedback(target, "Alternatif aracın rotası doğrulanamadı. Tasarruf hesaplanmadı.", true);
  }
});
scenario.addEventListener("input", () => {
  vehicleCheck++;
  vehicleComparison = null;
  if (result) renderRecommendations();
  feedback(element("logisticsScenarioStatus"), "");
});
efficiency.addEventListener("submit", event => {
  event.preventDefault();
  if (!result) return;
  const target = element("logisticsEfficiencyStatus");
  const consumption = efficiency.elements.consumption.valueAsNumber;
  const evidence = efficiency.elements.evidence.value.trim();
  const profile = automaticProfile(result.vehicle, { fuel: result.fuel, consumption, evidence });
  if (profile?.factor.method !== "fuel") return feedback(target, "Geçerli tüketim ve ölçüm kaynağı gir.", true);
  efficiencyComparison = {
    id: "documented-fuel", title: "Belgeli tüketim alternatifi",
    message: "Aynı araç, güzergâh ve yük için beyan edilen kaynak: " + evidence,
    input: { ...shownInput, ...profile }, actionable: true,
    quality: "Kullanıcı belgesine dayalı tüketim · bağımsız doğrulanmadı"
  };
  renderRecommendations();
  feedback(target, "Tüketim karşılaştırıldı.");
});
efficiency.addEventListener("input", () => {
  efficiencyComparison = null;
  if (result) renderRecommendations();
  feedback(element("logisticsEfficiencyStatus"), "");
});
field("manual").addEventListener("change", () => {
  element("logisticsManual").hidden = !field("manual").checked;
  for (const name of ["manualKm", "manualMinutes"]) field(name).disabled = !field("manual").checked;
});
save.addEventListener("click", () => {
  if (!result || saved) return;
  const createdAt = new Date().toISOString();
  const record = { ...result, id: crypto.randomUUID(), createdAt,
    model: LOGISTICS_MODEL, realizedAt: result.shipmentStatus === "realized" ? createdAt : null };
  if (!updateHistory(items => [...items, record])) return feedback(element("logisticsSaveStatus"), "Kayıt yazılamadı.", true);
  saved = true;
  savedId = record.id;
  save.disabled = true;
  renderRecommendations();
  renderBudget();
  feedback(element("logisticsSaveStatus"), "Sevkiyat kaydedildi.");
});

function readBudget() {
  try {
    const budget = JSON.parse(localStorage.getItem(budgetKey));
    return budget?.version === 1 && Number.isFinite(budget.limit) && budget.limit > 0 ? budget.limit : null;
  } catch { return null; }
}

function renderBudget() {
  currentMonth = budgetMonth();
  const shipments = readHistory()?.shipments ?? [];
  const state = budgetPosition(readBudget(), shipments, currentMonth);
  const totals = element("logisticsReductionTotals");
  totals.replaceChildren();
  const reductions = { planned: 0, historic: 0, applied: 0 };
  const counted = new Set();
  for (const item of shipments) {
    if (counted.has(item.id)) continue;
    counted.add(item.id);
    const comparison = item.comparison;
    const difference = comparison?.difference;
    if (!Number.isFinite(difference) || difference <= 0) continue;
    if (item.shipmentStatus === "planned" && !comparison.applied) reductions.planned += difference;
    if (item.shipmentStatus === "realized") reductions[comparison.applied ? "applied" : "historic"] += difference;
  }
  addMetric(totals, "Planlanan sevkiyatlar · potansiyel azaltım", kg(reductions.planned));
  addMetric(totals, "Geçmiş sevkiyat iyileştirme potansiyeli", kg(reductions.historic));
  addMetric(totals, "Uygulanan planın referansa göre tahmini emisyon avantajı", kg(reductions.applied));
  const metrics = element("logisticsBudgetMetrics");
  metrics.replaceChildren();
  const dash = "Henüz belirlenmedi";
  addMetric(metrics, "Aylık bütçe · " + currentMonth, state.limit ? budgetAmount(state.limit) : dash);
  addMetric(metrics, "Bu ay kullanılan", budgetAmount(state.used));
  addMetric(metrics, "Kalan bütçe", state.limit ? budgetAmount(state.remaining) : "—");
  element("logisticsBudgetProjection").textContent = "Planlanan " + budgetAmount(state.planned) +
    " · Aylık projeksiyon " + budgetAmount(state.projected) + (state.excess > 0 ? " · Aşım " + budgetAmount(state.excess) : "");
  const progress = element("logisticsBudgetProgress");
  const track = element("logisticsBudgetTrack");
  track.hidden = !state.limit;
  track.toggleAttribute("data-small-use", state.percent > 0 && state.percent < 0.8);
  progress.value = Math.min(state.percent ?? 0, 100);
  progress.dataset.tone = state.tone ?? "";
  const percent = state.percent ?? 0;
  const percentText = percent > 0 && percent < .001 ? "<%0,001" : "%" + number(percent);
  element("logisticsBudgetPercent").textContent = percentText + " kullanıldı";
  progress.setAttribute("aria-valuetext", percentText + " kullanıldı");
  if (!result) return;
  const metric = element("logisticsMetrics").querySelectorAll("dd")[2];
  if (!metric) return;
  const total = (result.shipmentStatus === "planned" ? state.projected : state.used) + (saved ? 0 : result.emission);
  const title = result.shipmentStatus === "planned" ? "Aylık projeksiyon " : "Aylık kullanım ";
  metric.textContent = title + budgetAmount(total) + (state.limit
    ? total > state.limit ? " · Aşım " + budgetAmount(total - state.limit) : " · Kalan " + budgetAmount(state.limit - total)
    : " · Bütçe henüz belirlenmedi");
}

element("logisticsBudgetForm").addEventListener("submit", event => {
  event.preventDefault();
  const limit = budgetInput.valueAsNumber * (budgetUnit.value === "t" ? 1000 : 1);
  if (!Number.isFinite(limit) || limit <= 0) return feedback(element("logisticsBudgetStatus"), "Pozitif bir bütçe gir.", true);
  try {
    localStorage.setItem(budgetKey, JSON.stringify({ version: 1, limit }));
    renderBudget();
    const editor = element("logisticsBudgetEditor");
    editor.open = false;
    syncBudgetEditor();
    editor.querySelector("summary").focus();
    feedback(element("logisticsBudgetStatus"), "Aylık iç hedef kaydedildi.");
  } catch { feedback(element("logisticsBudgetStatus"), "Bütçe kaydedilemedi.", true); }
});
element("logisticsHistoryFilter").addEventListener("change", renderHistory);
window.addEventListener("storage", event => {
  if (event.key === storageKey || event.key === null) renderHistory();
  if (event.key === budgetKey || event.key === null) syncBudgetEditor();
  if ([storageKey, budgetKey, null].includes(event.key)) renderBudget();
});
function updateBudgetMinimum() { budgetInput.min = budgetUnit.value === "t" ? "0.00001" : "0.01"; }
budgetUnit.addEventListener("change", updateBudgetMinimum);
function syncBudgetEditor() {
  const limit = readBudget();
  budgetUnit.value = limit >= 1000 ? "t" : "kg";
  budgetInput.value = limit === null ? "" : limit / (budgetUnit.value === "t" ? 1000 : 1);
  updateBudgetMinimum();
}
function checkMonth() { if (currentMonth !== budgetMonth()) renderBudget(); }
document.addEventListener("visibilitychange", checkMonth);
setInterval(checkMonth, 60000);
view.addEventListener("logisticsviewshown", () => { showMap(); checkMonth(); });
if (!view.hidden) showMap();
renderHistory();
budgetInput.value = readBudget() ?? "";
renderBudget();
