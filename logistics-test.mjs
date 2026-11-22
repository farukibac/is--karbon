import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { cities, emissionFactors } from "./logistics-config.js";
import { estimateShipment, shipmentError, validHgvRoute, automaticProfile, budgetPosition, budgetMonth, compareEstimates } from "./logistics-emissions.js";

const fixture = { vehicle: "n2", km: 100, load: 5, capacity: 10, fuel: "diesel", consumption: 20,
  factor: { method: "fuel", fuel: "diesel", value: 2 } };
for (const bad of [{ km: 0 }, { km: -1 }, { load: 0 }, { load: -1 }, { load: 11 }, { consumption: 0 },
  { consumption: NaN }, { factor: null }, { fuel: "petrol" }]) assert.equal(estimateShipment({ ...fixture, ...bad }), null);
const fuel = estimateShipment(fixture);
assert.equal(fuel.emission, 40);
assert.equal(fuel.litres, 20);
assert.equal(fuel.tonneKm, 500);
assert.equal(fuel.occupancy, 50);
assert.equal(fuel.intensity, 0.08);
assert.equal(estimateShipment({ ...fixture, factor: { method: "tonne", fuel: "diesel", value: 0.1 } }).emission, 50);
assert.equal(estimateShipment({ ...fixture, factor: { method: "vehicle", fuel: "diesel", value: 0.9 } }).emission, 90);
assert.equal(fuel.emission - estimateShipment({ ...fixture, consumption: 25 }).emission, -10);
assert.ok(shipmentError({ ...fixture, load: 11 }));
assert.ok(shipmentError({ ...fixture, vehicle: "constructor" }));
assert.ok(shipmentError({ ...fixture, vehicle: "n1", capacity: 3.5, load: 1 }));
assert.equal(validHgvRoute({ profile: "driving-hgv", km: 10, minutes: 12, coordinates: [] }), false);
assert.equal(validHgvRoute({ profile: "driving-car", km: 10, minutes: 12, coordinates: [[29, 41], [30, 40]] }), false);
assert.equal(automaticProfile("n1").factor.value, .20905);
assert.equal(automaticProfile("n2").factor.value, .84606);
assert.equal(automaticProfile("n3").factor.method, "tonne");
assert.equal(automaticProfile("n3", { fuel: "diesel", consumption: 28 }).factor.method, "tonne");
assert.equal(automaticProfile("n3", { fuel: "diesel", consumption: 28, evidence: "test" }).factor.method, "fuel");
assert.equal(automaticProfile("constructor"), null);
assert.equal(compareEstimates({ ...fuel, factor: { boundary: "TTW" } }, { ...fuel, factor: { boundary: "WTW" } }), null);
assert.equal(compareEstimates({ ...fuel, factor: emissionFactors.diesel }, { ...fuel, emission: 50, factor: emissionFactors.vehicle }).difference, -10);
assert.equal(compareEstimates({ ...fuel, factor: emissionFactors.diesel },
  { ...fuel, emission: 50, factor: { ...emissionFactors.vehicle, year: 2025 } }), null);
assert.equal(compareEstimates({ ...fuel, emission: 0, factor: emissionFactors.diesel },
  { ...fuel, emission: 50, factor: emissionFactors.diesel }).percent, null);
assert.equal(budgetMonth(new Date("2026-11-30T21:00:00Z")), "2026-12");
assert.equal(budgetMonth(new Date("2026-11-30T20:59:59Z")), "2026-11");
const date = "2026-11-10T10:00:00Z";
const budgetFixture = [
  { id: "old", emission: 13, createdAt: date },
  { id: "a", shipmentStatus: "planned", emission: 50, createdAt: date },
  { id: "b", shipmentStatus: "realized", emission: 80, createdAt: date },
  { id: "b", shipmentStatus: "realized", emission: 80, createdAt: date },
  { id: "c", shipmentStatus: "realized", emission: 40, createdAt: date, realizedAt: "2026-11-30T21:00:00Z" }
];
assert.deepEqual(budgetPosition(100, budgetFixture, "2026-11"), {
  limit: 100, used: 80, planned: 50, projected: 130, remaining: 20, excess: 0, percent: 80, tone: "yellow"
});
assert.equal(budgetPosition(50, budgetFixture, "2026-11").excess, 30);
assert.equal(budgetPosition(80, budgetFixture, "2026-11").tone, "yellow");
assert.equal(budgetPosition(200, budgetFixture, "2026-11").tone, "green");
assert.equal(budgetPosition(0, budgetFixture, "2026-11").limit, null);
assert.equal(budgetPosition(-1, budgetFixture, "2026-11").limit, null);
assert.equal(budgetPosition(100, budgetFixture, "2026-12").used, 40);
console.log("PASS: logistics mathematics, units, invalid inputs, independent methods and missing geometry");

