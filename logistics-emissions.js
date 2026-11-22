import { classes, emissionFactors, LOGISTICS_MODEL } from "./logistics-config.js";

const positive = value => Number.isFinite(value) && value > 0;
export const inLogisticsArea = point => Array.isArray(point) && point.length === 2 &&
  point.every(Number.isFinite) && point[0] >= 25 && point[0] <= 45 && point[1] >= 35 && point[1] <= 43;

export function shipmentError({ vehicle, capacity, load, gross }) {
  const range = Object.hasOwn(classes, vehicle) ? classes[vehicle] : null;
  if (!range || !positive(capacity) || !positive(load)) return "Pozitif yük ve taşıma kapasitesi gir.";
  if (load > capacity) return "Yük, aracın taşıma kapasitesini aşıyor.";
  if (capacity >= range.max) return "Yük kapasitesi, sınıfın azami araç kütlesinden düşük olmalı.";
  if (gross !== undefined && (!positive(gross) || gross <= load || gross > range.max)) {
    return "Yüklü araç ağırlığı yükten büyük olmalı ve araç sınıfının azami kütlesini aşmamalı.";
  }
  return "";
}

export function estimateShipment({ km, load, capacity, consumption, fuel, factor }) {
  if (![km, load, capacity].every(positive) || load > capacity || !factor ||
      factor.fuel !== fuel || !positive(factor.value)) return null;
  if (factor.method === "fuel" && !positive(consumption)) return null;
  const tonneKm = load * km;
  const litres = factor.method === "fuel" ? km * consumption / 100 : undefined;
  const activity = { fuel: litres, tonne: tonneKm, vehicle: km }[factor.method];
  const emission = activity * factor.value;
  if (![tonneKm, emission].every(positive)) return null;
  return { km, load, tonneKm, litres, emission, perTonne: emission / load,
    intensity: emission / tonneKm, occupancy: load / capacity * 100 };
}

export function validHgvRoute(route) {
  return route?.profile === "driving-hgv" && positive(route.km) &&
    Number.isFinite(route.minutes) && route.minutes >= 0 && Array.isArray(route.coordinates) &&
    route.coordinates.length > 1 && route.coordinates.every(inLogisticsArea) &&
    route.coordinates.some(point => point.join() !== route.coordinates[0].join());
}


const profiles = {
  n1: { factor: emissionFactors.van, routeProfile: "driving-hgv" },
  n2: { factor: emissionFactors.vehicle, routeProfile: "driving-hgv" },
  n3: { factor: emissionFactors.tonne, routeProfile: "driving-hgv" }
};

export function automaticProfile(vehicle, { fuel, consumption, evidence } = {}) {
  if (!Object.hasOwn(profiles, vehicle)) return null;
  const profile = profiles[vehicle];
  const fuelFactor = Object.hasOwn(emissionFactors, fuel) ? emissionFactors[fuel] : null;
  if (fuelFactor?.method === "fuel" && positive(consumption) && typeof evidence === "string" && evidence.trim()) {
    return { ...profile, factor: fuelFactor, fuel, consumption, evidence: evidence.trim(), dataStatus: "Belgeli tüketim beyanı · UK katsayısı" };
  }
  return { ...profile, fuel: profile.factor.fuel, consumption: undefined, evidence: undefined, dataStatus: "Pilot · UK filo referansı" };
}

const monthFormat = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit" });

export function budgetMonth(date = new Date()) {
  return Number.isFinite(+date) ? monthFormat.format(date) : null;
}

export function budgetPosition(limit, shipments, month = budgetMonth()) {
  let used = 0, planned = 0;
  const seen = new Set();
  for (const item of shipments) {
    if (typeof item?.id !== "string" || seen.has(item.id) || !Number.isFinite(item.emission) || item.emission < 0) continue;
    seen.add(item.id);
    if (item.shipmentStatus === "realized" && budgetMonth(new Date(item.realizedAt ?? item.createdAt)) === month) used += item.emission;
    if (item.shipmentStatus === "planned" && budgetMonth(new Date(item.createdAt)) === month) planned += item.emission;
  }
  if (!positive(limit)) return { used, planned, projected: used + planned, limit: null };
  const percent = used / limit * 100;
  return { limit, used, planned, projected: used + planned, remaining: Math.max(0, limit - used),
    excess: Math.max(0, used - limit), percent, tone: percent > 100 ? "red" : percent >= 80 ? "yellow" : "green" };
}

