"use strict";

const EMISSION_MODEL_VERSION = "isu-emissions-pilot-v1";
const factors = Object.freeze({ car: 0.17, bus: 0.10, metro: 0.04, walk: 0, bike: 0 });

const routeFactors = Object.freeze({
  car: { value: factors.car, unit: "kg CO₂e / araç-km" },
  metro: { value: factors.metro, unit: "kg CO₂e / yolcu-km" },
  source: "İSÜ Karbon prototip varsayımı",
  reviewed: "21 Kasım 2026"
});

function emissionModelFor(mode, option = {}) {
  const isRing = mode === "ring";
  const value = isRing ? option.kgPerVehicleKm : factors[mode];
  if (!Number.isFinite(value) || value < 0) return undefined;
  return {
    version: EMISSION_MODEL_VERSION,
    factorId: isRing ? option.assumptionVersion ?? "ring" : mode,
    value,
    unit: isRing ? option.factorUnit : routeFactors[mode]?.unit ?? "kg CO₂e / yolcu-km",
    source: isRing ? option.source : routeFactors.source,
    scope: mode === "walk" || mode === "bike" ? "Doğrudan işletim" : "Prototip yolculuk hesabı",
    status: "pilot"
  };
}

function compareRouteEmissions(carKm, railKm, passengers) {
  if (!Number.isFinite(carKm) || carKm <= 0 || !Number.isInteger(passengers) || passengers < 1 ||
      (railKm !== null && (!Number.isFinite(railKm) || railKm <= 0))) return null;
  const car = carKm * routeFactors.car.value / passengers;
  const rail = railKm === null ? null : railKm * routeFactors.metro.value;
  const difference = rail === null ? null : car - rail;
  return { car, rail, difference, percent: difference === null || car === 0 ? null : difference / car * 100 };
}


const pilotStationSource = "https://www.arcgis.com/home/item.html?id=7fa0b254f3f44ab786b64878a10efb0c";
const yenikapiM2 = { label: "Yenikapı M2 istasyonu, Fatih", coordinates: [28.951447, 41.005571], source: pilotStationSource };

const routePresets = {
  rail: {
    label: "Yenikapı M2 – Vadistanbul F3",
    start: yenikapiM2,
    end: { label: "Vadistanbul F3 istasyonu, Sarıyer", coordinates: [28.988298, 41.107538], source: pilotStationSource }
  },
  campuses: {
    label: "İSÜ Topkapı Kampüsü – İSÜ Vadi Kampüsü",
    start: { label: "İSÜ Topkapı Ana Yerleşke", coordinates: [28.9090922, 41.0161952], source: "https://maps.app.goo.gl/C8gmFiJfSnYDGW1i8" },
    end: { label: "İSÜ Vadi Ana Yerleşke", coordinates: [28.9774081, 41.1018753], source: "https://maps.app.goo.gl/adY1Q7Ds8zr58J129" }
  },
  taksim: {
    label: "Taksim M2 – Yenikapı M2",
    start: { label: "Taksim M2", coordinates: [28.9864, 41.0369], source: "https://en.wikipedia.org/wiki/Taksim_station" },
    end: yenikapiM2
  },
  kadikoy: {
    label: "Kadıköy – Üsküdar",
    start: { label: "Kadıköy M4", coordinates: [29.020906, 40.991113], source: "https://en.wikipedia.org/wiki/Kad%C4%B1k%C3%B6y_station" },
    end: { label: "Üsküdar M5", coordinates: [29.0133, 41.0253], source: "https://en.wikipedia.org/wiki/%C3%9Csk%C3%BCdar_metro_station" }
  }
};

const stationSurvey = "https://nek.istanbul.edu.tr/ekos/TEZ/60672.pdf";
Object.assign(routePresets, {
  mecidiyekoy: {
    label: "Mecidiyeköy – İSÜ Vadi Kampüsü",
    start: { label: "Şişli–Mecidiyeköy M2", coordinates: [28.992404, 41.063964], source: stationSurvey },
    end: routePresets.campuses.end
  },
  bakirkoy: {
    label: "Bakırköy – İSÜ Topkapı Kampüsü",
    start: { label: "Bakırköy–İncirli M1A", coordinates: [28.875307, 40.996613], source: stationSurvey },
    end: routePresets.campuses.start
  },
  uskudar: {
    label: "Üsküdar – Taksim",
    start: routePresets.kadikoy.end,
    end: routePresets.taksim.start
  },
  maslak: {
    label: "Levent – Maslak",
    start: { label: "Levent M2", coordinates: [29.015034, 41.075896], source: stationSurvey },
    end: { label: "İTÜ–Ayazağa M2, Maslak", coordinates: [29.019559, 41.108463], source: stationSurvey }
  }
});

// Verified lines may provide endpoints, coordinates, km, minutes and a source.
const verifiedBusLines = [];

const campusRing = {
  start: routePresets.campuses.start,
  end: routePresets.campuses.end,
  vehicleType: null,
  fuel: null,
  km: null,
  capacity: null,
  passengers: null,
  kgPerVehicleKm: null,
  coordinates: null,
  verified: false,
  source: "https://www.istinye.edu.tr/tr/duyurular/vadi-ile-buyuyoruz"
};

function calculateRingEmissions({ km, kgPerVehicleKm, capacity, passengers }) {
  if (!Number.isFinite(km) || km <= 0 || !Number.isFinite(kgPerVehicleKm) || kgPerVehicleKm < 0 ||
      !Number.isInteger(capacity) || capacity < 1 || !Number.isInteger(passengers) ||
      passengers < 1 || passengers > capacity) return null;

  const vehicle = km * kgPerVehicleKm;
  return Number.isFinite(vehicle) ? { vehicle, perPerson: vehicle / passengers } : null;
}


const CAMPUS_RING_ASSUMPTIONS = Object.freeze({
  version: "campus-ring-pilot-v1",
  km: 20,
  passengers: 20,
  kgPerVehicleKm: 1,
  factorUnit: "kg CO₂e / araç-km",
  vehicleType: "Temsili kampüs ringi",
  source: "İSÜ Karbon prototip varsayımı",
  dataStatus: "Pilot ring – kullanıcı beyanına ve varsayımlara dayalı"
});

function campusRingOption(ring = campusRing) {
  const assumptions = ring.verified ? ring : { ...CAMPUS_RING_ASSUMPTIONS, capacity: CAMPUS_RING_ASSUMPTIONS.passengers };
  const estimate = calculateRingEmissions(assumptions);
  if (!estimate) return null;

  const { km, passengers, kgPerVehicleKm, factorUnit, vehicleType, source } = assumptions;
  return {
    km, passengers, kgPerVehicleKm, factorUnit, vehicleType, source,
    assumptionVersion: ring.verified ? undefined : CAMPUS_RING_ASSUMPTIONS.version,
    dataStatus: ring.verified ? "Doğrulanmış kampüs ringi" : CAMPUS_RING_ASSUMPTIONS.dataStatus,
    emission: estimate.perPerson, vehicleEmission: estimate.vehicle
  };
}