const [executable, base = "http://127.0.0.1:4173"] = process.argv.slice(2);
if (executable) await browser();

async function browser() {
  const profile = await mkdtemp(join(tmpdir(), "isu-logistics-edge-"));
  const edge = spawn(executable, ["--headless=new", "--no-first-run", "--disable-gpu",
    "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"]);
  let socket;
  try {
    let port;
    for (let i = 0; i < 80 && !port; i++) {
      port = await readFile(join(profile, "DevToolsActivePort"), "utf8").then(data => data.split(/\r?\n/)[0]).catch(() => null);
      if (!port) await delay(150);
    }
    assert.ok(port);
    const pages = await fetch("http://127.0.0.1:" + port + "/json/list").then(r => r.json());
    socket = new WebSocket(pages.find(page => page.type === "page").webSocketDebuggerUrl);
    await once(socket, "open");
    let sequence = 0;
    const errors = [];
    const responses = [];
    socket.addEventListener("message", ({ data }) => {
      const { method, params } = JSON.parse(data);
      if (method === "Runtime.exceptionThrown") errors.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
      if (method === "Network.responseReceived" && params.response.url.includes("/api/logistics/route?")) {
        responses.push({ ...params.response, requestId: params.requestId });
      }
    });
    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { socket.removeEventListener("message", listener); reject(Error("CDP timeout: " + method)); }, 15000);
        function listener(event) {
          const message = JSON.parse(event.data);
          if (id !== message.id) return;
          clearTimeout(timer);
          socket.removeEventListener("message", listener);
          if (message.error) reject(Error(message.error.message));
          else resolve(message.result);
        }
        socket.addEventListener("message", listener);
        socket.send(JSON.stringify({ id, method, params }));
      });
    }
    async function evaluate(expression) {
      const output = await send("Runtime.evaluate", { expression, returnByValue: true });
      if (output.exceptionDetails) throw Error(output.exceptionDetails.exception?.description ?? output.exceptionDetails.text);
      return output.result.value;
    }
    async function waitFor(expression) {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(expression)) return;
        await delay(150);
      }
      throw Error("Browser condition failed: " + expression + " " + await evaluate('document.querySelector("#logisticsStatus")?.textContent'));
    }
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Network.enable");
    await send("Page.navigate", { url: base + "/" });
    await waitFor('document.querySelector("#logisticsPreset")?.options.length === 11');
    const carbon = await evaluate('localStorage.getItem("isuKarbonTripsV1")');
    await evaluate('document.querySelector("#moduleLogistics").click()');
    await waitFor('!document.querySelector("#lojistik").hidden && typeof L !== "undefined" && document.querySelector("#logisticsMap").classList.contains("leaflet-container")');
    async function fill(selector, entries) {
      await evaluate(`(() => {
        const form = document.querySelector(${JSON.stringify(selector)});
        for (const [name, value] of Object.entries(${JSON.stringify(entries)})) {
          const field = form.elements.namedItem(name);
          if (field.type === "checkbox") field.checked = value;
          else field.value = value;
          field.dispatchEvent(new Event("input", { bubbles:true }));
          field.dispatchEvent(new Event("change", { bubbles:true }));
        }
      })()`);
    }
    assert.equal(await evaluate('document.querySelector("#logisticsBudgetEditor").open'), false);
    await evaluate('document.querySelector("#logisticsBudgetEditor summary").click()');
    assert.equal(await evaluate('document.querySelector("#logisticsBudgetEditor").open'), true);
    await evaluate('(() => { const input = document.querySelector("#logisticsBudgetInput"); input.value = 0; document.querySelector("#logisticsBudgetForm").requestSubmit(); })()');
    assert.equal(await evaluate('localStorage.getItem("isu-logistics-budget-v1")'), null);
    await evaluate('(() => { const input = document.querySelector("#logisticsBudgetInput"); input.value = 100; document.querySelector("#logisticsBudgetForm").requestSubmit(); })()');
    assert.match(await evaluate('document.querySelector("#logisticsBudgetMetrics").textContent'), /100 kg CO₂e/);
    await fill("#logisticsForm", { start: "istanbul", vehicle: "n3", load: 8, capacity: 20,
      weight: 18, height: 4, length: 12, width: 2.5 });
    const presets = [["istanbul", "ankara"], ["istanbul", "kocaeli"], ["bursa", "ankara"], ["istanbul", "bursa"],
      ...["sivas", "konya", "kayseri", "antalya", "eskisehir", "adana"].map(city => ["istanbul", city])];
    for (const [start, destination] of presets) {
      await evaluate('for (let i=0; i<2; i++) document.querySelector("#logisticsBack:not([hidden])")?.click()');
      const before = responses.length;
      await evaluate(`(() => { const preset=document.querySelector("#logisticsPreset"); preset.value = "${start}:${destination}"; preset.dispatchEvent(new Event("change")); })()`);
      assert.equal(responses.length, before);
      assert.deepEqual(await evaluate('["start","end"].map(name => document.querySelector("#logisticsForm").elements.namedItem(name).value)'), [start, destination]);
      assert.equal(await evaluate('document.querySelectorAll("#logisticsMap .leaflet-marker-icon").length'), 2);
      await evaluate('document.querySelector("#logisticsNext").click()');
      assert.match(await evaluate('document.querySelector(".logistics-steps [aria-current=step]").textContent'), /Araç ve yük/);
      await evaluate('document.querySelector("#logisticsNext").click()');
      assert.match(await evaluate('document.querySelector(".logistics-steps [aria-current=step]").textContent'), /Hesaplama ve sonuç/);
      await evaluate('document.querySelector("#logisticsCalculate").click()');
      await waitFor('!document.querySelector("#logisticsAnalysis").hidden');
      const response = responses.at(-1);
      assert.equal(response.status, 200);
      const query = new URL(response.url).searchParams;
      assert.equal(query.get("start"), cities[start].coordinates.join());
      assert.equal(query.get("end"), cities[destination].coordinates.join());
      assert.equal(query.get("weight"), "18");
      assert.equal(query.has("alternatives"), false);
      const body = JSON.parse((await send("Network.getResponseBody", { requestId: response.requestId })).body);
      const route = body.routes[0];
      assert.equal(body.source, "openrouteservice");
      assert.ok(validHgvRoute(route));
      const close = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < .035;
      assert.ok(close(route.coordinates[0], cities[start].coordinates));
      assert.ok(close(route.coordinates.at(-1), cities[destination].coordinates));
      assert.ok(await evaluate('document.querySelector("#logisticsMap .leaflet-overlay-pane path")'));
      assert.match(await evaluate('document.querySelector("#logisticsRouteStatus").textContent'), /driving-hgv.*dk/);
      console.log("LIVE", start + " → " + destination, response.status, await evaluate('document.querySelector("#logisticsRoads").textContent'));
    }
    await fill("#logisticsScenario", { vehicle: "n1", capacity: 1, weight: 3.5, height: 2.5, length: 6, width: 2 });
    await evaluate('document.querySelector("#logisticsScenario").requestSubmit()');
    assert.match(await evaluate('document.querySelector("#logisticsScenarioStatus").textContent'), /aşıyor/);
    await fill("#logisticsScenario", { vehicle: "n2", capacity: 9, weight: 11, height: 3, length: 8, width: 2.4 });
    await evaluate('document.querySelector("#logisticsScenario").requestSubmit()');
    await waitFor('document.querySelector("#logisticsScenarioStatus").textContent.includes("karşılaştırıldı")');
    assert.match(await evaluate('document.querySelector("#logisticsRecommendations").textContent'), /Alternatif araç.*Tahmini artış/);
    await fill("#logisticsForm", { load: 9 });
    await evaluate('document.querySelector("#logisticsForm").requestSubmit()');
    await waitFor('!document.querySelector("#logisticsAnalysis").hidden');
    assert.match(await evaluate('document.querySelector("#logisticsRecommendations").textContent'), /Araç profili ön değerlendirmesi.*Potansiyel azaltım/);
    await fill("#logisticsScenario", { weight: 11.8 });
    await evaluate('document.querySelector("#logisticsScenario").requestSubmit()');
    await waitFor('document.querySelector("#logisticsScenarioStatus").textContent.includes("karşılaştırıldı")');
    assert.match(await evaluate('document.querySelector("#logisticsBest").textContent'), /Alternatif araç/);
    await evaluate('document.querySelector("#logisticsRecommendations button").click()');
    assert.match(await evaluate('document.querySelector("#logisticsMethod").textContent'), /0.84606/);
    await evaluate('document.querySelector("#logisticsSave").click(); document.querySelector("#logisticsSave").click()');
    const stored = 'JSON.parse(localStorage.getItem("isu-logistics-shipments-v1")).shipments';
    let records = await evaluate(stored);
    assert.equal(records.length, 1);
    assert.equal(records[0].model, "isu-logistics-v2");
    assert.equal(records[0].shipmentStatus, "planned");
    assert.equal(records[0].vehicle, "n2");
    assert.ok(records[0].reference.emission > 0);
    assert.ok(records[0].comparison.difference > 0);
    console.log("LIVE REDUCTION", JSON.stringify({
      referenceKm: records[0].reference.km, alternativeKm: records[0].km,
      base: records[0].reference.emission, alternative: records[0].emission, difference: records[0].comparison.difference,
      percent: records[0].comparison.percent
    }));
    assert.ok(Math.abs(records[0].emission - records[0].km * emissionFactors.vehicle.value) < 1e-8);
    assert.match(await evaluate('document.querySelector("#logisticsBudgetMetrics").textContent'), /Bu ay kullanılan0 kg CO₂e/);
    assert.match(await evaluate('document.querySelector("#logisticsBudgetProjection").textContent'), /Planlanan [1-9]/);
    await evaluate('Array.from(document.querySelectorAll("#logisticsHistory button")).find(button => button.textContent.includes("Gerçekleşti")).click()');
    assert.equal(await evaluate(stored + "[0].shipmentStatus"), "realized");
    assert.deepEqual(await evaluate('[...document.querySelectorAll("#logisticsReductionTotals dd")].map(item => item.textContent)'),
      ["0 kg CO₂e", "0 kg CO₂e", records[0].comparison.difference.toLocaleString("tr-TR", { maximumFractionDigits: 3 }) + " kg CO₂e"]);
    assert.equal(await evaluate('document.querySelector("#logisticsBudgetProgress").dataset.tone'), "red");
    await evaluate('(() => { const unit = document.querySelector("#logisticsBudgetUnit"); unit.value = "t"; const input = document.querySelector("#logisticsBudgetInput"); input.value = 3000; document.querySelector("#logisticsBudgetForm").requestSubmit(); })()');
    assert.match(await evaluate('document.querySelector("#logisticsBudgetMetrics").textContent'), /3.000 ton CO₂e/);
    assert.equal(await evaluate('document.querySelector("#logisticsBudgetTrack").hasAttribute("data-small-use")'), true);
    assert.ok(Math.abs(await evaluate('document.querySelector("#logisticsBudgetProgress").value') - records[0].emission / 3000000 * 100) < 1e-9);
    await evaluate('document.querySelector("#logisticsBudgetUnit").value = "kg"');
    assert.match(await evaluate('document.querySelector("#logisticsBudgetProjection").textContent'), /Planlanan 0 kg CO₂e/);
    await evaluate('(() => {const input = document.querySelector("#logisticsBudgetInput"); input.value = 1200; document.querySelector("#logisticsBudgetForm").requestSubmit();})()');
    assert.equal(await evaluate('document.querySelector("#logisticsBudgetProgress").dataset.tone'), "green");
    await evaluate('window.logisticsTestBeforeReload = true');
    await send("Page.reload");
    await waitFor('!window.logisticsTestBeforeReload && document.querySelector("#logisticsHistory li")');
    assert.equal(await evaluate(stored + ".length"), 1);
    assert.equal(await evaluate('localStorage.getItem("isuKarbonTripsV1")'), carbon);
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await waitFor("innerWidth === 390");
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
    assert.equal(await evaluate('document.querySelector("#logisticsBudgetInput").value'), "1200");
    await evaluate('document.querySelector("#logisticsHistory .delete-button").click()');
    assert.equal(await evaluate(stored + ".length"), 1);
    assert.match(await evaluate('document.querySelector("#logisticsHistory li").textContent'), /sevkiyatı silinsin mi/);
    await evaluate('Array.from(document.querySelectorAll("#logisticsHistory li button")).find(button => button.textContent === "Sevkiyatı sil").click()');
    assert.equal(await evaluate(stored + ".length"), 0);
    await fill("#logisticsForm", { start: "istanbul", end: "bursa", vehicle: "n3", load: 8, capacity: 20,
      manual: true, manualKm: 100, manualMinutes: 90 });
    await evaluate(`(() => {
      const map = document.querySelector("#logisticsMap");
      map.scrollIntoView({ block: "center", behavior: "instant" });
      const rect = map.getBoundingClientRect();
      document.querySelector("#logisticsPickEnd").click();
      map.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    })()`);
    assert.equal(await evaluate('document.querySelector("#logisticsForm").elements.end.value'), "map");
    assert.equal(await evaluate('document.querySelectorAll("#logisticsMap .leaflet-marker-icon").length'), 2);
    const count = responses.length;
    await evaluate('document.querySelector("#logisticsForm").requestSubmit()');
    await waitFor('!document.querySelector("#logisticsAnalysis").hidden');
    assert.equal(responses.length, count);
    assert.match(await evaluate('document.querySelector("#logisticsRouteStatus").textContent'), /HGV doğrulanmadı/);
    assert.equal(await evaluate('document.querySelector("#logisticsMap .leaflet-overlay-pane path") === null'), true);
    await fill("#logisticsForm", { fuel: "diesel", consumption: 28, evidence: "Kontrollü ölçüm belgesi", shipmentStatus: "realized" });
    await evaluate('document.querySelector("#logisticsForm").requestSubmit()');
    await waitFor('!document.querySelector("#logisticsScenarios").hidden');
    assert.match(await evaluate('document.querySelector("#logisticsRecommendations").textContent'), /Varsayımsal verimlilik senaryosu/);
    assert.equal(await evaluate('document.querySelectorAll("#logisticsRecommendations button").length'), 0);
    await evaluate('document.querySelector("#logisticsSave").click()');
    assert.equal(await evaluate(stored + '[0].shipmentStatus'), "realized");
    assert.equal(await evaluate(stored + '[0].factor.method'), "fuel");
    await evaluate('Array.from(document.querySelectorAll("#logisticsHistory summary")).find(item => item.textContent.includes("Karbon azaltımını analiz et")).click()');
    await waitFor('document.querySelector("#logisticsHistory").textContent.includes("Kaçırılan Karbon Azaltım Fırsatı")');
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
    const realizedEmission = await evaluate(stored + '[0].emission');
    await fill("#logisticsEfficiency", { consumption: 25, evidence: "Kontrollü test ölçümü" });
    await evaluate('document.querySelector("#logisticsEfficiency").requestSubmit()');
    assert.match(await evaluate('document.querySelector("#logisticsRecommendations").textContent'), /Belgeli tüketim alternatifi.*25 L\/100 km.*Potansiyel azaltım/);
    assert.equal(await evaluate(stored + '[0].emission'), realizedEmission);
    await fill("#logisticsForm", { manual: false, start: "istanbul", end: "bursa", vehicle: "n1", load: 1,
      capacity: 1.5, fuel: "", consumption: "", evidence: "", shipmentStatus: "planned" });
    await evaluate(`(() => {
      const original = window.fetch;
      window.fetch = (url, options) => String(url).startsWith("/api/logistics/route?")
        ? Promise.resolve(Response.json({ routes: [100, 80].map(km => ({
          profile: "driving-hgv", km, minutes: km,
          coordinates: [[28.9090922, 41.0161952], [29.06, 40.196]]
        })) }))
        : original(url, options);
      document.querySelector("#logisticsForm").requestSubmit();
    })()`);
    await waitFor('document.querySelector("#logisticsRecommendations").textContent.includes("Güzergâh alternatifi")');
    assert.match(await evaluate('document.querySelector("#logisticsMethod").textContent'), /0.20905/);
    assert.match(await evaluate('document.querySelector("#logisticsRecommendations").textContent'), /Potansiyel azaltım 4,181/);
    assert.match(await evaluate('document.querySelector("#logisticsBest").textContent'), /4,181/);
    await evaluate('document.querySelector("#logisticsSave").click()');
    const savedRouteId = await evaluate(stored + ".at(-1).id");
    assert.equal(await evaluate('document.querySelector("#logisticsReductionTotals dd").textContent'), "4,181 kg CO₂e");
    await evaluate('document.querySelector("#logisticsRecommendations button").click()');
    assert.equal(await evaluate(stored + ".length"), 2);
    assert.equal(await evaluate(stored + ".at(-1).id"), savedRouteId);
    assert.equal(await evaluate(stored + '.at(-1).km'), 80);
    assert.equal(await evaluate(stored + '.at(-1).reference.km'), 100);
    await evaluate(`(() => {
      const key = "isu-logistics-shipments-v1";
      const data = JSON.parse(localStorage.getItem(key));
      data.shipments.push({ ...data.shipments[0], id: "legacy", shipmentStatus: undefined,
        realizedAt: undefined, model: "isu-logistics-v1", emission: 12.34, comparison: undefined });
      localStorage.setItem(key, JSON.stringify(data));
    })()`);
    await evaluate('window.legacyProbe = true');
    await send("Page.reload");
    await waitFor('!window.legacyProbe && document.querySelector("#logisticsHistory").textContent.includes("Durumu doğrulanmamış")');
    assert.equal(await evaluate(stored + '.find(item => item.id === "legacy").emission'), 12.34);
    await evaluate('(() => {const filter = document.querySelector("#logisticsHistoryFilter"); filter.value = "unknown"; filter.dispatchEvent(new Event("change"));})()');
    assert.equal(await evaluate('document.querySelectorAll("#logisticsHistory li").length'), 1);
    await evaluate('Array.from(document.querySelectorAll("#logisticsHistory summary")).find(item => item.textContent.includes("Karbon azaltımını analiz et")).click()');
    await waitFor('document.querySelector("#logisticsHistory").textContent.includes("Güncel yöntemle ayrı karşılaştırma")');
    assert.equal(await evaluate(stored + '.find(item => item.id === "legacy").emission'), 12.34);
    await evaluate('document.querySelector("#moduleCarbon").click()');
    await waitFor('!document.querySelector("#panel").hidden');
    await evaluate("history.back()");
    await waitFor('location.hash === "#lojistik" && !document.querySelector("#lojistik").hidden');
    assert.deepEqual(errors, []);
    console.log("PASS: logistics navigation, live routes, scenario, history isolation, reload, deletion and mobile");
  } finally {
    socket?.close();
    const exited = once(edge, "exit").catch(() => {});
    edge.kill();
    await Promise.race([exited, delay(2000)]);
    await rm(profile, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
  }
}
