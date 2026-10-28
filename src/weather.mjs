export function coordinates(query) {
  const latitude = query.latitude;
  const longitude = query.longitude;
  if (typeof latitude !== "string" || typeof longitude !== "string" || !latitude.trim() || !longitude.trim()) {
    throw new Error("latitude and longitude are required numeric parameters");
  }
  const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
  if (!decimal.test(latitude.trim()) || !decimal.test(longitude.trim())) {
    throw new Error("latitude and longitude must be decimal numbers");
  }
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new Error("latitude must be -90..90; longitude must be -180..180");
  }
  return { latitude: Number(lat.toFixed(4)), longitude: Number(lon.toFixed(4)) };
}

const cache = new Map();
const forecastWindow = 90 * 60000;
const modelWindow = 24 * 60 * 60000;
const clockTolerance = 5 * 60000;

export function validateWeather(weather, location, now = Date.now()) {
  if (!weather || weather.provider !== "MET Norway" || weather.dataType !== "model_forecast_nearest_time_not_station_observation") {
    throw new Error("Weather response has an invalid provider or data type");
  }
  if (weather.location?.latitude !== location.latitude || weather.location?.longitude !== location.longitude) {
    throw new Error("Weather response does not match the requested coordinates");
  }
  for (const [name, unit] of [["temperature", "celsius"], ["relativeHumidity", "%"], ["windSpeed", "m/s"]]) {
    if (!Number.isFinite(weather[name]?.value) || weather[name].unit !== unit) {
      throw new Error(`Weather response has invalid ${name} or units`);
    }
  }
  if (weather.relativeHumidity.value < 0 || weather.relativeHumidity.value > 100 || weather.windSpeed.value < 0) {
    throw new Error("Weather response has out-of-range humidity or wind speed");
  }
  const updated = Date.parse(weather.updatedAt);
  const forecast = Date.parse(weather.forecastTime);
  const retrieved = Date.parse(weather.retrievedAt);
  if (![now, updated, forecast, retrieved].every(Number.isFinite) ||
      Math.abs(forecast - now) > forecastWindow || now - updated > modelWindow ||
      updated - now > clockTolerance || now - retrieved > modelWindow || retrieved - now > clockTolerance) {
    throw new Error("Weather response has invalid or stale timestamps");
  }
  const source = new URL(weather.source);
  if (source.origin !== "https://api.met.no" || source.pathname !== "/weatherapi/locationforecast/2.0/compact" ||
      source.username || source.password || source.searchParams.getAll("lat").length !== 1 || source.searchParams.getAll("lon").length !== 1 ||
      Number(source.searchParams.get("lat")) !== location.latitude || Number(source.searchParams.get("lon")) !== location.longitude ||
      !weather.attribution?.includes("MET Norway") || weather.license !== "https://creativecommons.org/licenses/by/4.0/" ||
      (weather.summary !== null && typeof weather.summary !== "string")) {
    throw new Error("Weather response has invalid source or attribution");
  }
  return weather;
}

function forecastWeather(cached, location, source) {
  const payload = cached.payload;
  const now = Date.now();
  const entries = payload?.properties?.timeseries;
  const meta = payload?.properties?.meta;
  if (!Array.isArray(entries) || !entries.length || entries.some(entry => !Number.isFinite(Date.parse(entry?.time)))) {
    throw new Error("Weather provider returned no valid forecast times");
  }
  for (const [name, unit] of [["air_temperature", "celsius"], ["relative_humidity", "%"], ["wind_speed", "m/s"]]) {
    if (meta?.units?.[name] !== unit) throw new Error(`Weather provider returned invalid ${name} units`);
  }
  const nearest = entries.reduce((a, b) => Math.abs(Date.parse(a.time) - now) <= Math.abs(Date.parse(b.time) - now) ? a : b);
  const details = nearest.data?.instant?.details;
  return validateWeather({
    location,
    dataType: "model_forecast_nearest_time_not_station_observation",
    provider: "MET Norway",
    attribution: "Weather data from MET Norway, CC BY 4.0",
    license: "https://creativecommons.org/licenses/by/4.0/",
    transformations: "Selected nearest forecast time and renamed fields; source model data unchanged.",
    source,
    updatedAt: meta?.updated_at,
    forecastTime: nearest.time,
    retrievedAt: cached.retrievedAt,
    temperature: { value: details?.air_temperature, unit: "celsius" },
    relativeHumidity: { value: details?.relative_humidity, unit: "%" },
    windSpeed: { value: details?.wind_speed, unit: "m/s" },
    summary: nearest.data?.next_1_hours?.summary?.symbol_code ?? nearest.data?.next_6_hours?.summary?.symbol_code ?? null,
  }, location, now);
}

export async function weatherAt(location, fetcher = fetch) {
  const upstream = new URL("https://api.met.no/weatherapi/locationforecast/2.0/compact");
  upstream.searchParams.set("lat", String(location.latitude));
  upstream.searchParams.set("lon", String(location.longitude));
  const key = upstream.toString();
  let cached = cache.get(key);
  if (!cached || cached.expires <= Date.now()) {
    const headers = { "User-Agent": "YoyoX402WeatherDemo/0.1 (+https://yoyo-x402-weather.accessible-trip.workers.dev/F-02.md)", "Accept": "application/json" };
    if (cached?.modified) headers["If-Modified-Since"] = cached.modified;
    const response = await fetcher(upstream, { headers, signal: AbortSignal.timeout(20000) });
    const expires = Date.parse(response.headers.get("Expires") ?? "") || Date.now() + 60000;
    if (response.status === 304 && cached) {
      cached = { ...cached, expires };
    } else {
      if (!response.ok) throw new Error(`Weather provider returned HTTP ${response.status}`);
      cached = { payload: await response.json(), expires, modified: response.headers.get("Last-Modified"), retrievedAt: new Date().toISOString() };
    }
    const weather = forecastWeather(cached, location, key);
    if (cache.size >= 128 && !cache.has(key)) cache.delete(cache.keys().next().value);
    cache.set(key, cached);
    return weather;
  }
  return forecastWeather(cached, location, key);
}
