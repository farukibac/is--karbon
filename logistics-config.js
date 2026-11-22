export const LOGISTICS_MODEL = "isu-logistics-v2";
export const FACTOR_SOURCE = "https://assets.publishing.service.gov.uk/media/6a6c9748862aaf18d9c62ac9/ghg-conversion-factors-2026-flat-format-revised.xlsx";
export const classes = {
  n1: { label: "Kamyonet · N1 (≤3,5 t)", min: 0, max: 3.5 },
  n2: { label: "Orta kamyon · N2 (>3,5–12 t)", min: 3.5, max: 12 },
  n3: { label: "Ağır kamyon / TIR · N3 (>12 t)", min: 12, max: Infinity }
};

const source = { source: FACTOR_SOURCE, year: 2026, geography: "Birleşik Krallık", boundary: "Doğrudan işletim (TTW)" };
export const emissionFactors = {
  van: { ...source, id: "5_303_3103_4_1", value: 0.20905, unit: "kg CO₂e/araç-km", method: "vehicle", fuel: "petrol", label: "Benzinli kamyonet · UK filo ortalaması" },
  diesel: { ...source, id: "1_101_1011_8_1", value: 2.58354, unit: "kg CO₂e/L", method: "fuel", fuel: "diesel", label: "Dizel · ortalama biyoyakıt karışımı" },
  petrol: { ...source, id: "1_101_1017_8_1", value: 2.075, unit: "kg CO₂e/L", method: "fuel", fuel: "petrol", label: "Benzin · ortalama biyoyakıt karışımı" },
  tonne: { ...source, id: "27_304_3140_14_1", value: 0.10356, unit: "kg CO₂e/ton-km", method: "tonne", fuel: "diesel", label: "Soğutmasız dizel ağır vasıta filosu · ortalama doluluk" },
  vehicle: { ...source, id: "27_304_3124_4_1", value: 0.84606, unit: "kg CO₂e/araç-km", method: "vehicle", fuel: "diesel", label: "Soğutmasız dizel rijit kamyon · ortalama doluluk" }
};

const geoNames = "https://www.geonames.org/search.html?country=TR&q=Turketi";
const cityCenter = (name, coordinates, source = geoNames) => ({ label: name + " · şehir merkezi", coordinates, source });

export const cities = {
  istanbul: { label: "İstanbul · İSÜ Topkapı Ana Yerleşke", coordinates: [28.9090922, 41.0161952], source: "https://www.istinye.edu.tr/tr/iletisim" },
  ankara: { label: "Ankara · şehir merkezi", coordinates: [32.854, 39.920], source: "https://www.geonames.org/TR/largest-cities-in-turkey.html" },
  kocaeli: { label: "Kocaeli · İzmit merkezi", coordinates: [29.92928, 40.76499], source: "https://www.geodatos.net/en/coordinates/turkey/izmit" },
  bursa: { label: "Bursa · şehir merkezi", coordinates: [29.060, 40.196], source: "https://www.geonames.org/TR/largest-cities-in-turkey.html" },
  sivas: cityCenter("Sivas", [37.0161111, 39.7483333]),
  konya: cityCenter("Konya", [32.484636, 37.871354], "https://www.geonames.org/search.html?country=TR&q=Uturuki"),
  kayseri: cityCenter("Kayseri", [35.485278, 38.732222]),
  antalya: cityCenter("Antalya", [30.695565, 36.908118]),
  eskisehir: cityCenter("Eskişehir", [30.520556, 39.776667]),
  adana: cityCenter("Adana", [35.32531, 36.98615])
};
