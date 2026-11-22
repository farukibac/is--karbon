import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { get } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import vm from "node:vm";

const pilot = JSON.parse(await readFile(new URL("./pilot-rail.json", import.meta.url)));
assert.equal(pilot.segments.length, 3);
assert.ok(pilot.km > 15 && pilot.km < 15.2);
assert.deepEqual(pilot.segments[0][0], pilot.start.coordinates);
assert.deepEqual(pilot.segments.at(-1).at(-1), pilot.end.coordinates);
function kmBetween([lon, lat], [nextLon, nextLat]) {
  const radians = Math.PI / 180;
  const h = Math.sin((nextLat - lat) * radians / 2) ** 2 +
    Math.cos(lat * radians) * Math.cos(nextLat * radians) *
    Math.sin((nextLon - lon) * radians / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
let railKm = 0;
for (const segment of pilot.segments) {
  for (const [index, coordinates] of segment.entries()) {
    const [lon, lat] = coordinates;
    assert.ok(lon >= 28.95 && lon <= 29.02 && lat >= 41 && lat <= 41.11);
    if (index === 0) continue;
    const km = kmBetween(segment[index - 1], coordinates);
    assert.ok(km < 0.8, "Unexpected jump inside a rail segment");
    railKm += km;
  }
}
assert.ok(Math.abs(railKm - pilot.km) < 0.01);
assert.ok(kmBetween(pilot.segments[0].at(-1), pilot.segments[1][0]) < 0.01);
const transferGap = kmBetween(pilot.segments[1].at(-1), pilot.segments[2][0]);
assert.ok(transferGap > 0 && transferGap < 0.3, "Seyrantepe transfer must stay separate from rail geometry");
const context = vm.createContext({});
vm.runInContext(await readFile(new URL("./route-config.js", import.meta.url), "utf8"), context);
const carbon = vm.runInContext("compareRouteEmissions", context);
assert.ok(Math.abs(carbon(20, 10, 1).difference - 3) < 1e-9);
assert.ok(Math.abs(carbon(20, 10, 2).car - 1.7) < 1e-9);
assert.ok(carbon(20, 10, 10).difference < 0);
assert.equal(carbon(20, null, 1).percent, null);
for (const km of [0, -1, NaN, Infinity]) assert.equal(carbon(km, null, 1), null);
for (const passengers of [0, -1, 1.5, NaN, Infinity]) assert.equal(carbon(20, null, passengers), null);
assert.equal(carbon(20, -5, 1), null);
assert.equal(carbon(20, 10, 2).rail, 0.4);
assert.equal(vm.runInContext('emissionModelFor("bus").value * 8', context), 0.8);
assert.equal(vm.runInContext('emissionModelFor("walk").value + emissionModelFor("bike").value', context), 0);
assert.equal(vm.runInContext('campusRingOption().vehicleEmission', context), 20);
assert.equal(vm.runInContext('campusRingOption().emission', context), 1);
assert.equal(vm.runInContext('emissionModelFor("car").version', context), "isu-emissions-pilot-v1");

const ringEmission = vm.runInContext("calculateRingEmissions", context);
assert.equal(ringEmission({ km: 20, kgPerVehicleKm: 1, capacity: 20, passengers: 10 }).perPerson, 2);
for (const passengers of [0, 1.5, 21]) {
  assert.equal(ringEmission({ km: 20, kgPerVehicleKm: 1, capacity: 20, passengers }), null);
}
const presets = vm.runInContext("routePresets", context);
assert.deepEqual([...Object.keys(presets)], ["rail", "campuses", "taksim", "kadikoy", "mecidiyekoy", "bakirkoy", "uskudar", "maslak"]);
for (const { start, end } of Object.values(presets)) {
  for (const point of [start, end]) {
    assert.ok(point.label.trim());
    const [lon, lat] = point.coordinates;
    assert.ok(lon >= 27.95 && lon <= 30 && lat >= 40.78 && lat <= 41.62);
  }
  assert.notEqual(start.coordinates.join(), end.coordinates.join());
}
assert.deepEqual([...presets.rail.start.coordinates], pilot.start.coordinates);
assert.deepEqual([...presets.rail.end.coordinates], pilot.end.coordinates);
assert.deepEqual([...presets.taksim.end.coordinates], pilot.start.coordinates);

const upstream = async (url, options) => {
  if (url.pathname.endsWith("/autocomplete")) {
    const query = url.searchParams.get("text");
    if (query === "quota") return new Response(null, { status: 429 });
    assert.equal(options.headers.Authorization, "test-key");
    const point = { geometry: { type: "Point", coordinates: [29.03, 41.03] } };
    return Response.json({ features: query === "unknown" ? [] : [
      { ...point, properties: { label: "Test address, Istanbul", region: "Istanbul", layer: "venue" } },
      { ...point, properties: { label: "District, Istanbul", region: "Istanbul", layer: "locality" } },
      { geometry: { type: "Point", coordinates: [32, 41] }, properties: { label: "Outside", layer: "address" } }
    ] });
  }
  const profile = url.pathname.split("/")[4];
  const summaries = {
    "driving-car": { distance: 20000, duration: 1800 },
    "foot-walking": { distance: 4500, duration: 3000 },
    "cycling-regular": { distance: 6200, duration: 1400 }
  };
  assert.equal(url.pathname, "/openrouteservice/v2/directions/" + profile + "/geojson");
  assert.ok(summaries[profile]);
  assert.equal(options.headers.Authorization, "test-key");
  const { coordinates, options: preferences } = JSON.parse(options.body);
  assert.deepEqual(preferences?.avoid_features, profile === "driving-car" ? undefined : ["ferries"]);
  if (coordinates[0][0] === 29.04) throw Error("offline");
  if (coordinates[0][0] === 29.05) return Response.json({ error: { code: 2010 } }, { status: 400 });
  if (coordinates[0][0] === 29.020906 && profile === "cycling-regular") return new Response(null, { status: 404 });
  if (coordinates[0][0] === 29.06) {
    globalThis.concurrentCalls = (globalThis.concurrentCalls ?? 0) + 1;
    assert.equal(globalThis.concurrentCalls, 1);
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  const geometry = coordinates[0][0] === 29.07 ? [coordinates[0], coordinates[0]] : coordinates;
  return Response.json({ features: [{
    geometry: { type: "LineString", coordinates: geometry },
    properties: { summary: summaries[profile] }
  }] });
};

const children = [];
async function startServer(withKey, render = false) {
  const env = { ...process.env, PORT: "0", RENDER: String(render), ORS_API_KEY: withKey ? "test-key" : "" };
  const mock = "data:text/javascript," + encodeURIComponent(
    'import assert from "node:assert/strict"; globalThis.fetch = ' + upstream.toString() + ";"
  );
  const child = spawn(process.execPath, [...(withKey ? ["--import", mock] : []), "server.mjs"], { env });
  children.push(child);
  const [output] = await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(([code]) => { throw Error("Server exited: " + code); })
  ]);
  const address = output.toString().match(/http:\/\/(?:127\.0\.0\.1|0\.0\.0\.0):\d+/)[0];
  assert.equal(new URL(address).hostname, render ? "0.0.0.0" : "127.0.0.1");
  return address.replace("0.0.0.0", "127.0.0.1");
}

const carPath = (start, end = pilot.end.coordinates, mode = "car") =>
  "/api/route/" + mode + "?" + new URLSearchParams({ start: start.join(), end: end.join() });

async function testBrowser(base, missing, executable, demoUrl) {
  const profile = await mkdtemp(join(tmpdir(), "isu-route-edge-"));
  const edge = spawn(executable, ["--headless=new", "--no-first-run", "--disable-gpu",
    "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"]);
  children.push(edge);
  let socket;
  try {
    let port;
    for (let attempt = 0; attempt < 80 && !port; attempt++) {
      port = await readFile(join(profile, "DevToolsActivePort"), "utf8").then(data => data.split(/\r?\n/)[0]).catch(() => null);
      if (!port) await delay(150);
    }
    assert.ok(port, "Edge debugging port");
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
    socket = new WebSocket(pages.find(page => page.type === "page").webSocketDebuggerUrl);
    await once(socket, "open");
    let sequence = 0;
    const tiles = new Map();
    const requestHeaders = new Map();
    const networkErrors = [];
    const routeRequests = [];
    const routeResponses = new Map();
    const consoleErrors = [];
    socket.addEventListener("message", ({ data }) => {
      const { method, params } = JSON.parse(data);
      if (method === "Network.requestWillBeSent") {
        const url = new URL(params.request.url);
        const mode = url.pathname.match(/^\/api\/route\/(car|walk|bike)$/)?.[1];
        if (mode) routeRequests.push({ id: params.requestId, mode, start: url.searchParams.get("start"), end: url.searchParams.get("end") });
      }
      if (method === "Network.requestWillBeSentExtraInfo") requestHeaders.set(params.requestId, params.headers);
      if (method === "Network.responseReceived") routeResponses.set(params.requestId, params.response.status);
      if (method === "Network.responseReceived" && params.response.url.startsWith("https://tile.openstreetmap.org/")) {
        tiles.set(params.requestId, params.response);
      }
      if (method === "Network.loadingFailed" && !params.canceled) networkErrors.push(params.errorText);
      if (method === "Runtime.exceptionThrown") consoleErrors.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
      if (method === "Runtime.consoleAPICalled" && params.type === "error") {
        consoleErrors.push(params.args.map(arg => arg.value ?? arg.description).join(" "));
      }
    });
    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        function listener(event) {
          const message = JSON.parse(event.data);
          if (message.id !== id) return;
          socket.removeEventListener("message", listener);
          if (message.error) reject(Error(message.error.message));
          else resolve(message.result);
        }
        socket.addEventListener("message", listener);
        socket.send(JSON.stringify({ id, method, params }));
      });
    }
    async function evaluate(expression) {
      const response = await send("Runtime.evaluate", { expression, returnByValue: true });
      if (response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
      return response.result.value;
    }
    async function waitFor(expression) {
      for (let attempt = 0; attempt < 80; attempt++) {
        if (await evaluate(expression)) return;
        await delay(200);
      }
      throw Error("Browser condition failed: " + expression);
    }

    const presetReady = 'document.querySelector("#routePreset")?.options.length === 10';
    async function choosePreset(key) {
      await evaluate(`(() => {
        const select = document.querySelector("#routePreset");
        select.value = ${JSON.stringify(key)};
        select.dispatchEvent(new Event("change"));
      })()`);
    }
    async function assertLabels(key) {
      assert.deepEqual(await evaluate('[document.querySelector("#routeStart").value, document.querySelector("#routeEnd").value]'),
        [presets[key].start.label, presets[key].end.label]);
      assert.equal(await evaluate('document.querySelector("#routePreset").value'), key);
    }
    async function calculateAndCheck(start, end) {
      const before = routeRequests.length;
      await evaluate('document.querySelector("#routeCalculate").click()');
      await waitFor('!document.querySelector("#routeResults").hidden');
      const requests = routeRequests.slice(before).sort((a, b) => a.mode.localeCompare(b.mode));
      assert.deepEqual(requests.map(({ mode, start, end }) => ({ mode, start, end })),
        ["bike", "car", "walk"].map(mode => ({ mode, start: start.join(), end: end.join() })));
      return requests;
    }
    async function calculatePreset(key) {
      await assertLabels(key);
      return calculateAndCheck(presets[key].start.coordinates, presets[key].end.coordinates);
    }

    await send("Page.enable");
    await send("Network.enable");
    await send("Runtime.enable");
    if (demoUrl) {
      await send("Page.navigate", { url: demoUrl + "/#akilli-rota" });
      await waitFor('location.origin === ' + JSON.stringify(demoUrl) + ' && document.querySelector("#routePreset")?.options.length === 10');
      await send("Emulation.setTimezoneOverride", { timezoneId: "America/Los_Angeles" });
      assert.deepEqual(await evaluate(`[
        dateKey(new Date("2026-11-22T20:59:59Z")), dateKey(new Date("2026-11-22T21:00:00Z")),
        getWeekStart(new Date("2026-11-22T20:59:59Z")).toISOString(),
        getWeekStart(new Date("2026-11-22T21:00:00Z")).toISOString(),
        istanbulMinute(new Date("2026-11-22T21:32:00Z")), formatEmission(2.604468)
      ]`), ["2026-11-22", "2026-11-23", "2026-11-15T21:00:00.000Z", "2026-11-22T21:00:00.000Z", "2026-11-23T00:32", "2,60"]);
      await send("Emulation.setTimezoneOverride", { timezoneId: "" });
      console.log("PASS: Istanbul midnight and week boundaries, independent of browser timezone");
      async function checkLive(name, requests) {
        const profiles = { car: "driving-car", walk: "foot-walking", bike: "cycling-regular" };
        const evidence = {};
        for (const { id, mode } of requests) {
          const status = routeResponses.get(id);
          if (name === "uskudar" && mode !== "car" && [404, 504].includes(status)) {
            assert.match(await evaluate(`document.getElementById("${mode}Metrics").textContent`), /rota(?: geometrisi)? bulunamadı|İstanbul sınırlarının dışına|zaman aşımına/);
            evidence[mode] = { status };
            continue;
          }
          assert.equal(status, 200, name + " " + mode);
          const { body } = await send("Network.getResponseBody", { requestId: id });
          const route = JSON.parse(body);
          assert.equal(route.profile, profiles[mode]);
          assert.ok(route.coordinates.length >= 2 && route.km > 0 && route.minutes > 0);
          const metrics = await evaluate(`document.getElementById("${mode}Metrics").textContent`);
          assert.ok(metrics.includes(route.km.toLocaleString("tr-TR", { maximumFractionDigits: 2 }) + " km"), name + " " + mode + " distance");
          assert.ok(metrics.includes(route.minutes.toLocaleString("tr-TR", { maximumFractionDigits: 1 }) + " dk"), name + " " + mode + " duration");
          const emission = (mode === "car" ? route.km * 0.17 : 0);
          assert.ok(metrics.includes(await evaluate(`formatEmission(${emission})`) + " kg CO₂e"), name + " " + mode + " emission");
          evidence[mode] = { status, km: route.km, minutes: route.minutes, emission };
        }
        assert.equal(await evaluate('document.querySelectorAll(".leaflet-marker-icon").length'), 2);
        assert.ok(await evaluate('document.querySelector(`.leaflet-overlay-pane path[stroke="#315f97"]`) !== null'));
        console.log("LIVE EVIDENCE", name, JSON.stringify(evidence));
      }
      await evaluate(`(() => {
        const original = L.Map.prototype.fitBounds;
        L.Map.prototype.fitBounds = function (bounds, options) {
          window.testMap = this;
          return original.call(this, bounds, { ...options, animate: false });
        };
      })()`);
      for (const key of Object.keys(presets)) {
        await choosePreset(key);
        await checkLive(key, await calculatePreset(key));
        const mode = {
          rail: "metro", campuses: "ring", taksim: "car", kadikoy: "bike",
          mecidiyekoy: "bus", bakirkoy: "walk", uskudar: "car", maslak: "bike"
        }[key];
        assert.equal(await evaluate('document.querySelector("#saveSelectedRoute").disabled'), true);
        if (key === "rail") {
          await evaluate('document.querySelector("input[name=routeTransport][value=metro]").focus()');
          await send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
          await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
          assert.equal(await evaluate('document.querySelector("input[name=routeTransport][value=metro]").checked'), true);
        } else {
          await evaluate(`document.querySelector("input[name=routeTransport][value=${mode}]").click()`);
        }
        if (mode === "bus") {
          assert.equal(await evaluate('document.querySelector("#saveSelectedRoute").disabled'), true);
          await evaluate('document.querySelector("#routeBusKm").value = 8; document.querySelector("#routeBusKm").dispatchEvent(new Event("input"))');
          assert.match(await evaluate('document.querySelector("#routeAlternatives").textContent'), /Otomobil/);
        }
        if (mode === "ring") {
          assert.match(await evaluate('document.querySelector("#ringMetrics").textContent'), /1,00 kg CO₂e \/ kişi.*20,00 kg CO₂e \/ sefer/);
        }
        assert.equal(await evaluate('document.querySelector("#saveSelectedRoute").disabled'), false);
        const before = await evaluate('JSON.parse(localStorage.getItem("isuKarbonTripsV1") || "[]").length');
        await evaluate('document.querySelector("#saveSelectedRoute").click(); document.querySelector("#saveSelectedRoute").click()');
        const saved = await evaluate('JSON.parse(localStorage.getItem("isuKarbonTripsV1"))');
        assert.equal(saved.length, before + 1);
        const trip = saved.at(-1);
        assert.equal(trip.transport, mode);
        assert.equal(trip.emissionModel.version, "isu-emissions-pilot-v1");
        assert.equal(trip.route.declaredReduction, null);
        assert.deepEqual(trip.route.start.coordinates, [...presets[key].start.coordinates]);
        assert.deepEqual(trip.route.end.coordinates, [...presets[key].end.coordinates]);
        assert.equal(typeof trip.route.source, "string");
        if (mode === "bus") { assert.equal(trip.distance, 8); assert.equal(trip.emission, 0.8); assert.match(trip.route.dataStatus, /kullanıcı beyanı/); }
        if (mode === "ring") { assert.equal(trip.distance, 20); assert.equal(trip.emission, 1); assert.equal(trip.route.assumptionVersion, "campus-ring-pilot-v1"); }
        if (mode === "bus" || mode === "ring") {
          const toggle = mode === "bus" ? "#showBusRoute" : "#showRingRoute";
          assert.equal(await evaluate(`document.querySelector("${toggle}").disabled`), true);
          await evaluate(`(() => {
            const form = document.querySelector("#regularCreate");
            form.elements.current.value = "car";
            form.elements.alternative.value = ${JSON.stringify(mode)};
            form.requestSubmit();
          })()`);
          const routeCount = mode === "ring" ? 1 : 2;
          await waitFor('document.querySelectorAll(".regular-card").length === ' + routeCount);
          await evaluate(`(() => {
            const form = document.querySelectorAll("[data-form=journey]")[${routeCount - 1}];
            form.elements.trip.value = ${JSON.stringify(trip.id)};
            form.elements.trip.dispatchEvent(new Event("change"));
            form.requestSubmit();
          })()`);
          await waitFor('JSON.parse(localStorage.getItem("isuKarbonRegularRoutesV1")).links.length === ' + routeCount);
          assert.equal(await evaluate('JSON.parse(localStorage.getItem("isuKarbonRegularRoutesV1")).links.at(-1).reduction'), null);
        }
        console.log("LIVE SAVE", key, mode, trip.route.dataStatus);
        if (key === "rail") {
          assert.match(await evaluate('document.querySelector("#railMetrics").textContent'), /15,08 km[\s\S]*0,60 kg CO₂e/);
          assert.equal(await evaluate('document.querySelectorAll(`.leaflet-overlay-pane path[stroke="#16734b"]`).length'), 3);
        }
      }
      await choosePreset("custom");
      for (const [id, lat, lon] of [["pickStart", 40.9925, 29.0212], ["pickEnd", 41.0001, 29.0258]]) {
        const point = await evaluate(`(() => {
          const map = window.testMap;
          const container = map.getContainer();
          container.scrollIntoView({ block: "center", behavior: "instant" });
          map.stop().setView([40.9963, 29.0235], 14, { animate: false });
          document.getElementById(${JSON.stringify(id)}).click();
          const rect = container.getBoundingClientRect();
          const pixel = map.latLngToContainerPoint([${lat}, ${lon}]);
          return { x: rect.left + pixel.x, y: rect.top + pixel.y };
        })()`);
        await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
        await waitFor(id === "pickStart" ? 'Boolean(document.querySelector("#routeStart").value)' : 'Boolean(document.querySelector("#routeEnd").value)');
      }
      const points = await evaluate('["routeStart", "routeEnd"].map(id => document.getElementById(id).value.split(", ").map(Number).reverse())');
      assert.ok(points.every(([lon, lat]) => lon >= 27.95 && lon <= 30 && lat >= 40.78 && lat <= 41.62), JSON.stringify(points));
      assert.notDeepEqual(points[0], points[1]);
      await checkLive("manual", await calculateAndCheck(...points));

      await send("Page.reload");
      await waitFor('!window.testMap && ' + presetReady);
      assert.equal(await evaluate('JSON.parse(localStorage.getItem("isuKarbonTripsV1")).length'), 8);
      await evaluate('location.hash = "yolculuk"');
      await waitFor('!document.querySelector("#yolculuk").hidden');
      assert.match(await evaluate('document.querySelector("#tripList").textContent'), /Otobüs · 8 km.*Tahmini/);
      await evaluate('location.hash = "akilli-rota"');
      await waitFor('!document.querySelector("#akilli-rota").hidden');
      await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await waitFor("innerWidth === 390");
      await choosePreset("rail");
      await checkLive("rail-reload-mobile", await calculatePreset("rail"));
      assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
      await evaluate('location.hash = "kampus-ringleri"');
      await waitFor('document.activeElement.id === "campusRingHeading"');
      async function ringInput(name, value) {
        await evaluate(`(() => {
          const input = document.getElementById("campusRingForm").elements.namedItem(${JSON.stringify(name)});
          if (input.type === "checkbox") input.checked = ${JSON.stringify(value)};
          else input.value = ${JSON.stringify(value)};
          input.dispatchEvent(new Event("input", { bubbles: true }));
        })()`);
      }
      assert.equal(await evaluate('document.querySelector("#campusRingPersonal").textContent'), "1,00 kg CO₂e / kişi");
      assert.equal(await evaluate('document.querySelector("#campusRingTotal").textContent'), "20,00 kg CO₂e / sefer");
      assert.match(await evaluate('document.querySelector("#campusRingPilotNote").textContent'), /20 öğrenci/);
      assert.equal(await evaluate('document.querySelectorAll("#campusRingForm :is([name=vehicle],[name=fuel],[name=km],[name=capacity],[name=factor],[name=source],[name=compatible],[name=passengers]), #ringKm, #ringPassengers, #ringVehicle").length'), 0);
      assert.equal(await evaluate('document.querySelector("#campusRingGroupAssumption").hidden'), true);
      assert.deepEqual(await evaluate('[...document.querySelectorAll("#campusRingForm [name=carPassengers] option")].map(item => item.value)'), ["1", "2", "3", "4"]);
      await ringInput("carPassengers", 2);
      async function compareRing(start, end) {
        const before = routeRequests.length;
        await evaluate('document.querySelector("#campusRingCompare").click()');
        await waitFor('document.querySelector("#campusRingCar").textContent.includes("Canlı ORS")');
        const [item] = routeRequests.slice(before);
        assert.equal(item.start, start.coordinates.join());
        assert.equal(item.end, end.coordinates.join());
        assert.equal(routeResponses.get(item.id), 200);
        const { body } = await send("Network.getResponseBody", { requestId: item.id });
        return JSON.parse(body);
      }
      const forward = await compareRing(presets.campuses.start, presets.campuses.end);
      assert.match(await evaluate('document.querySelector("#campusRingGroup").textContent'), /açıkça seçtiğinde/);
      await ringInput("groupReference", true);
      const groupExpected = await evaluate(`formatEmission(${(forward.km * 0.17 / 2 - 1) * 20})`);
      assert.equal(await evaluate('document.querySelector("#campusRingGroup").textContent'), "Potansiyel azaltım " + groupExpected + " kg CO₂e.");
      await ringInput("carPassengers", 4);
      assert.equal(await evaluate('document.querySelector("#campusRingPersonal").textContent'), "1,00 kg CO₂e / kişi");
      assert.equal(await evaluate('document.querySelector("#campusRingTotal").textContent'), "20,00 kg CO₂e / sefer");
      assert.match(await evaluate('document.querySelector("#campusRingComparison").textContent'), /Tahmini emisyon artışı/);
      assert.doesNotMatch(await evaluate('document.querySelector("#campusRingGroup").textContent'), /kg CO₂e/);
      await ringInput("groupReference", true);
      assert.match(await evaluate('document.querySelector("#campusRingGroup").textContent'), /Tahmini emisyon artışı/);
      assert.equal(await evaluate('document.querySelector("#weeklyReduction").textContent'), "0,00 kg CO₂e");
      assert.equal(await evaluate('document.querySelector("#campusRingDeclare").hidden'), true);
      await ringInput("direction", "vadi");
      assert.equal(await evaluate('document.querySelector("#campusRingPlan").disabled'), true);
      await ringInput("carPassengers", 2);
      await evaluate('window.ringOriginalFetch = window.fetch; window.fetch = () => Promise.reject(new TypeError("Controlled offline error")); document.querySelector("#campusRingCompare").click()');
      await waitFor('document.querySelector("#campusRingCar").textContent.includes("sunucusundan geçerli")');
      await evaluate('window.fetch = window.ringOriginalFetch; delete window.ringOriginalFetch');
      assert.equal(await evaluate('document.querySelector("#campusRingPersonal").textContent'), "1,00 kg CO₂e / kişi");
      assert.equal(await evaluate('document.querySelector("#campusRingSave").disabled'), false);
      assert.equal(await evaluate('document.querySelector("#campusRingGroupAssumption").hidden'), true);
      const reverse = await compareRing(presets.campuses.end, presets.campuses.start);
      const expected = await evaluate(`formatEmission(${reverse.km * 0.17 / 2 - 1})`);
      await evaluate('document.querySelector("#campusRingMap").click()');
      assert.equal(await evaluate('document.querySelectorAll(".leaflet-marker-icon").length'), 2);
      assert.equal(await evaluate('document.querySelector("#showRingRoute").disabled'), true);
      await evaluate('document.querySelector("#campusRingPlan").click()');
      await waitFor('document.querySelectorAll(".regular-card").length === 3');
      assert.match(await evaluate('document.querySelector(".regular-card:last-child [data-field=alternative]").textContent'), /Haftalık ring emisyonu: 5,00/);
      assert.equal(await evaluate('document.querySelector("#weeklyReduction").textContent'), "0,00 kg CO₂e");
      const panelTotals = () => evaluate('["todayEmission", "weeklyEmission", "chartSummary", "totalTrips"].map(id => document.getElementById(id).textContent)');
      const beforeRing = await panelTotals();
      await ringInput("declared", true);
      await evaluate('document.querySelector("#campusRingSave").click(); document.querySelector("#campusRingSave").click()');
      const stored = 'JSON.parse(localStorage.getItem("isuKarbonTripsV1"))';
      const record = await evaluate(stored + '.at(-1)');
      assert.equal(await evaluate(stored + '.length'), 9);
      assert.equal(record.transport, "ring");
      assert.equal(record.emission, 1);
      assert.equal(record.route.fuel, undefined);
      assert.equal(record.route.vehicleType, "Temsili kampüs ringi");
      assert.equal(record.route.assumptionVersion, "campus-ring-pilot-v1");
      assert.equal(record.route.passengers, 20);
      assert.equal(record.distance, 20);
      assert.match(record.route.dataStatus, /Pilot ring/);
      assert.equal(record.route.emissionFactor, 1);
      const added = await panelTotals();
      const shownKg = text => Number(text.match(/\d+,\d+/)?.[0].replace(",", "."));
      for (let i = 0; i < 3; i++) assert.ok(Math.abs(shownKg(added[i]) - shownKg(beforeRing[i]) - 1) < 1e-9);
      assert.equal(added[3], "9");
      assert.equal(await evaluate('document.querySelector("#weeklyReduction").textContent'), expected + " kg CO₂e");
      await evaluate(`(() => {
        const form = document.querySelector(".regular-card:last-child [data-form=journey]");
        form.elements.trip.value = ${JSON.stringify(record.id)};
        form.elements.trip.dispatchEvent(new Event("change"));
        form.elements.declared.checked = true;
        form.requestSubmit();
      })()`);
      await waitFor('JSON.parse(localStorage.getItem("isuKarbonRegularRoutesV1")).links.length === 3');
      assert.equal(await evaluate('document.querySelector("#weeklyReduction").textContent'), expected + " kg CO₂e");
      await evaluate('document.querySelector("#saveGoal").click()');
      assert.match(await evaluate('document.querySelector("#goalStatus").textContent'), new RegExp(expected + " kg CO₂e"));
      await send("Page.reload");
      await waitFor('document.querySelector("#weeklyReduction")?.textContent === ' + JSON.stringify(expected + " kg CO₂e"));
      assert.equal(await evaluate(stored + '.length'), 9);
      assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
      await evaluate('location.hash = "yolculuk"');
      await waitFor('!document.querySelector("#yolculuk").hidden');
      await evaluate('document.querySelector("#tripList .delete-button").click()');
      assert.equal(await evaluate(stored + '.length'), 8);
      assert.deepEqual(await panelTotals(), beforeRing);
      assert.equal(await evaluate('document.querySelector("#weeklyReduction").textContent'), "0,00 kg CO₂e");
      await evaluate('location.hash = "akilli-rota"');
      await waitFor('!document.querySelector("#akilli-rota").hidden');
      await choosePreset("rail");
      await checkLive("rail-after-ring", await calculatePreset("rail"));
      console.log("PASS: fixed campus ring, both directions, group opt-in, negative difference, offline fallback, saving, planning and reduction totals");
      await send("Emulation.clearDeviceMetricsOverride");
      await waitFor('document.querySelector("#railMetrics").textContent.includes("15,08 km")');
      await waitFor('Array.from(document.querySelectorAll(".leaflet-tile-loaded")).some(image => image.naturalWidth > 0)');
      assert.equal(await evaluate('document.querySelectorAll(".leaflet-marker-icon").length'), 2);
      assert.equal(await evaluate('document.querySelectorAll(\'.leaflet-overlay-pane path[stroke="#16734b"]\').length'), 3);
      assert.equal(await evaluate('document.querySelector(\'meta[name="referrer"]\').content'), "strict-origin-when-cross-origin");
      console.log("PASS: served demo, visible Istanbul tiles, both markers and real pilot rail geometry");
    }
    await send("Page.navigate", { url: base + "/#akilli-rota" });
    await waitFor(presetReady);
    assert.equal(await evaluate('document.querySelector("#routePilot") === null'), true);
    await evaluate(`(() => {
      const original = L.Map.prototype.fitBounds;
      L.Map.prototype.fitBounds = function () {
        L.Map.prototype.fitBounds = original;
        throw new Error("Injected map fitting failure");
      };
    })()`);
    await choosePreset("taksim");
    await assertLabels("taksim");
    assert.match(await evaluate('document.querySelector("#routeMapStatus").textContent'), /odaklanamadı/);
    await calculatePreset("taksim");
    await choosePreset("kadikoy");
    await assertLabels("kadikoy");
    await choosePreset("campuses");
    await assertLabels("campuses");
    await choosePreset("rail");
    await calculatePreset("rail");
    await waitFor('!document.querySelector("#routeResults").hidden');
    assert.equal(await evaluate('document.querySelector("#saveSelectedRoute").disabled'), true);
    await evaluate('document.querySelector(`input[name=routeTransport][value=car]`).click()');
    assert.match(await evaluate('document.querySelector("#railMetrics").textContent'), /15,08 km/);
    await evaluate('document.querySelector("#routeFrequency").value = 2; document.querySelector("#routeFrequency").dispatchEvent(new Event("input"))');
    assert.match(await evaluate('document.querySelector("#routeProjection").textContent'), /haftada 2 yolculukta 6,80/);
    const pilotColors = await evaluate('Array.from(document.querySelectorAll(".leaflet-overlay-pane path"), path => path.getAttribute("stroke"))');
    assert.ok(["#315f97", "#16734b", "#8745a3", "#a34d00"].every(color => pilotColors.includes(color)));
    assert.match(await evaluate('document.querySelector("#walkMetrics").textContent'), /4,5 km/);
    assert.match(await evaluate('document.querySelector("#bikeMetrics").textContent'), /6,2 km/);
    await evaluate('document.querySelector("#showWalkRoute").click()');
    assert.equal(await evaluate('document.querySelectorAll(`.leaflet-overlay-pane path[stroke="#8745a3"]`).length'), 0);
    await evaluate('document.querySelector("#showWalkRoute").click()');
    await evaluate('document.querySelector("#showRailRoute").click()');
    assert.equal(await evaluate('document.querySelectorAll(\'.leaflet-overlay-pane path[stroke="#16734b"]\').length'), 0);
    await evaluate('document.querySelector("#showRailRoute").click()');
    await evaluate('document.querySelector("#saveSelectedRoute").click()');
    let records = await evaluate('JSON.parse(localStorage.getItem("isuKarbonTripsV1"))');
    assert.equal(records[0].route.declaredReduction, null);
    assert.deepEqual(records[0].route.start.coordinates, pilot.start.coordinates);
    assert.deepEqual(records[0].route.end.coordinates, pilot.end.coordinates);

    await evaluate('document.querySelector("#routeCalculate").click()');
    await waitFor('!document.querySelector("#routeResults").hidden');
    await evaluate('document.querySelector(`input[name=routeTransport][value=car]`).click()');
    await evaluate('document.querySelector("#routePassengers").value = 10; document.querySelector("#routePassengers").dispatchEvent(new Event("input"))');
    assert.match(await evaluate('document.querySelector("#routeAlternatives").textContent'), /artışı 0,26/);
    await evaluate('document.querySelector("#routePassengers").value = 1; document.querySelector("#routePassengers").dispatchEvent(new Event("input")); document.querySelector(`input[name=routeTransport][value=metro]`).click(); document.querySelector("#routeConfirm").click(); document.querySelector("#saveSelectedRoute").click()');
    records = await evaluate('JSON.parse(localStorage.getItem("isuKarbonTripsV1"))');
    assert.equal(records[1].transport, "metro");
    assert.ok(records[1].route.declaredReduction > 0);

    await evaluate('document.querySelector(".header nav a[href=\'#panel\']").click()');
    await waitFor('!document.querySelector("#panel").hidden && document.activeElement.tagName === "H1"');
    await evaluate('document.querySelector("#saveGoal").click()');
    assert.match(await evaluate('document.querySelector("#goalStatus").textContent'), /1\/2/);
    assert.equal(await evaluate('document.querySelectorAll("#weeklyChart .chart-column").length'), 7);
    assert.match(await evaluate('document.querySelector("#chartSummary").textContent'), /4,00/);
    assert.equal(await evaluate('document.querySelectorAll("#recentTrips .trip").length'), 2);
    await evaluate('document.querySelector(".section-heading a").click()');
    await waitFor('!document.querySelector("#yolculuk").hidden && document.querySelector("#panel").hidden');
    await evaluate('document.querySelector("#distance").value = 10; document.querySelector("#distance").dispatchEvent(new Event("input")); document.querySelector("#compareButton").click()');
    assert.match(await evaluate('document.querySelector("#tripEstimate").textContent'), /1,70/);
    assert.match(await evaluate('document.querySelector("#comparisonResult").textContent'), /0,70/);
    assert.equal(await evaluate('JSON.parse(localStorage.getItem("isuKarbonTripsV1")).length'), 2);
    await evaluate('document.querySelector("#tripForm").requestSubmit()');
    records = await evaluate('JSON.parse(localStorage.getItem("isuKarbonTripsV1"))');
    assert.equal(records.length, 3);
    assert.equal(records[2].transport, "car");
    assert.equal(records[2].replacedCar, false);
    await send("Page.reload");
    await waitFor('document.querySelectorAll("#tripList .trip").length === 3');
    assert.equal(await evaluate('JSON.parse(localStorage.getItem("isuKarbonGoalV1"))'), 2);
    await evaluate('document.querySelector(".delete-button").click()');
    assert.equal(await evaluate('JSON.parse(localStorage.getItem("isuKarbonTripsV1")).length'), 2);
    await evaluate('location.hash = "akilli-rota"');
    await waitFor('!document.querySelector("#akilli-rota").hidden && document.querySelector("#routePreset").options.length === 10');
    await choosePreset("taksim");
    const unchangedStart = presets.taksim.start;
    const beforeEdit = routeRequests.length;
    await evaluate('document.querySelector("#routeEnd").value = "Test address"; document.querySelector("#routeEnd").dispatchEvent(new Event("input")); document.querySelector("#routeCalculate").click()');
    assert.match(await evaluate('document.querySelector("#routeStatus").textContent'), /kesin bir nokta seç/);
    assert.equal(routeRequests.length, beforeEdit);
    assert.equal(await evaluate('document.querySelector("#routeStart").value'), unchangedStart.label);
    await waitFor('document.querySelector("#routeEndResults").options.length === 2');
    await evaluate('document.querySelector("#routeEndResults").selectedIndex = 1; document.querySelector("#routeEndResults").dispatchEvent(new Event("change"))');
    await calculateAndCheck(unchangedStart.coordinates, [29.03, 41.03]);
    assert.match(await evaluate('document.querySelector("#railMetrics").textContent'), /doğrulanmış toplu taşıma alternatifi/);

    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await waitFor("innerWidth === 390");
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
    const map = await evaluate('typeof L !== "undefined" && document.querySelector("#routeMap").classList.contains("leaflet-container")');
    if (map) {
      assert.ok(await evaluate('document.querySelectorAll(".leaflet-marker-icon").length === 2'));
      assert.ok(await evaluate('document.querySelector(".leaflet-overlay-pane path")'));
      await evaluate('document.querySelector("#showCarRoute").click()');
      assert.equal(await evaluate('document.querySelector(`.leaflet-overlay-pane path[stroke="#315f97"]`) === null'), true);
    } else {
      assert.match(await evaluate('document.querySelector("#routeMapStatus").textContent'), /Harita y.klenemedi/);
    }
    assert.ok(map, "Leaflet is required to verify manual point selection");
    let manual;
    if (map) {
      await choosePreset("custom");
      assert.deepEqual(await evaluate('[document.querySelector("#routeStart").value, document.querySelector("#routeEnd").value]'), ["", ""]);
      assert.equal(await evaluate('document.querySelectorAll(".leaflet-marker-icon").length'), 0);
      assert.equal(await evaluate('document.querySelector("#routeResults").hidden'), true);
      await evaluate(`(() => {
        const map = document.querySelector("#routeMap");
        const rect = map.getBoundingClientRect();
        for (const [id, offset] of [["pickStart", -22], ["pickEnd", 22]]) {
          document.getElementById(id).click();
          map.dispatchEvent(new MouseEvent("click", {
            bubbles: true, clientX: rect.left + rect.width / 2 + offset, clientY: rect.top + rect.height / 2
          }));
        }
      })()`);
      manual = await evaluate('["routeStart", "routeEnd"].map(id => document.getElementById(id).value.split(", ").map(Number).reverse())');
      assert.notDeepEqual(manual[0], manual[1]);
      await calculateAndCheck(...manual);
      assert.match(await evaluate('document.querySelector("#walkMetrics").textContent'), /4,5 km/);
      const form = 'document.querySelector("#regularCreate")';
      await evaluate(form + '.elements.current.value = "car"; ' + form + '.elements.alternative.value = "bike"; ' + form + '.requestSubmit()');
      const savedRoute = 'JSON.parse(localStorage.getItem("isuKarbonRegularRoutesV1"))?.routes[0]';
      await waitFor('Boolean(' + savedRoute + ')');
      assert.deepEqual(await evaluate(savedRoute + '.start.coordinates'), manual[0]);
      assert.deepEqual(await evaluate(savedRoute + '.end.coordinates'), manual[1]);
      assert.equal(await evaluate(savedRoute + '.options.bike.km'), 6.2);
      await evaluate('window.confirm = () => true; document.querySelector("[data-action=delete]").click()');
      await waitFor('document.querySelectorAll(".regular-card").length === 0');
    }
    for (const preset of ["rail", "campuses", "taksim", "kadikoy"]) {
      await choosePreset(preset);
      assert.equal(await evaluate('document.querySelector("#routeResults").hidden'), true);
      await calculatePreset(preset);
      assert.equal(await evaluate('document.querySelectorAll(".leaflet-marker-icon").length'), 2);
      assert.match(await evaluate('document.querySelector("#railMetrics").textContent'), preset === "rail" ? /15,08 km/ : /doğrulanmış toplu taşıma alternatifi/);
      assert.match(await evaluate('document.querySelector("#walkMetrics").textContent'), /4,5 km/);
      assert.match(await evaluate('document.querySelector("#bikeMetrics").textContent'), preset === "kadikoy" ? /uygun rota bulunamadı/ : /6,2 km/);
      if (preset === "kadikoy") {
        await evaluate('document.querySelector("input[name=routeTransport][value=bike]").click()');
        assert.equal(await evaluate('document.querySelector("#saveSelectedRoute").disabled'), true);
      }
      assert.equal(await evaluate('document.querySelector("#ringCard").hidden'), preset !== "campuses");
      if (preset === "campuses") {
        assert.match(await evaluate('document.querySelector("#ringMetrics").textContent'), /1,00 kg CO₂e \/ kişi.*20,00 kg CO₂e \/ sefer/);
        assert.equal(await evaluate('document.querySelector("#showRingRoute").disabled'), true);
      }
    }
    async function selectRegularPreset(preset) {
      await choosePreset(preset);
      await calculatePreset(preset);
      await waitFor('!document.querySelector("#regularCreate").hidden');
    }
    async function createRegular(label, alternative) {
      await evaluate(`(() => {
        const form = document.querySelector("#regularCreate");
        form.elements.label.value = ${JSON.stringify(label)};
        form.elements.current.value = "car";
        form.elements.alternative.value = ${JSON.stringify(alternative)};
        form.requestSubmit();
      })()`);
    }
    const storedRegular = 'JSON.parse(localStorage.getItem("isuKarbonRegularRoutesV1"))';
    const weeklyReduction = index => 'document.querySelectorAll("[data-field=declared]")[' + index + '].textContent';
    await selectRegularPreset("rail");
    await createRegular("Ev – Okul", "metro");
    await waitFor('document.querySelectorAll(".regular-card").length === 1');
    assert.match(await evaluate('document.querySelector("[data-field=potential]").textContent'), /13,98/);
    assert.deepEqual(await evaluate(storedRegular + ".routes[0].start.coordinates"), pilot.start.coordinates);
    assert.deepEqual(await evaluate(storedRegular + ".routes[0].end.coordinates"), pilot.end.coordinates);
    assert.ok(Math.abs(await evaluate(storedRegular + ".routes[0].options.car.emission") - 3.4) < 1e-9);
    assert.match(await evaluate(weeklyReduction(0)), /0,00/);
    assert.match(await evaluate('document.querySelector("[data-field=alternative]").textContent'), /Pilot ray geometrisi/);
    await createRegular("Tekrar", "metro");
    await waitFor('document.querySelector("#regularCreateStatus").textContent.includes("zaten")');
    assert.equal(await evaluate(storedRegular + ".routes.length"), 1);

    await evaluate(`(() => {
      const form = document.querySelector("[data-form=journey]");
      const existing = JSON.parse(localStorage.getItem("isuKarbonTripsV1")).find(trip => trip.transport === "metro");
      form.elements.trip.value = existing.id;
      form.elements.trip.dispatchEvent(new Event("change"));
      form.elements.declared.checked = true;
      form.requestSubmit();
    })()`);
    await waitFor(storedRegular + '.links.length === 1');
    assert.match(await evaluate(weeklyReduction(0)), /2,80/);
    assert.equal(await evaluate('JSON.parse(localStorage.getItem("isuKarbonTripsV1")).length'), 2);
    assert.equal(await evaluate('document.querySelector("[data-form=journey] [name=trip]").options.length'), 2);

    await selectRegularPreset("taksim");
    await createRegular("İkinci rota", "bike");
    await waitFor('document.querySelectorAll(".regular-card").length === 2');
    await evaluate('document.querySelectorAll("[data-form=journey]")[1].requestSubmit()');
    await waitFor('JSON.parse(localStorage.getItem("isuKarbonTripsV1")).length === 3');
    assert.match(await evaluate(weeklyReduction(1)), /0,00/);
    assert.match(await evaluate('document.querySelectorAll("[data-field=progress]")[1].textContent'), /1 kayıt/);
    await evaluate('document.querySelectorAll("[data-form=journey]")[1].requestSubmit()');
    await waitFor('document.querySelector("#regularStatus").textContent.includes("eşleşen bir kayıt")');
    assert.equal(await evaluate('JSON.parse(localStorage.getItem("isuKarbonTripsV1")).length'), 3);
    await evaluate(`(() => {
      const form = document.querySelectorAll("[data-form=journey]")[1];
      const lastWeek = new Date();
      lastWeek.setDate(lastWeek.getDate() - 7);
      form.elements.when.value = dateKey(lastWeek) + "T12:00";
      form.elements.declared.checked = true;
      form.requestSubmit();
    })()`);
    await waitFor('JSON.parse(localStorage.getItem("isuKarbonTripsV1")).length === 4');
    assert.match(await evaluate(weeklyReduction(1)), /0,00/);
    assert.match(await evaluate('document.querySelectorAll("[data-field=total]")[1].textContent'), /2 kayıt.*3,40/);

    await evaluate(`(() => {
      const form = document.querySelector("[data-form=edit]");
      form.elements.label.value = "Güncellenen rota";
      form.elements.weekly.value = 7;
      form.elements.current.value = "bike";
      form.requestSubmit();
    })()`);
    await waitFor(storedRegular + '.routes[0].weekly === 7');
    assert.match(await evaluate('document.querySelector("[data-field=potential]").textContent'), /emisyon artışı: 4,22/);
    assert.match(await evaluate(weeklyReduction(0)), /2,80/);
    await send("Page.reload");
    await waitFor('document.querySelectorAll(".regular-card").length === 2');
    assert.match(await evaluate(weeklyReduction(0)), /2,80/);
    assert.equal(await evaluate('document.querySelector("[data-field=title]").textContent'), "Güncellenen rota");
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);

    await evaluate('location.hash = "panel"');
    await waitFor('!document.querySelector("#panel").hidden');
    assert.match(await evaluate('document.querySelector("#regularDashboard").textContent'), /2 kayıt · 12 planlanan/);
    await evaluate(`document.querySelector("a[href='#duzenli-rotalar']").click()`);
    await waitFor('document.activeElement.id === "regularHeading"');
    await evaluate('window.confirm = () => true; document.querySelector(".regular-card [data-action=delete]").click()');
    await waitFor(storedRegular + '.routes.length === 1');
    assert.equal(await evaluate(storedRegular + ".links.length"), 0);
    assert.equal(await evaluate('JSON.parse(localStorage.getItem("isuKarbonTripsV1")).length'), 4);
    await evaluate('location.hash = "yolculuk"');
    await waitFor('!document.querySelector("#yolculuk").hidden');
    await evaluate('Array.from(document.querySelectorAll("#tripList .trip")).find(row => row.textContent.includes("Bisiklet") && row.textContent.includes("Taksim")).querySelector(".delete-button").click()');
    await waitFor('JSON.parse(localStorage.getItem("isuKarbonTripsV1")).length === 3');
    assert.match(await evaluate('document.querySelector("[data-field=total]").textContent'), /1 kayıt/);
    console.log("PASS: regular routes, weekly progress, independent reductions, duplicate protection, history links, persistence and deletion");

    await send("Page.navigate", { url: missing + "/#akilli-rota" });
    await waitFor('location.origin === ' + JSON.stringify(missing) + ' && document.querySelector("#routePreset")?.options.length === 10');
    await choosePreset("rail");
    await calculatePreset("rail");
    await waitFor('document.querySelector("#routeStatus").textContent.includes("henüz yapılandırılmadı")');
    assert.match(await evaluate('document.querySelector("#railMetrics").textContent'), /15,08 km/);
    assert.equal(await evaluate('document.querySelector("#saveSelectedRoute").disabled'), true);
    assert.equal(await evaluate('document.querySelector("#routeImpact").hidden'), true);
    await evaluate('document.querySelector("#campusRingSave").click()');
    const unreferencedRing = await evaluate('JSON.parse(localStorage.getItem("isuKarbonTripsV1"))[0]');
    assert.equal(unreferencedRing.transport, "ring");
    assert.equal(unreferencedRing.replacedCar, false);
    assert.equal(unreferencedRing.route.declaredReduction, null);
    await evaluate(`(() => {
      const records = JSON.parse(localStorage.getItem("isuKarbonTripsV1"));
      records.push({
        id: "legacy-ring", transport: "ring", distance: 18, emission: 2.16,
        replacedCar: false, createdAt: new Date().toISOString(),
        route: { vehicleType: "Minibüs", fuel: "Dizel", passengers: 10, dataStatus: "Pilot ring – kullanıcı beyanı" }
      });
      localStorage.setItem("isuKarbonTripsV1", JSON.stringify(records));
    })()`);
    await send("Page.navigate", { url: missing + "/?legacyRing=1#yolculuk" });
    await waitFor('location.search === "?legacyRing=1" && document.querySelector("#tripList .trip")');
    assert.match(await evaluate('document.querySelector("#tripList").textContent'), /Kampüs ringi · 18 km.*2,16 kg CO₂e/);
    assert.equal(await evaluate('JSON.parse(localStorage.getItem("isuKarbonTripsV1")).find(trip => trip.id === "legacy-ring").route.assumptionVersion'), undefined);
    console.log("PASS: pre-pilot-version ring records retain their original distance and emissions");
    await evaluate('localStorage.setItem("isuKarbonRegularRoutesV1", "broken-json")');
    await send("Page.navigate", { url: missing + "/?brokenRegular=1#akilli-rota" });
    await waitFor('location.search === "?brokenRegular=1" && document.querySelector("#regularList")?.textContent.includes("açılamadı")');
    assert.equal(await evaluate('localStorage.getItem("isuKarbonRegularRoutesV1")'), "broken-json");
    assert.equal(await evaluate('document.querySelector("#totalTrips").textContent'), "2");
    console.log("PASS: corrupt regular storage does not crash or rewrite stored data");
    assert.equal(await evaluate('document.querySelector("#weeklyReduction").textContent'), "0,00 kg CO₂e");
    const interception = await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `const originalFetch = window.fetch;
        window.fetch = (url, ...options) => url === "/pilot-rail.json"
          ? Promise.reject(new Error("Injected pilot dataset failure"))
          : originalFetch(url, ...options);`
    });
    await send("Page.navigate", { url: base + "/?testPilotUnavailable=1#akilli-rota" });
    await waitFor('location.search === "?testPilotUnavailable=1" && ' + presetReady);
    for (const key of ["taksim", "rail"]) {
      await choosePreset(key);
      await calculatePreset(key);
      assert.match(await evaluate('document.querySelector("#carMetrics").textContent'), /20 km/);
      assert.match(await evaluate('document.querySelector("#railMetrics").textContent'), /doğrulanmış toplu taşıma alternatifi/);
    }
    await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: interception.identifier });
    await send("Network.setBlockedURLs", { urls: ["*/regular-routes.js"] });
    await send("Page.navigate", { url: base + "/?testRegularUnavailable=1#akilli-rota" });
    await waitFor('location.search === "?testRegularUnavailable=1" && ' + presetReady);
    assert.match(await evaluate('document.querySelector("#routeStatus").textContent'), /Düzenli Rotalarım dosyası yüklenemedi/);
    await choosePreset("rail");
    await calculatePreset("rail");
    assert.match(await evaluate('document.querySelector("#carMetrics").textContent'), /20 km/);
    assert.equal(await evaluate('document.querySelector("#regularCreate").hidden'), true);
    await send("Network.setBlockedURLs", { urls: [] });
    console.log("PASS: road calculation survives a missing regular routes script");
    await send("Page.navigate", { url: base + "/?testVerifiedBus=1#akilli-rota" });
    await waitFor('location.search === "?testVerifiedBus=1" && ' + presetReady);
    await evaluate(`verifiedBusLines.push({
      verified: true, start: routePresets.rail.start, end: routePresets.rail.end,
      coordinates: [routePresets.rail.start.coordinates, routePresets.rail.end.coordinates],
      km: 17, minutes: 32, source: "Controlled bus fixture"
    })`);
    await choosePreset("rail");
    await calculatePreset("rail");
    await evaluate('document.querySelector("input[name=routeTransport][value=bus]").click()');
    assert.match(await evaluate('document.querySelector("#choiceBus").textContent'), /17 km · 32 dk · 1,70 kg CO₂e/);
    assert.equal(await evaluate('document.querySelector("#routeBusInput").hidden'), true);
    assert.equal(await evaluate('document.querySelector("#showBusRoute").disabled'), false);
    assert.equal(await evaluate('document.querySelector("#saveSelectedRoute").disabled'), false);
    console.log("PASS: verified bus fixture uses its own geometry and distance");
    console.log("PASS: atomic preset updates, both coordinates for each profile, custom map selection, destination edits and unavailable pilot data");
    await delay(1500);
    const tileSummary = new Map();
    for (const [id, response] of tiles) {
      const headers = Object.fromEntries(Object.entries(requestHeaders.get(id) ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
      const cache = Object.entries(response.headers).find(([key]) => key.toLowerCase() === "cache-control")?.[1];
      const report = JSON.stringify({
        status: response.status, referer: headers.referer, requestCache: headers["cache-control"],
        pragma: headers.pragma, responseCache: cache, mime: response.mimeType,
        sampleUrl: response.url
      });
      if (!tileSummary.has(response.status)) tileSummary.set(response.status, report);
    }
    console.log("Tile network:", [...tileSummary.values()], "Network failures:", [...new Set(networkErrors)], "Console errors:", consoleErrors);
    assert.equal(consoleErrors.length, 0);
    if (demoUrl) {
      assert.ok(tiles.size > 0 && [...tiles.values()].every(tile => tile.status < 400));
      assert.ok([...tiles.keys()].some(id => Object.entries(requestHeaders.get(id) ?? {}).some(
        ([key, value]) => key.toLowerCase() === "referer" && value === demoUrl + "/"
      )), "No Istanbul tile request sent the demo origin as Referer");
    }
    console.log("PASS: Edge desktop and 390px, both route colors, missing key with pilot rail, legacy flows and localStorage");
  } finally {
    socket?.close();
    edge.kill();
    await Promise.race([once(edge, "exit").catch(() => {}), delay(2000)]);
    await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

try {
  const missing = await startServer(false);
  assert.equal((await fetch(missing + carPath(pilot.start.coordinates))).status, 503);
  assert.equal((await fetch(missing + "/.env")).status, 404);
  const production = (await startServer(true, true)).replace("127.0.0.1", "localhost");
  const publicHost = "isu-release.example";
  const productionRoute = production + carPath(pilot.start.coordinates);
  const requestOrigin = origin => new Promise((resolve, reject) => {
    get(productionRoute, { headers: { Host: publicHost, Origin: origin } }, response => {
      response.resume();
      resolve(response);
    }).on("error", reject);
  });
  assert.deepEqual(await fetch(production + "/healthz").then(response => response.json()), { status: "ok" });
  const sameOrigin = await requestOrigin("https://" + publicHost);
  assert.equal(sameOrigin.statusCode, 200);
  assert.equal(sameOrigin.headers["access-control-allow-origin"], undefined);
  for (const Origin of ["https://another.example", "http://" + publicHost, "null"]) {
    assert.equal((await requestOrigin(Origin)).statusCode, 403);
  }
  for (const path of ["/.env", "/.env.example", "/.git/config", "/server.mjs"]) {
    assert.equal((await fetch(production + path)).status, 404);
  }
  console.log("PASS: Render binding, health check, host-independent routes, origin restrictions and private files");
  const regularScript = await fetch(missing + "/regular-routes.js");
  assert.equal(regularScript.status, 200);
  assert.equal(regularScript.headers.get("cache-control"), "no-cache");
  assert.equal((await fetch(missing + carPath(pilot.end.coordinates))).status, 400);
  const base = await startServer(true);
  const road = await fetch(base + carPath(pilot.start.coordinates)).then(response => response.json());
  assert.equal(road.km, 20);
  assert.equal(road.minutes, 30);
  const repeated = await fetch(base + carPath(pilot.start.coordinates)).then(response => response.json());
  assert.equal(repeated.cached, true);
  assert.equal(repeated.fetchedAt, road.fetchedAt);
  assert.equal(road.profile, "driving-car");
  const cases = [
    [pilot.start.coordinates, pilot.end.coordinates],
    [presets.campuses.start.coordinates, presets.campuses.end.coordinates],
    [presets.taksim.start.coordinates, pilot.start.coordinates],
    [presets.kadikoy.start.coordinates, presets.kadikoy.end.coordinates],
    [[29.0297, 41.0424], [29.0251, 41.0529]],
    [[28.9864, 41.0369], [28.98675, 41.03705]]
  ];
  for (const [start, end] of cases) {
    for (const [mode, profile, km] of [["car", "driving-car", 20], ["walk", "foot-walking", 4.5], ["bike", "cycling-regular", 6.2]]) {
      const response = await fetch(base + carPath(start, end, mode));
      if (start[0] === 29.020906 && mode === "bike") {
        assert.equal(response.status, 404);
        continue;
      }
      const route = await response.json();
      assert.equal(route.profile, profile);
      assert.equal(route.km, km);
    }
  }
  const duplicate = base + carPath([29.06, 41]);
  const duplicates = await Promise.all([fetch(duplicate), fetch(duplicate)]);
  assert.ok(duplicates.every(response => response.ok));
  assert.equal((await fetch(base + carPath([29.07, 41]))).status, 404);
  for (const mode of ["walk", "bike"]) {
    assert.equal((await fetch(base + carPath([29.04, 41], pilot.end.coordinates, mode))).status, 502);
    assert.equal((await fetch(base + carPath([29.05, 41], pilot.end.coordinates, mode))).status, 404);
  }
  assert.deepEqual(road.coordinates[0], pilot.start.coordinates);
  assert.equal((await fetch(base + carPath([29.04, 41]))).status, 502);
  assert.equal((await fetch(base + carPath([29.05, 41]))).status, 404);
  assert.equal((await fetch(base + "/api/route/search?q=quota")).status, 429);
  assert.deepEqual(await fetch(base + "/api/route/search?q=unknown").then(response => response.json()), []);
  assert.equal((await fetch(base + "/api/route/search?q=Istanbul").then(response => response.json())).length, 1);
  assert.equal((await fetch(base + "/api/route/search?q=Istanbul", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  console.log("PASS: pilot geometry, emissions, local server, validation, missing key, upstream error, quota and place search");
  if (process.argv[2]) await testBrowser(await startServer(true), missing, process.argv[2], process.argv[3]);
} finally {
  children.forEach(child => child.kill());
}
