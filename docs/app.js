const state = {
  schedule: null,
  performance: null,
  players: [],
  activeTab: "schedule",
  activeFilter: "tracked",
  search: "",
  performanceMatchId: ""
};

const CACHE_TTL_MS = 15 * 60 * 1000;
const GOALPULSE_URL = "https://goalpulse.io/data/world-cup-2026.json";
const OPENFOOTBALL_URL =
  "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json";
const CLIENT_CACHE_KEY = "city-worldcup-schedule-cache-v1";
const PERFORMANCE_CACHE_KEY = "city-worldcup-performance-cache-v1";
const PERFORMANCE_CACHE_TTL_MS = 10 * 60 * 1000;
const FOTMOB_MATCH_LIMIT = 6;
const STAGE_LABELS = {
  group: "小组赛",
  r32: "32强",
  r16: "16强",
  qf: "1/4决赛",
  sf: "半决赛",
  third: "季军赛",
  final: "决赛"
};
const TEAM_ALIASES = {
  "Czech Republic": "Czechia",
  "Curacao": "Curaçao",
  Turkey: "Türkiye"
};

function localAsset(path) {
  return new URL(path, window.location.href).toString();
}

const els = {
  stats: document.querySelector("#summaryStats"),
  nextMatch: document.querySelector("#nextMatch"),
  refreshButton: document.querySelector("#refreshButton"),
  searchInput: document.querySelector("#searchInput"),
  tabs: [...document.querySelectorAll(".tab")],
  chips: [...document.querySelectorAll(".chip")],
  panels: {
    schedule: document.querySelector("#schedulePanel"),
    players: document.querySelector("#playersPanel"),
    knockout: document.querySelector("#knockoutPanel"),
    data: document.querySelector("#dataPanel")
  },
  matchList: document.querySelector("#matchList"),
  knockoutList: document.querySelector("#knockoutList"),
  playerGrid: document.querySelector("#playerGrid"),
  sourceList: document.querySelector("#sourceList"),
  performanceList: document.querySelector("#performanceList"),
  performanceMatchSelect: document.querySelector("#performanceMatchSelect"),
  performanceSource: document.querySelector("#performanceSource"),
  scheduleCount: document.querySelector("#scheduleCount"),
  knockoutCount: document.querySelector("#knockoutCount"),
  playerCount: document.querySelector("#playerCount"),
  updatedAt: document.querySelector("#updatedAt"),
  performanceUpdatedAt: document.querySelector("#performanceUpdatedAt"),
  emptyTemplate: document.querySelector("#emptyTemplate")
};

const formatDate = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  weekday: "short"
});

const formatTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

const formatFull = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

init();

async function init() {
  bindEvents();
  registerServiceWorker();
  await loadData();
}

function bindEvents() {
  els.refreshButton.addEventListener("click", () => loadData(true));
  els.searchInput.addEventListener("input", (event) => {
    state.search = event.target.value.trim().toLowerCase();
    render();
  });
  els.performanceMatchSelect.addEventListener("change", (event) => {
    state.performanceMatchId = event.target.value;
    renderPerformance();
  });

  for (const tab of els.tabs) {
    tab.addEventListener("click", () => {
      state.activeTab = tab.dataset.tab;
      for (const item of els.tabs) item.classList.toggle("is-active", item === tab);
      for (const [name, panel] of Object.entries(els.panels)) {
        panel.classList.toggle("is-active", name === state.activeTab);
      }
      render();
    });
  }

  for (const chip of els.chips) {
    chip.addEventListener("click", () => {
      state.activeFilter = chip.dataset.filter;
      for (const item of els.chips) item.classList.toggle("is-active", item === chip);
      render();
    });
  }
}

async function loadData(force = false) {
  els.refreshButton.disabled = true;
  els.refreshButton.textContent = "同步";
  try {
    const playersPayload = await loadPlayersPayload();
    const schedulePayload = await loadSchedulePayload(playersPayload, force);
    state.players = playersPayload.players || [];
    state.schedule = schedulePayload;
    state.performance = await loadPerformancePayload(schedulePayload, playersPayload, force);
    ensurePerformanceMatchSelection();
    render();
  } catch (error) {
    els.nextMatch.textContent = `同步失败：${error.message}`;
  } finally {
    els.refreshButton.disabled = false;
    els.refreshButton.textContent = "刷新";
  }
}

