"use strict";

(() => {
  const element = id => document.getElementById(id);
  const form = element("campusRingForm");
  const field = name => form.elements.namedItem(name);
  const ring = campusRingOption();
  const comparison = element("campusRingComparison");
  const status = element("campusRingStatus");
  const compareButton = element("campusRingCompare");
  const saveButton = element("campusRingSave");
  const planButton = element("campusRingPlan");
  const kg = value => formatEmission(value) + " kg CO₂e";
  let road;
  let request;
  let comparisonError = "";

  function campusesSelected() {
    return field("direction").value === "vadi"
      ? { start: campusRing.end, end: campusRing.start }
      : { start: campusRing.start, end: campusRing.end };
  }

  function carOption() {
    if (!road || !field("carPassengers").validity.valid) return null;
    const passengers = field("carPassengers").valueAsNumber;
    return { km: road.km, passengers, emission: compareRouteEmissions(road.km, null, passengers).car,
      source: "ORS yol ağı", dataStatus: "Canlı ORS" };
  }

  function render() {
    const car = carOption();
    compareButton.disabled = Boolean(request) || !field("carPassengers").validity.valid;
    saveButton.disabled = !ring;
    planButton.disabled = !ring || !car || !field("weekly").validity.valid || typeof regularRoutes === "undefined";
    const difference = ring && car ? car.emission - ring.emission : null;
    element("campusRingDeclare").hidden = !(difference > 0);
    if (!(difference > 0)) field("declared").checked = false;

    const groupAssumption = element("campusRingGroupAssumption");
    groupAssumption.hidden = difference === null;
    if (difference === null) field("groupReference").checked = false;
    element("campusRingGroup").textContent = difference === null
      ? "Hesaplanamadı. Geçerli otomobil referansı gerekli."
      : field("groupReference").checked
        ? describeDifference(difference * ring.passengers)
        : "Tüm yolcular için aynı referansı açıkça seçtiğinde grup farkı gösterilir.";
    const metrics = difference !== null
      ? "Canlı ORS" + (road.cached ? " (en fazla 15 dk önbellek)" : "") + " · Otomobil " + car.km.toLocaleString("tr-TR", { maximumFractionDigits: 2 }) +
        " km · " + kg(car.emission) + " / kişi. " + describeDifference(difference)
      : "Hesaplanamadı. Geçerli otomobil referansı gerekli.";
    showFeedback(comparison, request ? "ORS otomobil güzergâhı hesaplanıyor…" :
      comparisonError ? "Hesaplanamadı. " + comparisonError : metrics, Boolean(comparisonError));
  }

  function describeDifference(difference) {
    if (difference === 0) return "Tahmini emisyon farkı 0,00 kg CO₂e.";
    return (difference > 0 ? "Potansiyel azaltım " : "Tahmini emisyon artışı ") + kg(Math.abs(difference)) + ".";
  }

  async function compare() {
    const direction = campusesSelected();
    if (!direction || request) return;
    const controller = new AbortController();
    request = controller;
    road = null;
    comparisonError = "";
    field("declared").checked = false;
    field("groupReference").checked = false;
    render();
    const query = new URLSearchParams({ start: direction.start.coordinates.join(), end: direction.end.coordinates.join() });
    try {
      const response = await fetch("/api/route/car?" + query, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "ORS otomobil rotası alınamadı.");
      if (data.profile !== "driving-car" || !Number.isFinite(data.km) || data.km <= 0) throw new Error("Geçerli ORS otomobil mesafesi alınamadı.");
      if (request === controller) road = data;
    } catch (error) {
      if (request === controller) comparisonError = error.name === "TimeoutError" ? "ORS otomobil isteği zaman aşımına uğradı."
        : error instanceof TypeError || error instanceof SyntaxError ? "Yerel rota sunucusundan geçerli bir yanıt alınamadı." : error.message;
    } finally {
      if (request === controller) {
        request = null;
        render();
      }
    }
  }

  function save() {
    const direction = campusesSelected();
    if (!direction || !ring) return;
    const car = carOption();
    const declared = field("declared").checked && car && car.emission > ring.emission;
    const trip = {
      id: createTripId(), transport: "ring", distance: ring.km, emission: ring.emission,
      replacedCar: Boolean(declared), emissionModel: emissionModelFor("ring", ring), createdAt: new Date().toISOString(),
      route: {
        ...direction, passengers: ring.passengers, actualTransport: "ring", vehicleType: ring.vehicleType,
        source: ring.source, dataStatus: ring.dataStatus, assumptionVersion: ring.assumptionVersion,
        emissionFactor: ring.kgPerVehicleKm, emissionFactorUnit: ring.factorUnit,
        referenceMode: car ? "car" : null, referenceKm: car?.km ?? null, referencePassengers: car?.passengers ?? null,
        referenceEmission: car?.emission ?? null, declaredReduction: declared ? car.emission - ring.emission : null
      }
    };
    const history = loadTrips();
    const duplicate = history.some(item => item.transport === "ring" &&
      Math.floor(Date.parse(item.createdAt) / 60000) === Math.floor(Date.parse(trip.createdAt) / 60000) &&
      item.route?.start?.coordinates?.join() === direction.start.coordinates.join() &&
      item.route?.end?.coordinates?.join() === direction.end.coordinates.join());
    if (duplicate) return showFeedback(status, "Bu yönde bu dakika için ring yolculuğu zaten kayıtlı.", true);
    if (!saveTrip(trip)) return showFeedback(status, "Ring yolculuğu kaydedilemedi.", true);
    refreshApp();
    field("declared").checked = false;
    showFeedback(status, "Ring yolculuğu Yolculuklarım geçmişine kaydedildi.");
  }

  form.addEventListener("submit", event => event.preventDefault());
  form.addEventListener("input", event => {
    if (event.target.name === "direction") {
      request?.abort();
      request = null;
      road = null;
      comparisonError = "";
    }
    if (["direction", "carPassengers"].includes(event.target.name)) {
      field("declared").checked = false;
      field("groupReference").checked = false;
    }
    showFeedback(status, "");
    render();
  });
  compareButton.addEventListener("click", compare);
  saveButton.addEventListener("click", save);
  element("campusRingMap").addEventListener("click", () => {
    const direction = campusesSelected();
    if (!direction) return;
    element("akilli-rota").dispatchEvent(new CustomEvent("campusmap", { detail: direction }));
    element("routeStart").focus({ preventScroll: true });
    element("routeMap").scrollIntoView({ block: "center" });
  });
  planButton.addEventListener("click", () => {
    const direction = campusesSelected();
    const car = carOption();
    if (!direction || !ring || !car) return;
    regularRoutes.savePlan({ ...direction, options: {
      car: { ...car, emissionModel: emissionModelFor("car") },
      ring: { ...ring, emissionModel: emissionModelFor("ring", ring) }
    } }, {
      current: "car", alternative: "ring", label: "İSÜ Kampüs Ringi", weekly: field("weekly").valueAsNumber
    }, null, status);
  });
  const assumptions = CAMPUS_RING_ASSUMPTIONS;
  element("campusRingPilotNote").textContent = "Pilot hesaplama: Her ring seferinde " + assumptions.passengers + " öğrenci olduğu varsayılmıştır.";
  element("campusRingPersonal").textContent = ring ? kg(ring.emission) + " / kişi" : "Hesaplanamadı.";
  element("campusRingTotal").textContent = ring ? kg(ring.vehicleEmission) + " / sefer" : "Hesaplanamadı.";
  element("campusRingGroupHeading").textContent = assumptions.passengers + " kişi için varsayımsal karşılaştırma";
  element("campusRingFormula").textContent = assumptions.km + " km pilot mesafe × " + assumptions.kgPerVehicleKm + " " +
    assumptions.factorUnit + " = araç toplamı. Araç toplamı ÷ " + assumptions.passengers +
    " yolcu = kişi başı emisyon. Otomobil için canlı ORS mesafesi × " + routeFactors.car.value.toLocaleString("tr-TR") +
    " " + routeFactors.car.unit + " ÷ otomobildeki kişi sayısı kullanılır.";
  render();
})();

