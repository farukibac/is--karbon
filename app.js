
"use strict";

// ==========================================
// ISU KARBON - ILK CALISAN PROTOTIP
// ==========================================

const transportNames = {
  car: "Otomobil",
  bus: "Otobüs",
  metro: "Metro / Raylı Sistem",
  walk: "Yürüyüş",
  bike: "Bisiklet",
  ring: "Kampüs ringi"
};

const TRIPS_KEY = "isuKarbonTripsV1";
const GOAL_KEY = "isuKarbonGoalV1";

// ==========================================
// VERI YONETIMI
// ==========================================

function readStorage(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch (error) {
    console.warn("Kayıt okunamadı:", error);
    return fallback;
  }
}

function writeStorage(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
    return true;
  } catch (error) {
    console.warn("Kayıt yapılamadı:", error);
    return false;
  }
}

function loadTrips() {
  const storedTrips = readStorage(TRIPS_KEY, []);
  return Array.isArray(storedTrips)
    ? [...new Map(storedTrips.filter(trip =>
        trip &&
        typeof trip.id === "string" &&
        Object.hasOwn(transportNames, trip.transport) &&
        Number.isFinite(trip.distance) &&
        trip.distance > 0 &&
        Number.isFinite(trip.emission) &&
        trip.emission >= 0 &&
        typeof trip.createdAt === "string" &&
        !Number.isNaN(Date.parse(trip.createdAt))
      ).map(trip => [trip.id, trip])).values()]
    : [];
}

let trips = loadTrips();
let weeklyGoal = readStorage(GOAL_KEY, null);

if (!Number.isInteger(weeklyGoal) ||
    weeklyGoal < 1 ||
    weeklyGoal > 30) {
  weeklyGoal = null;
}

function updateTripStorage(update) {
  try {
    const raw = localStorage.getItem(TRIPS_KEY);
    const records = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(records) || !writeStorage(TRIPS_KEY, update(records))) return false;
    trips = loadTrips();
    return true;
  } catch {
    return false;
  }
}

function saveTrip(trip) {
  return updateTripStorage(records => records.some(item => item?.id === trip.id) ? records : [...records, trip]);
}

function showFeedback(element, message, isError = false) {
  element.textContent = message;
  element.toggleAttribute("data-error", isError);
}

function createTripId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

// ==========================================
// TARIH ISLEMLERI
// ==========================================

const istanbulZone = "Europe/Istanbul";
const istanbulDateTime = new Intl.DateTimeFormat("sv-SE", {
  timeZone: istanbulZone, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});

function istanbulMinute(date) {
  return istanbulDateTime.format(date).replace(" ", "T");
}

function dateKey(date) {
  return istanbulMinute(date).slice(0, 10);
}

function getWeekStart(today) {
  // Türkiye uses UTC+03:00 year-round for the application's reporting period.
  const localDay = new Date(dateKey(today) + "T00:00:00Z");
  const daysSinceMonday = (localDay.getUTCDay() + 6) % 7;
  localDay.setUTCDate(localDay.getUTCDate() - daysSinceMonday);
  return new Date(localDay.toISOString().slice(0, 10) + "T00:00:00+03:00");
}

function getWeeklyTrips(start, now) {
  return trips.filter(trip => {
    const date = new Date(trip.createdAt);
    return date >= start && date <= now;
  });
}

// ==========================================
// KARBON HESAPLAMA MOTORU
// ==========================================

function calculateEmission(transport, distance) {
  if (!Object.hasOwn(factors, transport)) {
    throw new Error("Geçersiz ulaşım aracı.");
  }

  if (!Number.isFinite(distance) || distance <= 0) {
    throw new Error("Mesafe sıfırdan büyük olmalıdır.");
  }

  return distance * factors[transport];
}

