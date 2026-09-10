const API_TIMEOUT_MS = Number(
  process.env.API_TIMEOUT_MS || 10_000
);

const CACHE_TTL_MS = Number(
  process.env.VERSIONS_CACHE_TTL_MS || 45_000
);

let versionsCache = null;
let versionsCacheExpiresAt = 0;

function getApiBaseUrl() {
  return (
    process.env.UNDERCUR_API_URL ||
    "https://oris-flax.vercel.app/api/undercur"
  ).replace(/\/+$/, "");
}

function getVersionsUrl() {
  const customPath =
    process.env.UNDERCUR_VERSIONS_PATH || "/get-versions/";

  if (/^https?:\/\//i.test(customPath)) {
    return customPath;
  }

  return `${getApiBaseUrl()}/${customPath.replace(/^\/+/, "")}`;
}

function normalizeVersionName(value, fallbackIndex) {
  if (
    value !== undefined &&
    value !== null &&
    String(value).trim()
  ) {
    return String(value).trim();
  }

  return `Версия ${fallbackIndex + 1}`;
}

function extractUrl(value) {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const candidates = [
    value.path,
    value.url,
    value.downloadUrl,
    value.download_url,
    value.file,
    value.href,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function parseVersionsPayload(payload) {
  const result = [];

  function addVersion(version, value, index) {
    const url = extractUrl(value);

    if (!url) {
      return;
    }

    result.push({
      version: normalizeVersionName(version, index),
      url,
    });
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  // Основной формат:
  // { versions: { "1.0.0": { path: "..." } } }
  if (
    payload.versions &&
    typeof payload.versions === "object" &&
    !Array.isArray(payload.versions)
  ) {
    Object.entries(payload.versions).forEach(
      ([version, value], index) => {
        addVersion(version, value, index);
      }
    );
  }

  // Варианты:
  // { versions: [{ version: "1.0.0", path: "..." }] }
  // { data: [{ version: "1.0.0", url: "..." }] }
  // { releases: [...] }
  const arrays = [
    payload.versions,
    payload.data,
    payload.releases,
    payload.items,
    payload.results,
  ];

  for (const array of arrays) {
    if (!Array.isArray(array)) {
      continue;
    }

    array.forEach((item, index) => {
      if (typeof item === "string") {
        addVersion(item, item, index);
        return;
      }

      if (!item || typeof item !== "object") {
        return;
      }

      const version =
        item.version ??
        item.name ??
        item.tag ??
        item.id;

      addVersion(version, item, index);
    });
  }

  // Вариант:
  // { "1.0.0": "https://example.com/file.ppsx" }
  if (!result.length) {
    for (const [key, value] of Object.entries(payload)) {
      if (
        key !== "versions" &&
        key !== "data" &&
        key !== "releases" &&
        key !== "items" &&
        key !== "results"
      ) {
        addVersion(key, value, result.length);
      }
    }
  }

  const unique = new Map();

  for (const item of result) {
    const key = `${item.version}|${item.url}`;

    if (!unique.has(key)) {
      unique.set(key, item);
    }
  }

  return sortVersions([...unique.values()]);
}

function compareVersions(a, b) {
  const parse = (value) => {
    const match = String(value).match(
      /(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/
    );

    if (!match) {
      return null;
    }

    return [
      Number(match[1] || 0),
      Number(match[2] || 0),
      Number(match[3] || 0),
    ];
  };

  const left = parse(a.version);
  const right = parse(b.version);

  if (left && right) {
    for (let i = 0; i < 3; i++) {
      if (left[i] !== right[i]) {
        return left[i] - right[i];
      }
    }
  }

  return a.version.localeCompare(b.version, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function sortVersions(versions) {
  return versions.sort(compareVersions);
}

async function requestJson(url) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, API_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "UnderCur-Telegram-Bot/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`Versions API returned HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function getVersions(options = {}) {
  const forceRefresh = options.forceRefresh === true;

  if (
    !forceRefresh &&
    versionsCache &&
    Date.now() < versionsCacheExpiresAt
  ) {
    return versionsCache;
  }

  const url = getVersionsUrl();
  const payload = await requestJson(url);
  const versions = parseVersionsPayload(payload);

  if (!versions.length) {
    const error = new Error(
      "The versions API returned an empty or unsupported response"
    );

    error.code = "INVALID_VERSIONS_FORMAT";
    console.error("Unable to parse versions API response:", {
      url,
      payload,
    });

    throw error;
  }

  versionsCache = versions;
  versionsCacheExpiresAt = Date.now() + CACHE_TTL_MS;

  return versions;
}

function findVersion(versions, versionName) {
  return versions.find(
    (item) => item.version === String(versionName)
  );
}

function isValidFileUrl(value) {
  try {
    const url = new URL(value);

    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      /\.ppsx(?:$|[?#])/i.test(url.pathname + url.search)
    );
  } catch {
    return false;
  }
}

module.exports = {
  getVersions,
  findVersion,
  isValidFileUrl,
  parseVersionsPayload,
  getVersionsUrl,
};