export function compareEstimates(base, alternative) {
  if (!base || !alternative || !base.factor?.boundary || !base.factor.source || !Number.isInteger(base.factor.year) ||
      base.factor.boundary !== alternative.factor?.boundary ||
      base.factor.source !== alternative.factor.source || base.factor.year !== alternative.factor.year ||
      base.load !== alternative.load || ![base.emission, alternative.emission].every(value => Number.isFinite(value) && value >= 0)) return null;
  const difference = base.emission - alternative.emission;
  return { difference, percent: base.emission > 0 ? difference / base.emission * 100 : null };
}

export function screeningScenarios(base) {
  const candidates = [];
  for (const [vehicle, range] of Object.entries(classes)) {
    if (vehicle === base.vehicle) continue;
    const title = "Araç profili ön değerlendirmesi · " + range.label;
    if (base.load >= range.max) {
      candidates.push({ title, message: "Yük, araç sınıfı sınırına ulaşıyor veya sınırı aşıyor. Araç elendi." });
      continue;
    }
    candidates.push({ id: "fleet-" + vehicle, title,
      message: "Aynı yük ve referans mesafe üzerinden filo tahmini. Uygulamak için belgeli kapasite, araç ölçüleri ve ORS kontrolü gerekir.",
      input: { ...base, ...automaticProfile(vehicle), vehicle, capacity: base.load, gross: undefined },
      quality: "DESNZ 2026 filo profili · kapasite ve rota uygunluğu teyit bekliyor" });
  }
  const fuelProfile = emissionFactors[base.fuel];
  if (fuelProfile?.method === "fuel") {
    const consumption = base.factor?.method === "fuel" ? base.consumption
      : base.emission / base.km / fuelProfile.value * 100;
    if (positive(consumption)) candidates.push({
      id: "hypothetical-fuel", title: "Varsayımsal verimlilik senaryosu",
      message: (base.factor.method === "fuel" ? "Belgeli beyan başlangıcı" : "Filo emisyonundan türetilen eşdeğer tüketim") +
        " üzerinden %5 düşüş varsayımı. Ölçüm veya araç tavsiyesi değildir.",
      input: { ...base, factor: fuelProfile, consumption: consumption * .95, evidence: undefined },
      quality: "Varsayım"
    });
  }
  return candidates;
}

export function historyComparison(record) {
  const sameModel = record.model === LOGISTICS_MODEL && Object.values(emissionFactors).some(factor =>
    ["id", "value", "method", "fuel", "source", "year", "boundary", "unit"].every(key => factor[key] === record.factor?.[key]));
  const profile = automaticProfile(record.vehicle, record);
  if (!profile || shipmentError(record)) return null;
  const input = sameModel ? record : { ...record, ...profile };
  const estimate = estimateShipment(input);
  if (!estimate) return null;
  const original = sameModel && Math.abs(estimate.emission - record.emission) <= 1e-8;
  const base = { ...input, ...estimate };
  const candidates = screeningScenarios(base).flatMap(candidate => {
    if (!candidate.input) return [];
    const alternative = estimateShipment(candidate.input);
    const delta = compareEstimates(base, alternative && { ...alternative, factor: candidate.input.factor });
    return delta?.difference > 0 ? [{ ...delta, title: candidate.title, quality: candidate.quality,
      emission: alternative.emission, km: alternative.km, factor: candidate.input.factor, id: candidate.id }] : [];
  });
  return { original, base, best: candidates.sort((a, b) => b.difference - a.difference)[0] };
}