function formatEmission(value) {
  return value.toLocaleString("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

// ==========================================
// HTML ELEMANLARI
// ==========================================

const tripForm = document.getElementById("tripForm");
const transportInput = document.getElementById("transport");
const distanceInput = document.getElementById("distance");
const messageElement = document.getElementById("message");
const historyMessage = document.getElementById("historyMessage");
const weeklyChart = document.getElementById("weeklyChart");
const chartSummary = document.getElementById("chartSummary");

const todayElement = document.getElementById("todayEmission");
const weekElement = document.getElementById("weeklyEmission");
const totalTripsElement = document.getElementById("totalTrips");

const tripList = document.getElementById("tripList");
const recentTrips = document.getElementById("recentTrips");
const tripEstimate = document.getElementById("tripEstimate");

const recommendationText =
  document.getElementById("recommendationText");

const potentialSaving =
  document.getElementById("potentialSaving");

const weeklyGoalInput =
  document.getElementById("weeklyGoal");

const saveGoalButton =
  document.getElementById("saveGoal");

const goalStatus =
  document.getElementById("goalStatus");

const goalProgress =
  document.getElementById("goalProgress");
const goalFeedback = document.getElementById("goalFeedback");

const compareTransport =
  document.getElementById("compareTransport");

const compareButton =
  document.getElementById("compareButton");

const comparisonResult =
  document.getElementById("comparisonResult");

// ==========================================
// DAVRANIS DEGISIKLIGI BILDIRIMI
// ==========================================

// Ogrenci daha dusuk emisyonlu bir yolculuk
// yaparken bunun otomobil yerine tercih
// edildigini kendisi beyan edebilir.

const switchLabel = document.createElement("label");
switchLabel.className = "switch-label";

const switchCheckbox = document.createElement("input");
switchCheckbox.type = "checkbox";
switchCheckbox.id = "replacedCarTrip";

const switchDescription = document.createElement("span");
switchDescription.textContent =
  "Bu yolculukta normalde kullanacağım otomobil yerine " +
  "bu ulaşım aracını tercih ettim.";

switchLabel.append(
  switchCheckbox,
  switchDescription
);

const submitButton =
  tripForm.querySelector('button[type="submit"]');

tripForm.insertBefore(switchLabel, submitButton);

function updateSwitchVisibility() {
  const isCar = transportInput.value === "car";

  switchLabel.hidden = isCar;

  if (isCar) {
    switchCheckbox.checked = false;
  }
}

transportInput.addEventListener(
  "change",
  updateSwitchVisibility
);

// ==========================================
// ANA PANEL
// ==========================================

function updateDashboard(today, weeklyTrips) {
  const todayTrips = trips.filter(trip =>
    dateKey(new Date(trip.createdAt)) === today
  );

  const todayEmission = todayTrips.reduce(
    (total, trip) => total + trip.emission,
    0
  );

  const weeklyEmission = weeklyTrips.reduce(
    (total, trip) => total + trip.emission,
    0
  );

  todayElement.textContent =
    `${formatEmission(todayEmission)} kg`;

  weekElement.textContent =
    `${formatEmission(weeklyEmission)} kg`;

  totalTripsElement.textContent =
    trips.length.toString();
}

// ==========================================
// YOLCULUK EKLEME
// ==========================================

tripForm.addEventListener("submit", function(event) {
  event.preventDefault();

  const transport = transportInput.value;
  const distance = distanceInput.valueAsNumber;

  if (
    !Object.hasOwn(factors, transport) ||
    !Number.isFinite(distance) ||
    !distanceInput.validity.valid
  ) {
    showFeedback(messageElement, "0,1 ile 1000 km arasında, 0,1 km adımlı bir mesafe gir.", true);

    return;
  }

  const emission = calculateEmission(
    transport,
    distance
  );

  const replacedCar =
    transport !== "car" &&
    switchCheckbox.checked;

  const trip = {
    id: createTripId(),
    transport: transport,
    distance: distance,
    emission: emission,
    replacedCar: replacedCar,
    emissionModel: emissionModelFor(transport),
    createdAt: new Date().toISOString()
  };

  if (!saveTrip(trip)) {
    showFeedback(messageElement, "Yolculuk tarayıcıya kaydedilemedi. Bilgilerin formda duruyor, tekrar deneyebilirsin.", true);
    return;
  }

  showFeedback(messageElement, "Yolculuğun başarıyla kaydedildi.");
  showFeedback(historyMessage, "");
  tripForm.reset();
  updateTripEstimate();
  updateSwitchVisibility();

  refreshApp();
});

// ==========================================
// YOLCULUK GECMISI
// ==========================================

function renderTrips() {
  tripList.replaceChildren();
  recentTrips.replaceChildren();

  if (trips.length === 0) {
    const empty = document.createElement("p");

    empty.textContent =
      "Henüz kaydedilmiş yolculuk bulunmuyor.";

    tripList.appendChild(empty);
    recentTrips.appendChild(empty.cloneNode(true));
    return;
  }

  const sortedTrips = [...trips].reverse();

  sortedTrips.forEach((trip, index) => {
    const row = document.createElement("div");
    row.className = "trip";

    const details = document.createElement("span");

    const date = new Date(trip.createdAt)
      .toLocaleDateString("tr-TR", { timeZone: istanbulZone });

    details.textContent =
      `${transportNames[trip.transport]} · ` +
      `${trip.distance} km · ${date}` +
      (trip.replacedCar ? " · Otomobil yerine" : "") +
      (trip.route?.dataStatus && trip.route.dataStatus !== "Canlı ORS" ? ` · ${trip.route.dataStatus}` : "") +
      (trip.route?.start?.label && trip.route?.end?.label
        ? ` · ${trip.route.start.label} → ${trip.route.end.label}`
        : "");

    const rightSide = document.createElement("div");
    rightSide.className = "trip-actions";

    const emission = document.createElement("strong");

    emission.textContent =
      `${formatEmission(trip.emission)} kg CO₂e`;

    const deleteButton = document.createElement("button");

    deleteButton.type = "button";
    deleteButton.className = "delete-button";
    deleteButton.textContent = "Sil";

    deleteButton.setAttribute(
      "aria-label",
      "Yolculuğu sil"
    );

    deleteButton.addEventListener("click", () => {
      if (!updateTripStorage(records => records.filter(item => item?.id !== trip.id))) {
        showFeedback(historyMessage, "Yolculuk tarayıcıdan silinemedi. Kayıt geçmişinde duruyor.", true);
        return;
      }

      showFeedback(historyMessage, "Yolculuk silindi.");
      refreshApp();
    });

    rightSide.append(emission, deleteButton);
    row.append(details, rightSide);

    tripList.appendChild(row);
    if (index < 3) {
      const recent = row.cloneNode(true);
      recent.querySelector(".delete-button").remove();
      recentTrips.appendChild(recent);
    }
  });
}

// ==========================================
// SURDURULEBILIR ULASIM ONERILERI
// ==========================================

function updateRecommendation() {
  if (trips.length === 0) {
    recommendationText.textContent =
      "İlk yolculuğunu eklediğinde sana " +
      "daha çevreci ulaşım seçenekleri önereceğiz.";

    potentialSaving.textContent = "";
    return;
  }

  const lastTrip = trips[trips.length - 1];

  // Pratik mesafe varsayımları, rota değerlendirmesi değildir.
  const activeDistanceLimits = { walk: 2, bike: 8 };
  const alternatives = Object.keys(factors)
    .filter(mode =>
      mode !== lastTrip.transport &&
      calculateEmission(mode, lastTrip.distance) < lastTrip.emission &&
      lastTrip.distance <= (activeDistanceLimits[mode] ?? Infinity)
    )
    .sort((a, b) => factors[b] - factors[a]);

  if (alternatives.length === 0) {
    recommendationText.textContent =
      "Son yolculuğun için mesafe varsayımına uyan " +
      "daha düşük emisyonlu bir seçenek bulunmuyor. Rota uygunluğu değerlendirilmedi.";

    potentialSaving.textContent = "";
    return;
  }

  // Once toplu tasimayi onermeye calisiyoruz.
  const preferred = alternatives.find(mode =>
    mode === "bus" || mode === "metro"
  ) || alternatives[0];

  const alternativeEmission =
    lastTrip.distance * factors[preferred];

  const saving =
    lastTrip.emission - alternativeEmission;

  recommendationText.textContent =
    `${lastTrip.distance} km boyunca ` +
    `${transportNames[lastTrip.transport]} yerine ` +
    `${transportNames[preferred]} kullanırsan ` +
    "aynı mesafe varsayımıyla karbon emisyonunu " +
    "azaltabilirsin. Bu öneri varsayımsaldır, rota uygunluğu doğrulanmamıştır.";

  potentialSaving.textContent =
    `Alternatif senaryonun tahmini azaltım potansiyeli: ` +
    `${formatEmission(saving)} kg CO₂e`;

  // Burada gercek tasarruf kaydedilmiyor.
  // Yalnizca alternatif senaryo hesaplanıyor.
}

// ==========================================
// HAFTALIK HEDEF SISTEMI
// ==========================================

saveGoalButton.addEventListener("click", () => {
  const goal = Number(weeklyGoalInput.value);

  if (
    !Number.isInteger(goal) ||
    goal < 1 ||
    goal > 30
  ) {
    showFeedback(goalFeedback, "1 ile 30 arasında tam sayı gir.", true);

    return;
  }

  if (!writeStorage(GOAL_KEY, goal)) {
    showFeedback(goalFeedback, "Hedef tarayıcıya kaydedilemedi. Son kaydedilen hedef geçerli.", true);
    return;
  }

  weeklyGoal = goal;
  showFeedback(goalFeedback, "Haftalık hedef kaydedildi.");
  refreshApp();
});

function weeklyDeclaredReduction(weeklyTrips) {
  const claims = typeof regularRoutes === "undefined" ? new Map() : regularRoutes.getClaims(weeklyTrips);
  return [...new Map(weeklyTrips.map(trip => [trip.id, trip])).values()].reduce((total, trip) => {
    if (trip.replacedCar === true && trip.transport !== "car") {
      const declared = trip.route?.declaredReduction;
      if (Number.isFinite(declared)) return total + Math.max(0, declared);
      // Legacy manual entries declared a solo-car substitution over the same distance.
      if (!trip.route && trip.transport !== "ring") return total + Math.max(0, trip.distance * factors.car - trip.emission);
    }
    const claim = claims.get(trip.id);
    const comparable = claim && Object.hasOwn(transportNames, claim.referenceMode) &&
      Number.isFinite(claim.referenceEmission) && claim.referenceEmission >= 0 && Number.isFinite(claim.reduction);
    return total + (comparable ? Math.max(0, Math.min(claim.reduction, claim.referenceEmission - trip.emission)) : 0);
  }, 0);
}

function updateReductionTotals(weeklyTrips) {
  const reduction = weeklyDeclaredReduction(weeklyTrips);
  document.getElementById("weeklyReduction").textContent = formatEmission(reduction) + " kg CO₂e";
  document.getElementById("weeklyReductionInfo").textContent = reduction > 0
    ? "Bu hafta · Kullanıcı beyanına ve varsayımlara dayalı"
    : "Kullanıcı beyanına ve varsayımlara dayalı · Bu hafta pozitif azaltım yok";
  updateWeeklyGoal(weeklyTrips, reduction);
}

document.addEventListener("regularchanged", () => {
  const now = new Date();
  updateReductionTotals(getWeeklyTrips(getWeekStart(now), now));
});

function updateWeeklyGoal(weeklyTrips, estimatedSaving) {
  if (weeklyGoal === null) {
    goalStatus.textContent =
      "Henüz haftalık hedef belirlemedin.";

    goalProgress.value = 0;
    return;
  }

  const switchedTrips = weeklyTrips
    .filter(trip => trip.transport !== "car" && trip.replacedCar === true);

  const completed = switchedTrips.length;

  const percent = Math.min(
    (completed / weeklyGoal) * 100,
    100
  );

  goalProgress.value = percent;

  goalStatus.textContent =
    `${completed}/${weeklyGoal} ulaşım değişikliği · ` +
    `%${Math.round(percent)} tamamlandı. ` +
    `Bu haftanın kullanıcı beyanına dayalı tahmini azaltımı: ${formatEmission(estimatedSaving)} kg CO₂e.`;

  if (completed >= weeklyGoal) {
    goalStatus.textContent +=
      " Tebrikler, haftalık hedefini tamamladın!";
  }
}

// ==========================================
// ULASIM KARSILASTIRMASI
// ==========================================

function resetComparison() {
  comparisonResult.textContent = "";
}

function updateTripEstimate() {
  const hasDistance = distanceInput.validity.valid;
  tripEstimate.textContent = hasDistance
    ? `${formatEmission(calculateEmission(transportInput.value, distanceInput.valueAsNumber))} kg CO₂e`
    : distanceInput.value ? "Geçerli bir mesafe gir" : "Mesafe gir";
  resetComparison();
}

distanceInput.addEventListener("input", updateTripEstimate);
transportInput.addEventListener("change", updateTripEstimate);
compareTransport.addEventListener("change", resetComparison);

compareButton.addEventListener("click", () => {
  if (!distanceInput.reportValidity()) return;

  const transport = transportInput.value;
  const distance = distanceInput.valueAsNumber;
  const alternative = compareTransport.value;

  if (!Object.hasOwn(factors, alternative)) {
    comparisonResult.textContent =
      "Geçerli bir ulaşım aracı seç.";
    return;
  }

  const oldEmission = calculateEmission(transport, distance);
  const newEmission = calculateEmission(alternative, distance);
  const difference = oldEmission - newEmission;

  comparisonResult.replaceChildren();

  const title = document.createElement("strong");

  title.textContent =
    `Aynı mesafede karşılaştırma · ${distance.toLocaleString("tr-TR")} km`;

  const before = document.createElement("p");

  before.textContent =
    `Kullanılan: ${transportNames[transport]} ` +
    `— ${formatEmission(oldEmission)} kg CO₂e`;

  const after = document.createElement("p");

  after.textContent =
    `Alternatif: ${transportNames[alternative]} ` +
    `— ${formatEmission(newEmission)} kg CO₂e`;

  const result = document.createElement("p");

  if (difference > 0) {
    result.textContent =
      `Tahmini azaltım potansiyeli: ` +
      `${formatEmission(difference)} kg CO₂e`;
    result.className = "positive-result";
  } else if (difference < 0) {
    result.textContent =
      `Tahmini emisyon artışı: ` +
      `${formatEmission(Math.abs(difference))} kg CO₂e`;
  } else {
    result.textContent =
      "İki seçeneğin hesaplanan emisyonu eşit.";
  }

  const note = document.createElement("small");

  note.textContent =
    "Sonuç, aynı mesafe için bir tahmindir. Yolculuk kaydı yalnızca kullandığın aracı içerir.";

  comparisonResult.append(
    title,
    before,
    after,
    result,
    note
  );
});

// ==========================================
// UYGULAMAYI YENILEME
// ==========================================

function updateWeeklyChart(weekStart, weeklyTrips) {
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(weekStart);
    date.setUTCDate(date.getUTCDate() + index);
    return { date, emission: 0 };
  });
  const daysByDate = new Map(days.map(day => [dateKey(day.date), day]));

  for (const trip of weeklyTrips) {
    daysByDate.get(dateKey(new Date(trip.createdAt))).emission += trip.emission;
  }

  const maxEmission = Math.max(...days.map(day => day.emission));
  const accessibleValues = [];
  weeklyChart.replaceChildren();

  for (const { date, emission } of days) {
    const column = document.createElement("div");
    column.className = "chart-column";

    const value = document.createElement("span");
    value.className = "chart-value";
    value.textContent = formatEmission(emission);

    const bar = document.createElement("div");
    bar.className = "chart-bar";
    bar.style.height = `${maxEmission > 0 ? 105 * (emission / maxEmission) : 0}px`;

    const label = document.createElement("span");
    label.className = "chart-day";
    label.textContent = date.toLocaleDateString("tr-TR", { weekday: "short", timeZone: istanbulZone });
    accessibleValues.push(`${date.toLocaleDateString("tr-TR", { weekday: "long", timeZone: istanbulZone })} ${value.textContent} kg CO₂e`);

    column.append(value, bar, label);
    weeklyChart.appendChild(column);
  }

  weeklyChart.setAttribute("aria-label", `Günlük emisyonlar. ${accessibleValues.join(", ")}`);
  chartSummary.textContent = weeklyTrips.length
    ? `Bu haftanın toplamı: ${formatEmission(days.reduce((total, day) => total + day.emission, 0))} kg CO₂e.`
    : "Bu hafta henüz yolculuk kaydedilmedi. Değerler kg CO₂e cinsindendir.";
}

