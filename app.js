
"use strict";

// ==========================================
// ISU KARBON - ILK CALISAN PROTOTIP
// ==========================================

// TEMSILI TEST KATSAYILARI
// Birim: kg CO2e / yolcu-km
// Yarisma tesliminden once kaynakli katsayilarla
// degistirilmelidir.

const factors = {
  car: 0.17,
  bus: 0.10,
  metro: 0.04,
  walk: 0,
  bike: 0
};

const transportNames = {
  car: "Otomobil",
  bus: "Otobüs",
  metro: "Metro / Raylı Sistem",
  walk: "Yürüyüş",
  bike: "Bisiklet"
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

const storedTrips = readStorage(TRIPS_KEY, []);

let trips = Array.isArray(storedTrips)
  ? storedTrips.filter(trip =>
      trip &&
      typeof trip.id === "string" &&
      Object.hasOwn(factors, trip.transport) &&
      Number.isFinite(trip.distance) &&
      trip.distance > 0 &&
      Number.isFinite(trip.emission) &&
      typeof trip.createdAt === "string" &&
      !Number.isNaN(Date.parse(trip.createdAt))
    )
  : [];

let weeklyGoal = readStorage(GOAL_KEY, null);

if (!Number.isInteger(weeklyGoal) ||
    weeklyGoal < 1 ||
    weeklyGoal > 30) {
  weeklyGoal = null;
}

function saveTrips() {
  return writeStorage(TRIPS_KEY, trips);
}

// ==========================================
// TARIH ISLEMLERI
// ==========================================

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function getWeekStart() {
  const today = new Date();

  const start = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  );

  const day = (start.getDay() + 6) % 7;

  start.setDate(start.getDate() - day);
  start.setHours(0, 0, 0, 0);

  return start;
}

function getWeeklyTrips() {
  const start = getWeekStart();
  const now = new Date();

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

const todayElement = document.getElementById("todayEmission");
const weekElement = document.getElementById("weeklyEmission");
const totalTripsElement = document.getElementById("totalTrips");

const tripList = document.getElementById("tripList");

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

function updateDashboard() {
  const today = dateKey(new Date());

  const todayTrips = trips.filter(trip =>
    dateKey(new Date(trip.createdAt)) === today
  );

  const weeklyTrips = getWeeklyTrips();

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
  const distance = Number(distanceInput.value);

  if (
    !Object.hasOwn(factors, transport) ||
    !Number.isFinite(distance) ||
    distance <= 0 ||
    distance > 1000
  ) {
    messageElement.textContent =
      "Lütfen 0 ile 1000 km arasında geçerli bir mesafe gir.";

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
    id: crypto.randomUUID(),
    transport: transport,
    distance: distance,
    emission: emission,
    replacedCar: replacedCar,
    createdAt: new Date().toISOString()
  };

  trips.push(trip);

  const saved = saveTrips();

  messageElement.textContent = saved
    ? "Yolculuğun başarıyla kaydedildi."
    : "Yolculuk eklendi ancak tarayıcıya kaydedilemedi.";

  tripForm.reset();
  updateSwitchVisibility();

  refreshApp();
});

// ==========================================
// YOLCULUK GECMISI
// ==========================================

function renderTrips() {
  tripList.replaceChildren();

  if (trips.length === 0) {
    const empty = document.createElement("p");

    empty.textContent =
      "Henüz kaydedilmiş yolculuk bulunmuyor.";

    tripList.appendChild(empty);
    return;
  }

  const sortedTrips = [...trips].reverse();

  sortedTrips.forEach(trip => {
    const row = document.createElement("div");
    row.className = "trip";

    const details = document.createElement("span");

    const date = new Date(trip.createdAt)
      .toLocaleDateString("tr-TR");

    details.textContent =
      `${transportNames[trip.transport]} · ` +
      `${trip.distance} km · ${date}` +
      (trip.replacedCar ? " · Otomobil yerine" : "");

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
      trips = trips.filter(item => item.id !== trip.id);

      saveTrips();
      refreshApp();
    });

    rightSide.append(emission, deleteButton);
    row.append(details, rightSide);

    tripList.appendChild(row);
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

  const alternatives = Object.keys(factors)
    .filter(mode =>
      mode !== lastTrip.transport &&
      factors[mode] < factors[lastTrip.transport]
    )
    .sort((a, b) => factors[b] - factors[a]);

  if (alternatives.length === 0) {
    recommendationText.textContent =
      "Son yolculuğun için bu hesaplama kapsamında " +
      "daha düşük işletim emisyonlu bir seçenek bulunmuyor.";

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
    "azaltabilirsin.";

  potentialSaving.textContent =
    `Tahmini tasarruf potansiyeli: ` +
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
    goalStatus.textContent =
      "1 ile 30 arasında tam sayı gir.";

    return;
  }

  weeklyGoal = goal;
  writeStorage(GOAL_KEY, weeklyGoal);

  updateWeeklyGoal();
});

function updateWeeklyGoal() {
  if (weeklyGoal === null) {
    goalStatus.textContent =
      "Henüz haftalık hedef belirlemedin.";

    goalProgress.value = 0;
    return;
  }

  weeklyGoalInput.value = weeklyGoal;

  const switchedTrips = getWeeklyTrips()
    .filter(trip => trip.replacedCar === true);

  const completed = switchedTrips.length;

  const percent = Math.min(
    (completed / weeklyGoal) * 100,
    100
  );

  goalProgress.value = percent;

  const estimatedSaving = switchedTrips.reduce(
    (total, trip) => {
      const oldEmission = trip.distance * factors.car;
      return total + Math.max(
        0,
        oldEmission - trip.emission
      );
    },
    0
  );

  goalStatus.textContent =
    `${completed}/${weeklyGoal} ulaşım değişikliği · ` +
    `%${Math.round(percent)} tamamlandı. ` +
    `Beyan edilen değişikliklerin tahmini ` +
    `azaltımı: ${formatEmission(estimatedSaving)} kg CO₂e.`;

  if (completed >= weeklyGoal) {
    goalStatus.textContent +=
      " Tebrikler, haftalık hedefini tamamladın!";
  }
}

// ==========================================
// ULASIM KARSILASTIRMASI
// ==========================================

compareButton.addEventListener("click", () => {
  if (trips.length === 0) {
    comparisonResult.textContent =
      "Karşılaştırma yapmak için önce bir yolculuk ekle.";

    return;
  }

  const lastTrip = trips[trips.length - 1];

  const alternative = compareTransport.value;

  if (!Object.hasOwn(factors, alternative)) {
    comparisonResult.textContent =
      "Geçerli bir ulaşım aracı seç.";
    return;
  }

  const oldEmission = lastTrip.emission;

  const newEmission = calculateEmission(
    alternative,
    lastTrip.distance
  );

  const difference = oldEmission - newEmission;

  comparisonResult.replaceChildren();

  const title = document.createElement("strong");

  title.textContent =
    "Son yolculuğunun alternatif senaryosu";

  const before = document.createElement("p");

  before.textContent =
    `Mevcut: ${transportNames[lastTrip.transport]} ` +
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
    "Aynı mesafe varsayılmıştır. Bu karşılaştırma " +
    "gerçekleşmiş bir ulaşım değişikliği değildir.";

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

function refreshApp() {
  updateDashboard();
  renderTrips();
  updateRecommendation();
  updateWeeklyGoal();
}

updateSwitchVisibility();
refreshApp();

console.log("İSÜ Karbon uygulaması başlatıldı.");