async function loadPlayersPayload() {
  try {
    return await httpJson(localAsset("players.json"));
  } catch {
    return httpJson("/api/players");
  }
}

async function loadSchedulePayload(playersPayload, force) {
  if (!isNativeApp()) {
    try {
      const response = await fetch(`/api/schedule${force ? "?force=1" : ""}`);
      const payload = await response.json();
      if (!response.ok || payload.ok === false) throw new Error(payload.error || "赛程同步失败");
      return payload;
    } catch {
      try {
        return await httpJson(localAsset("schedule-live.json"));
      } catch {
        return buildClientSchedule(playersPayload, force);
      }
    }
  }
  return buildClientSchedule(playersPayload, force);
}

async function buildClientSchedule(playersPayload, force = false) {
  if (!force) {
    const cached = loadClientCache();
    if (cached) return { ...cached, cacheHit: true };
  }

  let goalpulse = null;
  let openfootball = null;
  const sourceStatus = [];
  const [goalResult, openResult] = await Promise.allSettled([
    httpJson(GOALPULSE_URL),
    httpJson(OPENFOOTBALL_URL)
  ]);

  if (goalResult.status === "fulfilled") {
    goalpulse = goalResult.value;
    sourceStatus.push({
      name: "GoalPulse",
      ok: true,
      version: goalpulse.version || "",
      lastReviewed: goalpulse.lastReviewed || "",
      lastModified: ""
    });
  } else {
    sourceStatus.push({ name: "GoalPulse", ok: false, error: goalResult.reason.message });
  }

  if (openResult.status === "fulfilled") {
    openfootball = openResult.value;
    sourceStatus.push({ name: "openfootball", ok: true });
  } else {
    sourceStatus.push({ name: "openfootball", ok: false, error: openResult.reason.message });
  }

  if (!goalpulse && !openfootball) {
    const stale = loadClientCache(true);
    if (stale) return { ...stale, cacheHit: true, stale: true };
    throw new Error("没有可用赛程源");
  }

  const teamIndex = buildTeamIndex(goalpulse, playersPayload.players || []);
  const goalMatches = goalpulse ? normalizeGoalpulse(goalpulse) : [];
  const openMatches = openfootball ? normalizeOpenFootball(openfootball, teamIndex) : [];
  const merged = goalMatches.length ? enrichWithOpenfootball(goalMatches, openMatches) : openMatches;
  const annotated = annotateMatches(merged, playersPayload, teamIndex);
  const payload = {
    cachedAt: Date.now(),
    generatedAt: new Date().toISOString(),
    cacheHit: false,
    sources: sourceStatus,
    counts: {
      totalMatches: annotated.length,
      trackedConfirmed: annotated.filter((match) => match.isTracked).length,
      trackedPotential: annotated.filter((match) => match.isPotentialTracked).length,
      players: (playersPayload.players || []).length
    },
    playersMeta: { updatedAt: playersPayload.updatedAt },
    matches: annotated
  };
  saveClientCache(payload);
  return payload;
}

