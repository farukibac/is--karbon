"use strict";

const regularRoutes = (() => {
  const key = "isuKarbonRegularRoutesV1";
  const create = document.getElementById("regularCreate");
  const list = document.getElementById("regularList");
  const status = document.getElementById("regularStatus");
  const template = document.getElementById("regularCardTemplate");
  const dashboard = document.getElementById("regularDashboard");
  const dashboardProgress = document.getElementById("regularDashboardProgress");
  let calculated;

  function load() {
    const empty = { version: 1, routes: [], links: [] };
    let data;
    try {
      const raw = localStorage.getItem(key);
      data = raw === null ? empty : JSON.parse(raw);
    } catch {
      return null;
    }
    const validPoint = point => typeof point?.label === "string" && Array.isArray(point.coordinates) &&
      point.coordinates.length === 2 && point.coordinates.every(Number.isFinite);
    const validRoute = route => typeof route?.id === "string" && typeof route.segmentId === "string" &&
      typeof route.label === "string" && Number.isInteger(route.weekly) && route.weekly >= 1 && route.weekly <= 100 &&
      validPoint(route.start) && validPoint(route.end) && route.options &&
      [route.current, route.alternative].every(mode => typeof mode === "string" && Object.hasOwn(route.options, mode)) &&
      Object.entries(route.options).every(([mode, option]) => Object.hasOwn(transportNames, mode) &&
        Number.isFinite(option?.km) && option.km > 0 && Number.isFinite(option.emission) && option.emission >= 0);
    const validLink = link => typeof link?.tripId === "string" && typeof link.routeId === "string";
    return data?.version === 1 && Array.isArray(data.routes) && data.routes.every(validRoute) &&
      Array.isArray(data.links) && data.links.every(validLink) ? data : null;
  }

  function field(form, name) {
    return form.elements.namedItem(name);
  }

  function kg(value) {
    return formatEmission(value) + " kg CO₂e";
  }

  function direction(route) {
    return route.start.label + " → " + route.end.label;
  }

  function routeName(route) {
    return route.label || direction(route);
  }

  function samePoint(a, b) {
    return a?.coordinates?.length >= 2 && b?.coordinates?.length >= 2 &&
      Math.hypot(a.coordinates[0] - b.coordinates[0], a.coordinates[1] - b.coordinates[1]) <= 0.00045;
  }

  function sameDirection(a, b) {
    return samePoint(a?.start, b?.start) && samePoint(a?.end, b?.end);
  }

  function sameMinute(a, b) {
    return Math.floor(Date.parse(a) / 60000) === Math.floor(Date.parse(b) / 60000);
  }

  function distanceMatches(trip, route) {
    const option = route.options[trip.transport];
    return Boolean(option && Math.abs(trip.distance - option.km) <= Math.max(0.1, option.km * 0.05));
  }

  function canLink(trip, route) {
    return [route.current, route.alternative].includes(trip.transport) &&
      (trip.route?.start && trip.route?.end ? sameDirection(trip.route, route) : distanceMatches(trip, route));
  }

  function hasRecordedOccurrence(trip) {
    const data = load();
    const linked = new Set(data?.links.map(link => link.tripId));
    return loadTrips().some(item => item.route && trip.route &&
      (item.route.regular || linked.has(item.id)) &&
      sameDirection(item.route, trip.route) && sameMinute(item.createdAt, trip.createdAt));
  }

  function assignments(data, history) {
    const routeIds = new Set(data.routes.map(route => route.id));
    const claims = new Map();
    for (const trip of history) {
      if (routeIds.has(trip.route?.regular?.routeId)) claims.set(trip.id, trip.route.regular);
    }
    for (const link of data.links) {
      if (routeIds.has(link.routeId) && !claims.has(link.tripId)) claims.set(link.tripId, link);
    }
    return claims;
  }

  function setModes(form, options, preferredCurrent, preferredAlternative) {
    const keys = Object.keys(options);
    const current = field(form, "current");
    const alternative = field(form, "alternative");
    for (const select of [current, alternative]) {
      select.replaceChildren(...keys.map(mode => new Option(transportNames[mode] + " · " + options[mode].source, mode)));
    }
    current.value = keys.includes(preferredCurrent) ? preferredCurrent : keys[0] ?? "";
    alternative.value = keys.includes(preferredAlternative) && preferredAlternative !== current.value
      ? preferredAlternative : keys.find(mode => mode !== current.value) ?? "";
  }

  function setCalculated(next) {
    const previous = calculated;
    calculated = next && Object.keys(next.options).length >= 2 ? next : null;
    create.hidden = !calculated;
    if (!previous && !calculated) return;
    if (previous && calculated && previous.weekly === calculated.weekly &&
        sameDirection(previous, calculated) && JSON.stringify(previous.options) === JSON.stringify(calculated.options)) return;
    for (const checkbox of list.querySelectorAll('[name="replace"]')) {
      checkbox.parentElement.hidden = !calculated;
      if (checkbox.checked) {
        if (!calculated) checkbox.checked = false;
        checkbox.dispatchEvent(new Event("change"));
      }
    }
    if (!calculated) {
      showFeedback(document.getElementById("regularCreateStatus"), "");
      return;
    }
    document.getElementById("regularCalculated").textContent = direction(calculated);
    if (!previous || previous.weekly !== calculated.weekly) field(create, "weekly").value = calculated.weekly;
    setModes(create, calculated.options, field(create, "current").value, field(create, "alternative").value);
  }

  function write(data) {
    if (!writeStorage(key, data)) {
      showFeedback(status, "Düzenli rota verileri kaydedilemedi.", true);
      return false;
    }
    render();
    document.dispatchEvent(new Event("regularchanged"));
    return true;
  }

  function locked(task) {
    if (!navigator.locks) return task();
    return navigator.locks.request(key, task);
  }

  function savePlan(snapshot, { current, alternative, label, weekly }, existingId, feedback) {
    return locked(() => {
      const data = load();
      if (!data) return showFeedback(feedback, "Bu düzenli rota kayıt sürümü açılamadı.", true);
      const existing = data.routes.find(route => route.id === existingId);
      if (existingId && !existing) return showFeedback(feedback, "Bu rota artık kayıtlı değil.", true);
      if (!Number.isInteger(weekly) || weekly < 1 || weekly > 100) return showFeedback(feedback, "Haftalık 1–100 arası yolculuk gir.", true);
      if (!snapshot?.options[current] || !snapshot.options[alternative] || current === alternative) {
        return showFeedback(feedback, "Mevcut ve alternatif ulaşım için iki farklı tür seç.", true);
      }
      if (data.routes.some(route => route.id !== existingId && sameDirection(route, snapshot))) {
        return showFeedback(feedback, "Bu yöndeki güzergâh zaten düzenli rotalarında. Kayıtlı kartı düzenleyebilirsin.", true);
      }
      const route = {
        id: existing?.id ?? createTripId(),
        segmentId: existing && sameDirection(existing, snapshot) ? existing.segmentId : createTripId(),
        label: label.trim(), weekly,
        start: snapshot.start, end: snapshot.end, options: snapshot.options, current, alternative
      };
      data.routes = existing ? data.routes.map(item => item.id === existing.id ? route : item) : [...data.routes, route];
      if (!write(data)) return;
      showFeedback(feedback, existing ? "Düzenli rota güncellendi." : "Düzenli rota kaydedildi.");
      return true;
    });
  }

  function readPlan(form) {
    return { current: field(form, "current").value, alternative: field(form, "alternative").value,
      label: field(form, "label").value, weekly: field(form, "weekly").valueAsNumber };
  }

  create.addEventListener("submit", async event => {
    event.preventDefault();
    if (await savePlan(calculated, readPlan(create), null, document.getElementById("regularCreateStatus"))) field(create, "label").value = "";
  });

  function makeClaim(route, trip, declared) {
    const comparable = declared && trip.transport === route.alternative && distanceMatches(trip, route);
    const referenceEmission = comparable ? route.options[route.current].emission : null;
    return {
      routeId: route.id, segmentId: route.segmentId,
      referenceMode: comparable ? route.current : null,
      referenceEmission,
      reduction: comparable ? Math.max(0, referenceEmission - trip.emission) : null
    };
  }

  function recordJourney(form, routeId) {
    return locked(() => {
      const data = load();
      const route = data?.routes.find(item => item.id === routeId);
      if (!route) return showFeedback(status, "Rota kaydı bulunamadı.", true);
      const history = loadTrips();
      const tripId = field(form, "trip").value;
      const declared = field(form, "declared").checked;
      if (tripId) {
        const trip = history.find(item => item.id === tripId);
        if (!trip || !canLink(trip, route)) return showFeedback(status, "Bu yolculuk rota ile eşleşmiyor.", true);
        const claims = assignments(data, history);
        if (claims.has(tripId) || history.some(item => claims.get(item.id)?.segmentId === route.segmentId &&
            sameMinute(item.createdAt, trip.createdAt))) {
          return showFeedback(status, "Bu yolculuk zaten bir düzenli rotaya bağlı.", true);
        }
        const claim = makeClaim(route, trip, declared);
        data.links.push({ tripId, ...claim });
        if (!write(data)) return;
        return showFeedback(status, declared && claim.reduction === null
          ? "Yolculuk ilişkilendirildi. Planlanan alternatifle karşılaştırılabilir emisyon verisi bulunamadı."
          : "Geçmişteki yolculuk ilişkilendirildi.");
      }

      const entered = field(form, "when").value;
      const when = new Date(entered ? entered + "+03:00" : NaN);
      if (!Number.isFinite(+when) || when > new Date()) return showFeedback(status, "Geçmişteki bir yolculuk tarihi ve saati seç.", true);
      const createdAt = when.toISOString();
      const transport = field(form, "mode").value;
      const option = route.options[transport];
      if (!option || ![route.current, route.alternative].includes(transport)) return;
      if (history.some(item => sameMinute(item.createdAt, createdAt) &&
          (sameDirection(item.route, route) || (!item.route?.start && item.transport === transport && distanceMatches(item, route))))) {
        return showFeedback(status, "Bu dakika için eşleşen bir kayıt var. Yolculuğu geçmişten seçebilirsin.", true);
      }
      const trip = {
        id: createTripId(), transport, distance: option.km, emission: option.emission, replacedCar: false, createdAt,
        emissionModel: option.emissionModel ?? (option.assumptionVersion ? emissionModelFor(transport, option) : undefined),
        route: { start: route.start, end: route.end, actualTransport: transport, passengers: option.passengers ?? 1,
          source: option.source, dataStatus: option.dataStatus, vehicleType: option.vehicleType,
          fuel: option.fuel, capacity: option.capacity, assumptionVersion: option.assumptionVersion, emissionFactor: option.kgPerVehicleKm, emissionFactorUnit: option.factorUnit }
      };
      trip.route.regular = makeClaim(route, trip, declared);
      if (!saveTrip(trip)) return showFeedback(status, "Yolculuk geçmişe kaydedilemedi.", true);
      refreshApp();
      showFeedback(status, "Yolculuk geçmişe kaydedildi ve düzenli rotaya bağlandı.");
    });
  }

  function renderCard(route, assigned, available, start, now) {
    const card = template.content.firstElementChild.cloneNode(true);
    const get = name => card.querySelector('[data-field="' + name + '"]');
    const current = route.options[route.current];
    const alternative = route.options[route.alternative];
    const weekly = assigned.filter(({ trip, claim }) => claim.segmentId === route.segmentId &&
      new Date(trip.createdAt) >= start && new Date(trip.createdAt) <= now);
    const total = entries => entries.reduce((sum, { claim }) => sum + (claim.reduction ?? 0), 0);
    get("title").textContent = routeName(route);
    get("direction").textContent = route.label ? direction(route) : "";
    get("current").textContent = "Mevcut: " + transportNames[route.current] + " · " + kg(current.emission) + "/kişi · " + current.source;
    get("alternative").textContent = "Alternatif: " + transportNames[route.alternative] + " · " + kg(alternative.emission) + "/kişi · " + alternative.source;
    if (route.options.ring && [route.current, route.alternative].includes("ring")) {
      get("alternative").textContent += " · Haftalık ring emisyonu: " + kg(route.options.ring.emission * route.weekly) + "/kişi";
    }
    const weeklyDifference = (current.emission - alternative.emission) * route.weekly;
    get("potential").textContent = weeklyDifference < 0
      ? "Alternatifin haftalık tahmini emisyon artışı: " + kg(-weeklyDifference)
      : "Haftalık potansiyel azaltım: " + kg(weeklyDifference);
    get("declared").textContent = "Bu hafta kullanıcı beyanına dayalı tahmini azaltım: " + kg(total(weekly));
    get("progress").textContent = "Bu hafta " + weekly.length + " kayıt / " + route.weekly + " planlanan tek yön yolculuk";
    const progress = card.querySelector("progress");
    progress.max = route.weekly;
    progress.value = Math.min(weekly.length, route.weekly);
    get("total").textContent = "Tüm dönem: " + assigned.length + " kayıt · Kullanıcı beyanına dayalı tahmini azaltım: " + kg(total(assigned));
    for (const { trip, claim } of assigned) {
      const entry = document.createElement("li");
      entry.textContent = new Date(trip.createdAt).toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short", timeZone: istanbulZone }) +
        " · " + transportNames[trip.transport] + " · " + (claim.reduction === null
          ? "Azaltım beyanı yok veya referans karşılaştırılamıyor"
          : transportNames[claim.referenceMode] + " referansı (" + kg(claim.referenceEmission) + "/kişi) · " + kg(claim.reduction));
      get("journeys").append(entry);
    }

    const journey = card.querySelector('[data-form="journey"]');
    const history = field(journey, "trip");
    const mode = field(journey, "mode");
    const when = field(journey, "when");
    const declared = field(journey, "declared");
    when.value = istanbulMinute(now);
    mode.add(new Option(transportNames[route.current], route.current));
    mode.add(new Option(transportNames[route.alternative], route.alternative));
    mode.value = route.alternative;
    for (const trip of available.filter(item => canLink(item, route))) {
      history.add(new Option(new Date(trip.createdAt).toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short", timeZone: istanbulZone }) +
        " · " + transportNames[trip.transport] + " · " + trip.distance.toLocaleString("tr-TR") + " km", trip.id));
    }
    function updateJourney() {
      const picked = available.find(item => item.id === history.value);
      mode.disabled = when.disabled = Boolean(picked);
      const canDeclare = picked
        ? picked.transport === route.alternative && distanceMatches(picked, route)
        : mode.value === route.alternative;
      declared.disabled = !canDeclare;
      if (!canDeclare) declared.checked = false;
    }
    history.addEventListener("change", updateJourney);
    mode.addEventListener("change", updateJourney);
    updateJourney();
    journey.addEventListener("submit", event => {
      event.preventDefault();
      recordJourney(journey, route.id);
    });

    const edit = card.querySelector('[data-form="edit"]');
    const replace = field(edit, "replace");
    replace.parentElement.hidden = !calculated;
    field(edit, "label").value = route.label;
    field(edit, "weekly").value = route.weekly;
    setModes(edit, route.options, route.current, route.alternative);
    replace.addEventListener("change", () => {
      setModes(edit, (replace.checked && calculated ? calculated : route).options, field(edit, "current").value, field(edit, "alternative").value);
    });
    edit.addEventListener("submit", event => {
      event.preventDefault();
      savePlan(replace.checked ? calculated : route, readPlan(edit), route.id, status);
    });
    card.querySelector('[data-action="delete"]').addEventListener("click", () => {
      if (!window.confirm("Düzenli rota ve bağlantıları silinsin mi? Yolculuklar geçmişte kalır.")) return;
      locked(() => {
        const data = load();
        if (!data) return showFeedback(status, "Düzenli rota verileri açılamadı.", true);
        data.routes = data.routes.filter(item => item.id !== route.id);
        data.links = data.links.filter(link => link.routeId !== route.id);
        if (write(data)) showFeedback(status, "Düzenli rota silindi. Yolculuk geçmişi korundu.");
      });
    });
    return { card, count: weekly.length };
  }

  function render() {
    const data = load();
    list.replaceChildren();
    dashboardProgress.hidden = !data?.routes.length;
    if (!data?.routes.length) {
      const empty = document.createElement("p");
      empty.textContent = data ? "Bir güzergâh hesaplayıp ilk düzenli rotanı ekleyebilirsin." : "Düzenli rota kayıt sürümü açılamadı.";
      list.append(empty);
      dashboard.textContent = data ? "Henüz düzenli rota hedefi yok." : empty.textContent;
      return;
    }
    const now = new Date();
    const start = getWeekStart(now);
    const history = [...new Map(trips.map(trip => [trip.id, trip])).values()].reverse();
    const claims = assignments(data, history);
    const available = [];
    const byRoute = new Map();
    for (const trip of history) {
      const claim = claims.get(trip.id);
      if (!claim) {
        available.push(trip);
        continue;
      }
      if (!byRoute.has(claim.routeId)) byRoute.set(claim.routeId, []);
      byRoute.get(claim.routeId).push({ trip, claim });
    }
    let planned = 0;
    let done = 0;
    let progress = 0;
    for (const route of data.routes) {
      const { card, count } = renderCard(route, byRoute.get(route.id) ?? [], available, start, now);
      list.append(card);
      planned += route.weekly;
      done += count;
      progress += Math.min(count, route.weekly);
    }
    dashboard.textContent = "Bu hafta " + done + " kayıt · " + planned + " planlanan tek yön yolculuk";
    dashboardProgress.max = planned;
    dashboardProgress.value = progress;
  }

  document.addEventListener("tripsupdated", render);
  window.addEventListener("storage", event => {
    if (event.key !== key && event.key !== null) return;
    render();
    document.dispatchEvent(new Event("regularchanged"));
  });
  render();
  queueMicrotask(() => document.dispatchEvent(new Event("regularchanged")));
  return { setCalculated, hasRecordedOccurrence, savePlan, getClaims: history => {
    const data = load();
    return data ? assignments(data, history) : new Map();
  } };
})();