let renderedDay;

function refreshApp() {
  const now = new Date();
  renderedDay = dateKey(now);
  const weekStart = getWeekStart(now);
  const weeklyTrips = getWeeklyTrips(weekStart, now);
  updateDashboard(renderedDay, weeklyTrips);
  updateWeeklyChart(weekStart, weeklyTrips);
  renderTrips();
  updateRecommendation();
  updateReductionTotals(weeklyTrips);
  document.dispatchEvent(new Event("tripsupdated"));
}

function refreshOnDayChange() {
  if (dateKey(new Date()) !== renderedDay) {
    refreshApp();
  }
}

if (weeklyGoal !== null) {
  weeklyGoalInput.value = weeklyGoal;
}

updateSwitchVisibility();
refreshApp();
setInterval(refreshOnDayChange, 60_000);
document.addEventListener("visibilitychange", refreshOnDayChange);
window.addEventListener("storage", event => {
  if (event.key === TRIPS_KEY) {
    trips = loadTrips();
    refreshApp();
  }
});

const views = [...document.querySelectorAll("[data-view]")];
const navLinks = document.querySelectorAll(".header nav a");

function showView(focusHeading = false) {
  const requested = window.location.hash;
  const active = views.find(view => requested === "#" + view.id)
    ?? views.find(view => view.id === (requested === "#karsilastirma" ? "yolculuk" : ["#duzenli-rotalar", "#kampus-ringleri"].includes(requested) ? "akilli-rota" : "panel"));
  for (const view of views) view.hidden = view !== active;
  for (const link of navLinks) {
    if (link.hash === "#" + active.id) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  if (active.id === "akilli-rota") active.dispatchEvent(new Event("routeviewshown"));
  if (focusHeading) {
    if (["#duzenli-rotalar", "#kampus-ringleri"].includes(requested)) {
      const heading = document.getElementById(requested === "#kampus-ringleri" ? "campusRingHeading" : "regularHeading");
      heading.focus({ preventScroll: true });
      heading.scrollIntoView();
    } else if (requested === "#hedefler") {
      weeklyGoalInput.focus({ preventScroll: true });
      document.getElementById("hedefler").scrollIntoView();
    } else {
      window.scrollTo(0, 0);
      active.querySelector("h1").focus({ preventScroll: true });
    }
  }
}

showView(["#duzenli-rotalar", "#kampus-ringleri"].includes(window.location.hash));
window.addEventListener("hashchange", () => showView(true));
