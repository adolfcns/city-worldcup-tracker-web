const GOALPULSE_URL = "https://goalpulse.io/data/world-cup-2026.json";
const OPENFOOTBALL_URL =
  "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json";

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
  Curacao: "Curaçao",
  Turkey: "Türkiye"
};

const PLAYERS = require("../data/players.json").players;
const PLAYERS_UPDATED_AT = require("../data/players.json").updatedAt;

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
  try {
    const [goalResult, openResult] = await Promise.allSettled([
      fetchJson(GOALPULSE_URL),
      fetchJson(OPENFOOTBALL_URL)
    ]);

    const sourceStatus = [];
    const goalpulse = goalResult.status === "fulfilled" ? goalResult.value.data : null;
    const openfootball = openResult.status === "fulfilled" ? openResult.value.data : null;

    if (goalpulse) {
      sourceStatus.push({
        name: "GoalPulse",
        ok: true,
        version: goalpulse.version || "",
        lastReviewed: goalpulse.lastReviewed || "",
        lastModified: goalResult.value.lastModified || ""
      });
    } else {
      sourceStatus.push({
        name: "GoalPulse",
        ok: false,
        error: goalResult.reason?.message || "fetch failed"
      });
    }

    if (openfootball) {
      sourceStatus.push({ name: "openfootball", ok: true });
    } else {
      sourceStatus.push({
        name: "openfootball",
        ok: false,
        error: openResult.reason?.message || "fetch failed"
      });
    }

    if (!goalpulse && !openfootball) {
      res.status(502).json({ ok: false, error: "No schedule source is available." });
      return;
    }

    const teamIndex = buildTeamIndex(goalpulse, PLAYERS);
    const goalMatches = goalpulse ? normalizeGoalpulse(goalpulse) : [];
    const openMatches = openfootball ? normalizeOpenFootball(openfootball, teamIndex) : [];
    const merged = goalMatches.length ? enrichWithOpenfootball(goalMatches, openMatches) : openMatches;
    const matches = annotateMatches(merged, { players: PLAYERS }, teamIndex);

    res.status(200).json({
      cachedAt: Date.now(),
      generatedAt: new Date().toISOString(),
      cacheHit: false,
      sources: sourceStatus,
      counts: {
        totalMatches: matches.length,
        trackedConfirmed: matches.filter((match) => match.isTracked).length,
        trackedPotential: matches.filter((match) => match.isPotentialTracked).length,
        players: PLAYERS.length
      },
      playersMeta: { updatedAt: PLAYERS_UPDATED_AT },
      matches
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
};

async function fetchJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "city-worldcup-tracker/0.2" }
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return {
        data: await response.json(),
        lastModified: response.headers.get("last-modified") || ""
      };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 700));
    }
  }
  throw lastError;
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
  return team ? { ...team, placeholder: false } : placeholderTeam(rawName);
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
