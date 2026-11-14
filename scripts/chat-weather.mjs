export async function weatherAnswer(city, day, userText) {
  if (!Number.isInteger(day) || day < 0 || day > 2 || typeof city !== "string" ||
      !/^[\p{L}][\p{L}\p{M} .'-]{0,35}$/u.test(city) ||
      !userText.toLowerCase().includes(city.toLowerCase())) {
    return "请告诉我你要查的城市。";
  }
  const signal = AbortSignal.timeout(5000);
  async function get(url) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error("weather service unavailable");
    return res.json();
  }
  try {
    const { results } = await get("https://geocoding-api.open-meteo.com/v1/search?" +
      new URLSearchParams({ name: city, count: "3", language: "zh" }));
    if (!results?.length) return `没找到「${city}」，能补一下省份或城市全称吗？`;
    const place = results[0];
    if (results[1]?.name === place.name && results[1].country_code !== place.country_code)
      return `有多个地方叫「${city}」，你想查哪个国家或地区？`;
    const { daily, timezone } = await get("https://api.open-meteo.com/v1/forecast?" +
      new URLSearchParams({ latitude: place.latitude, longitude: place.longitude, timezone: "auto", forecast_days: "3",
        daily: "temperature_2m_min,temperature_2m_max,precipitation_probability_max" }));
    const date = daily?.time?.[day], min = daily?.temperature_2m_min?.[day], max = daily?.temperature_2m_max?.[day];
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    if (!date || daily.time[0] !== today || !Number.isFinite(min) || !Number.isFinite(max))
      throw new Error("forecast dates or temperatures unavailable");
    const rain = daily.precipitation_probability_max?.[day];
    return `${place.name}（${place.admin1 || place.country}）${date}预计 ${min}～${max}°C` +
      (Number.isFinite(rain) ? `，最高降水概率 ${rain}%` : "") + "。来源：Open-Meteo。";
  } catch {
    return `暂时没取到${city}的实时预报，稍后可以再查一次。`;
  }
}
