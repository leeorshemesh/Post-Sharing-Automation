/* Shared constants and storage helpers for Facebook Group Share */

const FGS = (() => {
  const MAX_GROUPS_PER_SET = 100;

  const GROUP_SETS = {
    california: {
      id: "california",
      name: "California",
      file: "data/groups-california.json",
    },
    us: {
      id: "us",
      name: "Whole US",
      file: "data/groups-us.json",
    },
  };

  // Still paced like a careful human, but not glacial.
  // ~40–75s between groups + short break every 12 ≈ ~1.5–2.5h for 100 shares.
  const SETTINGS_REVISION = 2;
  const DEFAULT_SETTINGS = {
    settingsRevision: SETTINGS_REVISION,
    delayMinSec: 40,
    delayMaxSec: 75,
    batchSize: 12,
    batchBreakMinSec: 3 * 60,
    batchBreakMaxSec: 6 * 60,
    dailyCap: 100,
  };

  function isLegacyV1Timing(settings) {
    if (!settings) return false;
    return (
      settings.delayMinSec === 90 &&
      settings.delayMaxSec === 180 &&
      settings.batchSize === 10 &&
      settings.batchBreakMinSec === 8 * 60 &&
      settings.batchBreakMaxSec === 15 * 60
    );
  }

  const SESSION_IDLE = {
    status: "idle", // idle | running | paused | blocked | waiting | done
    queue: [],
    index: 0,
    tabId: null,
    postUrl: null,
    currentGroupId: null,
    currentGroupName: null,
    sharesThisSession: 0,
    sharesSinceBatch: 0,
    nextActionAt: null,
    waitReason: null,
    lastError: null,
    message: "",
  };

  function todayKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function randomBetween(min, max) {
    const a = Math.min(min, max);
    const b = Math.max(min, max);
    return Math.floor(a + Math.random() * (b - a + 1));
  }

  function uid() {
    return `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function parseGroupUrl(url) {
    if (!url) return null;
    const trimmed = String(url).trim();
    try {
      const u = new URL(trimmed.startsWith("http") ? trimmed : `https://www.facebook.com/${trimmed}`);
      const parts = u.pathname.split("/").filter(Boolean);
      const groupsIdx = parts.indexOf("groups");
      if (groupsIdx >= 0 && parts[groupsIdx + 1]) {
        return {
          slug: parts[groupsIdx + 1],
          url: `https://www.facebook.com/groups/${parts[groupsIdx + 1]}`,
        };
      }
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  function normalizeGroup(input) {
    const name = (input.name || "").trim();
    const rawUrl = (input.url || "").trim();
    const parsed = parseGroupUrl(rawUrl);
    if (!name) throw new Error("Group name is required");
    return {
      id: input.id || uid(),
      name,
      url: parsed ? parsed.url : rawUrl,
      slug: parsed ? parsed.slug : "",
      enabled: input.enabled !== false,
    };
  }

  function capGroups(groups) {
    const list = Array.isArray(groups) ? groups : [];
    if (list.length <= MAX_GROUPS_PER_SET) return list;
    return list.slice(0, MAX_GROUPS_PER_SET);
  }

  function parseImportLines(text) {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const groups = [];
    for (const line of lines) {
      let name = "";
      let url = "";
      if (line.includes("|")) {
        const [n, ...rest] = line.split("|");
        name = n.trim();
        url = rest.join("|").trim();
      } else if (line.includes("\t")) {
        const [n, ...rest] = line.split("\t");
        name = n.trim();
        url = rest.join("\t").trim();
      } else if (/facebook\.com\/groups\//i.test(line)) {
        url = line;
        const parsed = parseGroupUrl(line);
        name = parsed ? parsed.slug.replace(/-/g, " ") : line;
      } else {
        name = line;
      }
      groups.push(normalizeGroup({ name, url, enabled: true }));
    }
    return capGroups(groups);
  }

  async function getStorage(keys) {
    return chrome.storage.local.get(keys);
  }

  async function setStorage(obj) {
    return chrome.storage.local.set(obj);
  }

  async function getSettings() {
    const { settings } = await getStorage(["settings"]);
    let merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };

    // One-time migrate from the original slow defaults (keep custom user timings)
    const rev = settings?.settingsRevision || 0;
    if (rev < SETTINGS_REVISION && (!settings || isLegacyV1Timing(settings))) {
      merged = {
        ...merged,
        delayMinSec: DEFAULT_SETTINGS.delayMinSec,
        delayMaxSec: DEFAULT_SETTINGS.delayMaxSec,
        batchSize: DEFAULT_SETTINGS.batchSize,
        batchBreakMinSec: DEFAULT_SETTINGS.batchBreakMinSec,
        batchBreakMaxSec: DEFAULT_SETTINGS.batchBreakMaxSec,
        settingsRevision: SETTINGS_REVISION,
      };
      await setStorage({ settings: merged });
    } else if (rev < SETTINGS_REVISION) {
      merged = { ...merged, settingsRevision: SETTINGS_REVISION };
      await setStorage({ settings: merged });
    }

    return merged;
  }

  async function saveSettings(partial) {
    const current = await getSettings();
    const next = { ...current, ...partial };
    await setStorage({ settings: next });
    return next;
  }

  async function getActiveSetId() {
    const { activeSetId } = await getStorage(["activeSetId"]);
    return GROUP_SETS[activeSetId] ? activeSetId : "california";
  }

  async function getGroupsBySet() {
    const { groupsBySet } = await getStorage(["groupsBySet"]);
    return groupsBySet && typeof groupsBySet === "object" ? groupsBySet : {};
  }

  async function fetchBundledSet(setId) {
    const meta = GROUP_SETS[setId];
    if (!meta) throw new Error(`Unknown set: ${setId}`);
    const url = chrome.runtime.getURL(meta.file);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load ${meta.file}`);
    const data = await res.json();
    const raw = Array.isArray(data.groups) ? data.groups : [];
    const groups = capGroups(
      raw.map((g, i) =>
        normalizeGroup({
          id: g.id || `${setId}_${i}_${(g.name || "g").toLowerCase().replace(/\s+/g, "_").slice(0, 24)}`,
          name: g.name,
          url: g.url || "",
          enabled: g.enabled !== false,
        })
      )
    );
    return {
      id: data.id || setId,
      name: data.name || meta.name,
      description: data.description || "",
      groups,
    };
  }

  async function getGroups() {
    const { groups } = await getStorage(["groups"]);
    return Array.isArray(groups) ? groups : [];
  }

  async function saveGroups(groups) {
    const capped = capGroups(groups);
    const activeSetId = await getActiveSetId();
    const groupsBySet = await getGroupsBySet();
    groupsBySet[activeSetId] = capped;
    await setStorage({ groups: capped, groupsBySet, activeSetId });
    return capped;
  }

  async function activateSet(setId, { resetFromFile = false } = {}) {
    if (!GROUP_SETS[setId]) throw new Error(`Unknown set: ${setId}`);
    const groupsBySet = await getGroupsBySet();
    let groups;

    if (resetFromFile || !Array.isArray(groupsBySet[setId])) {
      const bundled = await fetchBundledSet(setId);
      groups = bundled.groups;
      groupsBySet[setId] = groups;
    } else {
      groups = capGroups(groupsBySet[setId]);
    }

    await setStorage({
      activeSetId: setId,
      groups,
      groupsBySet,
    });
    return { setId, groups, meta: GROUP_SETS[setId] };
  }

  async function resetActiveSetFromFile() {
    const setId = await getActiveSetId();
    return activateSet(setId, { resetFromFile: true });
  }

  async function ensureSetsInitialized() {
    const { setsInitialized, activeSetId, groups } = await getStorage([
      "setsInitialized",
      "activeSetId",
      "groups",
    ]);
    if (setsInitialized && Array.isArray(groups)) {
      return { activeSetId: activeSetId || "california", groups };
    }

    const groupsBySet = {};
    for (const id of Object.keys(GROUP_SETS)) {
      const bundled = await fetchBundledSet(id);
      groupsBySet[id] = bundled.groups;
    }
    const chosen = GROUP_SETS[activeSetId] ? activeSetId : "california";
    await setStorage({
      setsInitialized: true,
      activeSetId: chosen,
      groupsBySet,
      groups: groupsBySet[chosen] || [],
      settings: (await getSettings()),
      session: SESSION_IDLE,
    });
    return { activeSetId: chosen, groups: groupsBySet[chosen] || [] };
  }

  async function getDayStats() {
    const key = todayKey();
    const { dayStats } = await getStorage(["dayStats"]);
    if (!dayStats || dayStats.date !== key) {
      const fresh = { date: key, count: 0 };
      await setStorage({ dayStats: fresh });
      return fresh;
    }
    return dayStats;
  }

  async function incrementDayCount(by = 1) {
    const stats = await getDayStats();
    const next = { date: todayKey(), count: stats.count + by };
    await setStorage({ dayStats: next });
    return next;
  }

  async function getSession() {
    const { session } = await getStorage(["session"]);
    return { ...SESSION_IDLE, ...(session || {}) };
  }

  async function saveSession(partial) {
    const current = await getSession();
    const next = { ...current, ...partial };
    await setStorage({ session: next });
    return next;
  }

  async function resetSession(extra = {}) {
    const next = { ...SESSION_IDLE, ...extra };
    await setStorage({ session: next });
    return next;
  }

  async function getSnapshot() {
    await ensureSetsInitialized();
    const [settings, groups, dayStats, session, activeSetId, groupsBySet] = await Promise.all([
      getSettings(),
      getGroups(),
      getDayStats(),
      getSession(),
      getActiveSetId(),
      getGroupsBySet(),
    ]);
    return {
      settings,
      groups,
      dayStats,
      session,
      activeSetId,
      groupsBySet,
      groupSets: GROUP_SETS,
      maxGroupsPerSet: MAX_GROUPS_PER_SET,
    };
  }

  return {
    DEFAULT_SETTINGS,
    SESSION_IDLE,
    GROUP_SETS,
    MAX_GROUPS_PER_SET,
    todayKey,
    randomBetween,
    uid,
    parseGroupUrl,
    normalizeGroup,
    parseImportLines,
    capGroups,
    getStorage,
    setStorage,
    getSettings,
    saveSettings,
    getActiveSetId,
    getGroupsBySet,
    fetchBundledSet,
    getGroups,
    saveGroups,
    activateSet,
    resetActiveSetFromFile,
    ensureSetsInitialized,
    getDayStats,
    incrementDayCount,
    getSession,
    saveSession,
    resetSession,
    getSnapshot,
  };
})();

if (typeof globalThis !== "undefined") {
  globalThis.FGS = FGS;
}