async function httpJson(url) {
  if (/^https?:\/\//.test(url) && isNativeApp()) {
    const plugin = window.Capacitor?.Plugins?.CapacitorHttp;
    if (plugin?.get) {
      const response = await plugin.get({
        url,
        headers: { "user-agent": "city-worldcup-tracker/0.1" }
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`${response.status}`);
      }
      return typeof response.data === "string" ? JSON.parse(response.data) : response.data;
    }
  }
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function isNativeApp() {
  return Boolean(window.Capacitor?.isNativePlatform?.());
}

function loadClientCache(allowStale = false) {
  try {
    const cached = JSON.parse(localStorage.getItem(CLIENT_CACHE_KEY) || "null");
    if (!cached) return null;
    if (allowStale || Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached;
  } catch {
    return null;
  }
  return null;
}

function saveClientCache(payload) {
  try {
    localStorage.setItem(CLIENT_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Storage can be unavailable in restricted WebView modes.
  }
}

function normalizeName(value) {
  return TEAM_ALIASES[value] || value;
}

function buildTeamIndex(goalpulse, players) {
  const byName = new Map();
  const byCode = new Map();
  for (const team of goalpulse?.teams || []) {
    const normalized = {
      id: team.id,
      code: team.code,
      name: team.name?.en || team.code,
      nameZh: team.name?.zh || team.name?.en || team.code,
      group: team.group || ""
    };
    byCode.set(normalized.code, normalized);
    byName.set(normalized.name, normalized);
    byName.set(normalizeName(normalized.name), normalized);
  }
  for (const player of players) {
    if (!player.teamCode || byCode.has(player.teamCode)) continue;
    const team = {
      id: player.teamCode.toLowerCase(),
      code: player.teamCode,
      name: player.teamName,
      nameZh: player.teamNameZh,
      group: ""
    };
    byCode.set(team.code, team);
    byName.set(team.name, team);
    byName.set(team.nameZh, team);
  }
  return { byName, byCode };
}

function teamFromGoalpulse(team) {
  if (!team) return null;
  return {
    id: team.id || "",
    code: team.code || "",
    name: team.name?.en || team.code || "",
    nameZh: team.name?.zh || team.name?.en || team.code || "",
    group: team.group || "",
    placeholder: false
  };
}

function placeholderTeam(label) {
  return {
    id: "",
    code: "",
    name: label || "TBD",
    nameZh: label || "待定",
    group: "",
    placeholder: true
  };
}

function parseMatchNumber(id) {
  const match = String(id || "").match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

function parseOpenFootballDate(date, time) {
  const match = String(time || "").match(/^(\d{1,2}):(\d{2})\s+UTC([+-]\d{1,2})$/);
  if (!match) return `${date}T00:00:00Z`;
  const [, hh, mm, offsetText] = match;
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCHours(Number(hh) - Number(offsetText), Number(mm), 0, 0);
  return base.toISOString();
}

function stageFromOpenRound(round, group) {
  if (group) return "group";
  const value = String(round || "").toLowerCase();
  if (value.includes("round of 32")) return "r32";
  if (value.includes("round of 16")) return "r16";
  if (value.includes("quarter")) return "qf";
  if (value.includes("semi")) return "sf";
  if (value.includes("third")) return "third";
  if (value.includes("final")) return "final";
  return "knockout";
}

function openTeam(rawName, teamIndex) {
  const name = normalizeName(rawName || "");
  const team = teamIndex.byName.get(name);
  if (team) return { ...team, placeholder: false };
  return placeholderTeam(rawName);
}

function normalizeGoalpulse(goalpulse) {
  const matches = [...(goalpulse?.matches || []), ...(goalpulse?.placeholderMatches || [])];
  return matches.map((match) => {
    const number = parseMatchNumber(match.id);
    const stage = match.stage || "group";
    return {
      id: match.id || `m${number}`,
      number,
      date: match.date,
      stage,
      stageLabel: STAGE_LABELS[stage] || stage,
      group: match.group || "",
      city: match.city || "",
      venue: match.venue || "",
      status: match.status || "scheduled",
      homeTeam: teamFromGoalpulse(match.homeTeam),
      awayTeam: teamFromGoalpulse(match.awayTeam),
      source: "GoalPulse",
      apiId: match.apiId || null,
      url: match.url?.zh || match.url?.en || ""
    };
  });
}

function normalizeOpenFootball(openfootball, teamIndex) {
  return (openfootball?.matches || []).map((match, index) => {
    const number = Number(match.num || index + 1);
    const stage = stageFromOpenRound(match.round, match.group);
    return {
      id: `of${String(number).padStart(3, "0")}`,
      number,
      date: parseOpenFootballDate(match.date, match.time),
      stage,
      stageLabel: STAGE_LABELS[stage] || match.round || stage,
      group: match.group ? String(match.group).replace("Group ", "") : "",
      city: match.ground || "",
      venue: match.ground || "",
      status: stage === "group" ? "scheduled" : "placeholder",
      homeTeam: openTeam(match.team1, teamIndex),
      awayTeam: openTeam(match.team2, teamIndex),
      source: "openfootball",
      apiId: null,
      url: "",
      openRound: match.round || ""
    };
  });
}

function enrichWithOpenfootball(goalMatches, openMatches) {
  const openByNumber = new Map(openMatches.map((match) => [match.number, match]));
  const goalNumbers = new Set(goalMatches.map((match) => match.number).filter(Boolean));
  const merged = goalMatches.map((match) => {
    const open = openByNumber.get(match.number);
    if (!open) return match;
    return {
      ...match,
      homeTeam: match.homeTeam || open.homeTeam,
      awayTeam: match.awayTeam || open.awayTeam,
      city: match.city || open.city,
      venue: match.venue || open.venue,
      fallbackSource: open.source
    };
  });
  for (const match of openMatches) {
    if (!goalNumbers.has(match.number)) merged.push(match);
  }
  return merged.sort((a, b) => new Date(a.date) - new Date(b.date) || a.number - b.number);
}

function annotateMatches(matches, playersPayload, teamIndex) {
  const players = playersPayload.players || [];
  const playersByTeam = new Map();
  for (const player of players) {
    if (!playersByTeam.has(player.teamCode)) playersByTeam.set(player.teamCode, []);
    playersByTeam.get(player.teamCode).push(player);
  }
  const trackedGroups = new Map();
  for (const code of playersByTeam.keys()) {
    const team = teamIndex.byCode.get(code);
    if (!team?.group) continue;
    if (!trackedGroups.has(team.group)) trackedGroups.set(team.group, []);
    trackedGroups.get(team.group).push(code);
  }
  return matches.map((match) => {
    const homePlayers = match.homeTeam?.code ? playersByTeam.get(match.homeTeam.code) || [] : [];
    const awayPlayers = match.awayTeam?.code ? playersByTeam.get(match.awayTeam.code) || [] : [];
    const involvedPlayers = [...homePlayers, ...awayPlayers];
    const placeholderGroups = [
      ...groupsFromSlot(match.homeTeam?.name),
      ...groupsFromSlot(match.awayTeam?.name)
    ];
    const potentialTeamCodes = new Set();
    for (const group of placeholderGroups) {
      for (const code of trackedGroups.get(group) || []) potentialTeamCodes.add(code);
    }
    const potentialPlayers = [...potentialTeamCodes].flatMap((code) => playersByTeam.get(code) || []);
    return {
      ...match,
      homePlayers,
      awayPlayers,
      involvedPlayers,
      potentialPlayers,
      isTracked: involvedPlayers.length > 0,
      isPotentialTracked: involvedPlayers.length === 0 && potentialPlayers.length > 0,
      hasPlaceholder: Boolean(match.homeTeam?.placeholder || match.awayTeam?.placeholder)
    };
  });
}

function groupsFromSlot(slot) {
  const groups = new Set();
  const text = String(slot || "");
  for (const match of text.matchAll(/[1-3]([A-L])|[A-L](?=[/\s]|$)/g)) {
    groups.add(match[1] || match[0]);
  }
  return [...groups];
}

async function loadPerformancePayload(schedulePayload, playersPayload, force = false) {
  if (!isNativeApp()) {
    try {
      return await httpJson(localAsset("performance-live.json"));
    } catch {
      // Static public hosts may not have live performance data yet.
    }
  }

  if (!force) {
    const cached = loadPerformanceCache();
    if (cached) return { ...cached, cacheHit: true };
  }

  const trackedMatches = performanceMatches(schedulePayload.matches || []);
  const playedMatches = trackedMatches
    .filter((match) => match.apiId && new Date(match.date).getTime() <= Date.now() + 90 * 60 * 1000)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, FOTMOB_MATCH_LIMIT);

  const rows = [];
  const errors = [];
  for (const match of playedMatches) {
    try {
      const data = await loadProviderMatchDetails(match.apiId);
      rows.push(...extractProviderPerformanceRows(data, match, playersPayload.players || []));
    } catch (error) {
      errors.push(`${match.number || match.id}: ${error.message}`);
    }
  }

  const message = playedMatches.length
    ? rows.length
      ? `已更新 ${rows.length} 条评分/上场时间`
      : `已尝试 ${playedMatches.length} 场，暂未匹配到评分字段`
    : "暂无已开赛的曼城相关比赛，赛后刷新会自动尝试评分";

  const payload = {
    cachedAt: Date.now(),
    generatedAt: new Date().toISOString(),
    cacheHit: false,
    rows,
    sourceStatus: [
      {
        name: "赛后球员详情",
        ok: rows.length > 0 || playedMatches.length === 0,
        message,
        errors: errors.slice(0, 3)
      }
    ]
  };
  savePerformanceCache(payload);
  return payload;
}

async function loadProviderMatchDetails(matchId) {
  if (isNativeApp()) {
    return httpJson(`https://www.fotmob.com/api/matchDetails?matchId=${matchId}`);
  }
  return httpJson(`/api/match-details?matchId=${encodeURIComponent(matchId)}`);
}

function loadPerformanceCache(allowStale = false) {
  try {
    const cached = JSON.parse(localStorage.getItem(PERFORMANCE_CACHE_KEY) || "null");
    if (!cached) return null;
    if (allowStale || Date.now() - cached.cachedAt < PERFORMANCE_CACHE_TTL_MS) return cached;
  } catch {
    return null;
  }
  return null;
}

function savePerformanceCache(payload) {
  try {
    localStorage.setItem(PERFORMANCE_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Storage can be unavailable in restricted WebView modes.
  }
}

function performanceMatches(matches = state.schedule?.matches || []) {
  return matches
    .filter((match) => match.isTracked && match.involvedPlayers?.length)
    .sort((a, b) => new Date(a.date) - new Date(b.date) || a.number - b.number);
}

function ensurePerformanceMatchSelection() {
  const matches = performanceMatches();
  if (!matches.length) {
    state.performanceMatchId = "";
    return;
  }
  if (matches.some((match) => match.id === state.performanceMatchId)) return;
  const now = Date.now();
  const latestPlayed = [...matches]
    .filter((match) => new Date(match.date).getTime() <= now)
    .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
  const next = matches.find((match) => new Date(match.date).getTime() > now);
  state.performanceMatchId = (latestPlayed || next || matches[0]).id;
}

function selectedPerformanceMatch() {
  return performanceMatches().find((match) => match.id === state.performanceMatchId) || performanceMatches()[0];
}

function extractProviderPerformanceRows(data, match, players) {
  const rows = new Map();
  for (const object of walkObjects(data)) {
    const name = objectPlayerName(object);
    if (!name) continue;
    const player = findMatchingPlayer(name, players);
    if (!player) continue;
    const rating = pickNumeric(object, [
      "rating",
      "fotMobRating",
      "playerRating",
      "stats.rating",
      "rating.num",
      "rating.value"
    ]);
    const minutes = pickNumeric(object, [
      "minutes",
      "mins",
      "minutesPlayed",
      "minsPlayed",
      "timePlayed",
      "stats.minutes",
      "stats.minutesPlayed"
    ]);
    if (rating == null && minutes == null) continue;
    const key = performanceKey(match.id, player.id);
    const existing = rows.get(key);
    if (!existing || existing.rating == null || rating != null) {
      rows.set(key, {
        matchId: match.id,
        matchNumber: match.number,
        playerId: player.id,
        playerName: player.name,
        rating,
        minutes,
        source: "赛后详情"
      });
    }
  }
  return [...rows.values()];
}

function* walkObjects(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 9) return;
  if (!Array.isArray(value)) yield value;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    yield* walkObjects(child, depth + 1);
  }
}

function objectPlayerName(object) {
  const candidates = [
    object.name,
    object.fullName,
    object.playerName,
    object.shortName,
    object.localizedName,
    object.player?.name,
    object.player?.fullName,
    object.profile?.name
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  if (object.firstName || object.lastName) {
    return `${object.firstName || ""} ${object.lastName || ""}`.trim();
  }
  return "";
}

function pickNumeric(object, paths) {
  for (const path of paths) {
    const value = path.split(".").reduce((current, key) => current?.[key], object);
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function findMatchingPlayer(name, players) {
  const normalized = normalizePlayerName(name);
  return players.find((player) => {
    const options = [player.name, player.displayName, player.name?.split(" ").reverse().join(" ")].filter(Boolean);
    return options.some((option) => {
      const current = normalizePlayerName(option);
      return current === normalized || current.includes(normalized) || normalized.includes(current);
    });
  });
}

function normalizePlayerName(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

function performanceKey(matchId, playerId) {
  return `${matchId}:${playerId}`;
}

function render() {
  if (!state.schedule) return;
  renderSummary();
  renderMatches();
  renderPlayers();
  renderKnockout();
  renderPerformance();
  renderSources();
}

function renderSummary() {
  const { counts, matches, generatedAt, playersMeta } = state.schedule;
  const potential = matches.filter((match) => match.stage !== "group" && match.hasPlaceholder).length;
  els.stats.innerHTML = `
    <div><span>球员</span><strong>${counts.players}</strong></div>
    <div><span>确认相关</span><strong>${counts.trackedConfirmed}</strong></div>
    <div><span>淘汰赛占位</span><strong>${potential}</strong></div>
  `;

  const now = Date.now();
  const next = matches.find((match) => match.isTracked && new Date(match.date).getTime() >= now);
  if (next) {
    const players = names(next.involvedPlayers).slice(0, 4).join("、");
    els.nextMatch.textContent = `下一场 ${formatFull.format(new Date(next.date))}：${teamName(next.homeTeam)} vs ${teamName(next.awayTeam)} · ${players}`;
  } else {
    els.nextMatch.textContent = "当前没有已确认的曼城相关下一场，淘汰赛会随数据更新。";
  }

  els.updatedAt.textContent = `${formatFull.format(new Date(generatedAt))} 更新`;
  els.playerCount.textContent = `${state.players.length} 人`;
  if (playersMeta?.updatedAt) {
    els.playerCount.title = `名单校对日期 ${playersMeta.updatedAt}`;
  }
}

function renderMatches() {
  const matches = filterMatches(
    state.schedule.matches.filter((match) => match.stage === "group" || match.isTracked || match.isPotentialTracked)
  );
  els.scheduleCount.textContent = `${matches.length} 场`;
  renderMatchList(els.matchList, matches);
}

function renderKnockout() {
  const matches = filterBySearch(state.schedule.matches.filter((match) => match.stage !== "group"));
  els.knockoutCount.textContent = `${matches.length} 场`;
  renderMatchList(els.knockoutList, matches);
}

function renderPlayers() {
  const players = state.players
    .filter((player) => {
      if (!state.search) return true;
      return playerMatchesSearch(player);
    })
    .sort((a, b) => a.teamCode.localeCompare(b.teamCode) || a.position.localeCompare(b.position));

  if (!players.length) {
    renderEmpty(els.playerGrid);
    return;
  }

  els.playerGrid.innerHTML = players
    .map(
      (player) => `
      <article class="player-card">
        <div class="player-flag">${player.flag || ""}</div>
        <div class="player-name">
          <strong>${escapeHtml(player.displayName)} <small>${escapeHtml(player.name)}</small></strong>
          <span>${escapeHtml(player.teamNameZh)} · ${escapeHtml(player.clubLabel)}</span>
        </div>
        <div class="position-badge">${escapeHtml(player.position)}</div>
      </article>
    `
    )
    .join("");
}

function renderPerformance() {
  if (!state.schedule || !state.performance) return;
  const matches = performanceMatches();
  els.performanceMatchSelect.innerHTML = matches
    .map((match) => {
      const selected = match.id === state.performanceMatchId ? "selected" : "";
      return `<option value="${escapeHtml(match.id)}" ${selected}>${escapeHtml(performanceMatchLabel(match))}</option>`;
    })
    .join("");

  const match = selectedPerformanceMatch();
  if (!match) {
    els.performanceUpdatedAt.textContent = "--";
    els.performanceSource.textContent = "暂无曼城相关比赛";
    renderEmpty(els.performanceList);
    return;
  }

  const source = state.performance.sourceStatus?.[0];
  const updatedAt = state.performance.generatedAt ? formatFull.format(new Date(state.performance.generatedAt)) : "--";
  els.performanceUpdatedAt.textContent = `${updatedAt} 更新`;
  els.performanceSource.textContent = source?.message || "等待赛后数据";

  const providerRows = new Map(
    (state.performance.rows || [])
      .filter((row) => row.matchId === match.id)
      .map((row) => [performanceKey(row.matchId, row.playerId), row])
  );
  const future = new Date(match.date).getTime() > Date.now();
  const rows = (match.involvedPlayers || [])
    .map((player) => {
      const provider = providerRows.get(performanceKey(match.id, player.id));
      return {
        player,
        rating: provider?.rating ?? null,
        minutes: provider?.minutes ?? null,
        status: provider ? "已更新" : future ? "未开赛" : "待赛后数据"
      };
    })
    .filter((row) => {
      if (!state.search) return true;
      return playerMatchesSearch(row.player);
    })
    .sort((a, b) => {
      const ar = a.rating ?? -1;
      const br = b.rating ?? -1;
      return br - ar || a.player.teamCode.localeCompare(b.player.teamCode);
    });

  if (!rows.length) {
    renderEmpty(els.performanceList);
    return;
  }
  els.performanceList.innerHTML = rows.map(performanceCard).join("");
}

function performanceMatchLabel(match) {
  return `${formatFull.format(new Date(match.date))} ${teamName(match.homeTeam)} vs ${teamName(match.awayTeam)}`;
}

function performanceCard(row) {
  const player = row.player;
  return `
    <article class="performance-card">
      <div class="performance-player">
        <strong>${escapeHtml(player.displayName)} <small>${escapeHtml(player.name)}</small></strong>
        <span>${escapeHtml(player.teamNameZh)} · ${escapeHtml(row.status)}</span>
      </div>
      ${scoreBox(row.rating, "评分", ratingClass(row.rating))}
      ${scoreBox(row.minutes, "分钟", "")}
    </article>
  `;
}

function scoreBox(value, label, className) {
  const display = value == null ? "--" : label === "评分" ? Number(value).toFixed(1) : `${Math.round(Number(value))}`;
  return `
    <div class="score-box ${className}">
      <strong>${escapeHtml(display)}</strong>
      <span>${escapeHtml(label)}</span>
    </div>
  `;
}

function ratingClass(rating) {
  if (rating == null) return "";
  if (rating >= 7.3) return "rating-good";
  if (rating >= 6.3) return "rating-mid";
  return "rating-low";
}

function renderSources() {
  const allSources = [
    ...(state.schedule.sources || []),
    ...(state.performance?.sourceStatus || []).map((source) => ({
      name: source.name,
      ok: source.ok,
      version: "",
      lastReviewed: "",
      lastModified: "",
      detail: source.message
    }))
  ];
  const sourceCards = allSources
    .map((source) => {
      const status = source.ok ? "可用" : `不可用：${source.error || "网络错误"}`;
      const detail = [source.detail, source.version && `版本 ${source.version}`, source.lastReviewed && `校对 ${source.lastReviewed}`, source.lastModified && `修改 ${source.lastModified}`]
        .filter(Boolean)
        .join(" · ");
      return `
        <article class="source-card">
          <strong>${escapeHtml(source.name)} · ${status}</strong>
          <span>${escapeHtml(detail || "备用赛程骨架")}</span>
        </article>
      `;
    })
    .join("");

  const counts = state.schedule.counts;
  els.sourceList.innerHTML = `
    ${sourceCards}
    <article class="source-card">
      <strong>本次同步</strong>
      <span>总赛程 ${counts.totalMatches} 场 · 确认相关 ${counts.trackedConfirmed} 场 · 潜在相关 ${counts.trackedPotential} 场</span>
    </article>
  `;
}

function filterMatches(matches) {
  let result = matches;
  if (state.activeFilter === "tracked") {
    result = result.filter((match) => match.isTracked || match.isPotentialTracked);
  }
  if (state.activeFilter === "departures") {
    result = result.filter((match) =>
      match.involvedPlayers.some((player) => player.clubStatus === "watched_departure")
    );
  }
  if (state.activeFilter === "today") {
    const today = dayKey(new Date());
    result = result.filter((match) => dayKey(new Date(match.date)) === today);
  }
  return filterBySearch(result);
}

function filterBySearch(matches) {
  if (!state.search) return matches;
  return matches.filter((match) => matchMatchesSearch(match));
}

function renderMatchList(container, matches) {
  if (!matches.length) {
    renderEmpty(container);
    return;
  }

  let lastDate = "";
  container.innerHTML = matches
    .map((match) => {
      const currentDate = dayKey(new Date(match.date));
      const divider =
        currentDate !== lastDate
          ? `<div class="date-divider">${formatDate.format(new Date(match.date))}</div>`
          : "";
      lastDate = currentDate;
      return `${divider}${matchCard(match)}`;
    })
    .join("");
}

function matchCard(match) {
  const homePlayers = playerPills(match.homePlayers);
  const awayPlayers = playerPills(match.awayPlayers);
  const potentialPlayers = match.isPotentialTracked ? playerPills(match.potentialPlayers, "potential") : "";
  const statusClass = match.hasPlaceholder
    ? match.isPotentialTracked
      ? "potential"
      : "placeholder"
    : "";
  const statusText = match.hasPlaceholder
    ? match.isPotentialTracked
      ? "可能涉及"
      : "占位"
    : "已确定";
  return `
    <article class="match-card">
      <div class="match-card__bar">
        <span>${formatFull.format(new Date(match.date))} 北京</span>
        <span class="status-pill ${statusClass}">${statusText}</span>
      </div>
      <div class="match-card__body">
        <div class="team-row">
          ${teamBlock(match.homeTeam)}
          <div class="versus">VS</div>
          ${teamBlock(match.awayTeam)}
        </div>
        ${homePlayers || awayPlayers ? `<div class="player-strip">${homePlayers}${awayPlayers}</div>` : ""}
        ${potentialPlayers ? `<div class="player-strip">${potentialPlayers}</div>` : ""}
        <div class="meta-line">
          <span>${escapeHtml(match.stageLabel)}${match.group ? ` · ${escapeHtml(match.group)}组` : ""}</span>
          <span>${escapeHtml(match.city || "城市待定")}</span>
          <span>${escapeHtml(match.source)}</span>
        </div>
      </div>
    </article>
  `;
}

function teamBlock(team) {
  return `
    <div class="team">
      <span class="team__code">${escapeHtml(team?.code || "")}</span>
      <div class="team__name">${escapeHtml(teamName(team))}</div>
    </div>
  `;
}

function playerPills(players, mode = "") {
  return (players || [])
    .slice(0, 8)
    .map((player) => {
      const klass = player.clubStatus === "watched_departure" ? "departure" : "";
      const prefix = mode === "potential" ? "可能 " : "";
      return `<span class="mini-pill ${klass}">${prefix}${escapeHtml(player.displayName)}</span>`;
    })
    .join("");
}

function renderEmpty(container) {
  container.innerHTML = "";
  container.append(els.emptyTemplate.content.cloneNode(true));
}

function teamName(team) {
  if (!team) return "待定";
  return team.nameZh || team.name || team.code || "待定";
}

function names(players) {
  return (players || []).map((player) => player.displayName || player.name);
}

function dayKey(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function matchMatchesSearch(match) {
  const haystack = [
    match.city,
    match.stageLabel,
    match.group,
    teamName(match.homeTeam),
    teamName(match.awayTeam),
    match.homeTeam?.name,
    match.awayTeam?.name,
    ...names(match.involvedPlayers),
    ...names(match.potentialPlayers)
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(state.search);
}

function playerMatchesSearch(player) {
  return [
    player.name,
    player.displayName,
    player.teamCode,
    player.teamName,
    player.teamNameZh,
    player.clubLabel
  ]
    .join(" ")
    .toLowerCase()
    .includes(state.search);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}
