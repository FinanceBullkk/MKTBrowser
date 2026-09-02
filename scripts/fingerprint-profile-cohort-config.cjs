function selectProfileFingerprint(stock, options) {
  const ua = stock.contexts.document.surfaces.uaClientHints.readings;
  const locale = stock.contexts.document.surfaces.screenLocale.readings;
  const webgl = stock.contexts.document.surfaces.webgl1.readings;
  const device = selectDevice(webgl.unmaskedRenderer ?? webgl.renderer, ua.deviceMemory);
  const deviceOptions = options.devices.find((candidate) => candidate.id === device);
  const screen = deviceOptions?.screens.some(
    (candidate) =>
      candidate.width === locale.screen?.width && candidate.height === locale.screen?.height,
  )
    ? { width: locale.screen.width, height: locale.screen.height }
    : { width: 1920, height: 1080 };
  const normalizedTimezone = normalizeTimezone(locale.timezone);
  const localeOption =
    options.locales.find(
      (candidate) =>
        candidate.id === locale.language && candidate.timezones.includes(normalizedTimezone),
    ) ??
    options.locales.find((candidate) => candidate.timezones.includes(normalizedTimezone)) ??
    options.locales.find((candidate) => candidate.id === locale.language) ??
    options.locales.find((candidate) => candidate.id === "en-US");
  const hardwareConcurrency = nearestAllowed(ua.hardwareConcurrency, allowedHwc(device));
  const deviceMemory = nearestAllowed(ua.deviceMemory, allowedMemory(device));
  return {
    device,
    localeId: localeOption.id,
    timezone: localeOption.timezones.includes(normalizedTimezone)
      ? normalizedTimezone
      : localeOption.timezones[0],
    screen,
    hardwareConcurrency,
    deviceMemory,
  };
}

function selectDevice(renderer = "", deviceMemory) {
  const value = renderer.toLowerCase();
  if (value.includes("nvidia")) {
    return deviceMemory <= 8 ? "windows-laptop-nvidia" : "windows-desktop-nvidia";
  }
  if (value.includes("amd") || value.includes("radeon")) {
    return deviceMemory <= 8 ? "windows-laptop-amd" : "windows-desktop-amd";
  }
  if (value.includes("intel")) {
    return deviceMemory <= 8 ? "windows-laptop-intel" : "windows-desktop-intel";
  }
  return "windows-laptop-nvidia";
}

function allowedHwc(device) {
  if (device === "windows-desktop-nvidia") return [8, 12, 16, 24, 32];
  if (device === "windows-desktop-amd") return [8, 12, 16];
  if (device === "windows-desktop-intel") return [6, 8, 12];
  if (device === "windows-laptop-intel") return [4, 8, 12];
  return [6, 8, 12, 16];
}

function allowedMemory(device) {
  if (device === "windows-desktop-nvidia") return [16, 32, 64];
  if (device === "windows-desktop-amd") return [16, 32];
  if (device === "windows-desktop-intel") return [8, 16, 32];
  return [8, 16];
}

function nearestAllowed(value, allowed) {
  return [...allowed].sort((left, right) => Math.abs(left - value) - Math.abs(right - value))[0];
}

function normalizeTimezone(value) {
  return value === "Asia/Saigon" ? "Asia/Ho_Chi_Minh" : value;
}

module.exports = { selectProfileFingerprint };
