/* Service worker: queue, delays, daily cap, batch breaks */

importScripts("shared.js");

const ALARM_NEXT = "fgs_next_action";

async function broadcast(message) {
  try {
    await chrome.runtime.sendMessage(message);
  } catch (_) {
    /* popup may be closed */
  }
  const session = await FGS.getSession();
  if (session.tabId != null) {
    try {
      await chrome.tabs.sendMessage(session.tabId, message);
    } catch (_) {
      /* tab may not have content script */
    }
  }
}

async function clearNextAlarm() {
  clearShortTimer();
  await chrome.alarms.clear(ALARM_NEXT);
}

let shortTimer = null;

function clearShortTimer() {
  if (shortTimer != null) {
    clearTimeout(shortTimer);
    shortTimer = null;
  }
}

async function scheduleNext(delayMs, reason) {
  const ms = Math.max(1000, delayMs);
  const at = Date.now() + ms;
  await FGS.saveSession({
    status: "waiting",
    nextActionAt: at,
    waitReason: reason || "delay",
    lastError: null,
  });
  await clearNextAlarm();
  clearShortTimer();
  // Chrome may coerce very short alarms; use a timer for sub-minute waits while SW is awake.
  if (ms < 55_000) {
    shortTimer = setTimeout(async () => {
      shortTimer = null;
      const session = await FGS.getSession();
      if (session.status !== "waiting" && session.status !== "running") return;
      if (session.waitReason === "batch_break") {
        await FGS.saveSession({ waitReason: "batch_break_done", status: "running" });
      } else {
        await FGS.saveSession({ status: "running", waitReason: null });
      }
      await processNext();
    }, ms);
  } else {
    chrome.alarms.create(ALARM_NEXT, { when: at });
  }
  await broadcast({ type: "FGS_STATE" });
}

async function findFacebookTab() {
  const tabs = await chrome.tabs.query({
    url: ["https://www.facebook.com/*", "https://facebook.com/*", "https://m.facebook.com/*"],
  });
  const active = tabs.find((t) => t.active) || tabs[0];
  return active || null;
}

async function sendShareCommand(tabId, group) {
  return chrome.tabs.sendMessage(tabId, {
    type: "FGS_SHARE_TO_GROUP",
    group,
  });
}

async function pauseSession(reason, status = "paused") {
  await clearNextAlarm();
  await FGS.saveSession({
    status,
    waitReason: reason || null,
    nextActionAt: null,
    lastError: reason || null,
  });
  await broadcast({ type: "FGS_STATE" });
}

async function stopSession(message) {
  await clearNextAlarm();
  await FGS.resetSession({
    status: "idle",
    message: message || "Stopped",
  });
  await broadcast({ type: "FGS_STATE" });
}

async function finishSession(message) {
  await clearNextAlarm();
  await FGS.saveSession({
    status: "done",
    nextActionAt: null,
    waitReason: null,
    currentGroupId: null,
    currentGroupName: null,
    message: message || "Done",
  });
  await broadcast({ type: "FGS_STATE" });
}

async function processNext() {
  const [settings, dayStats, session] = await Promise.all([
    FGS.getSettings(),
    FGS.getDayStats(),
    FGS.getSession(),
  ]);

  if (session.status !== "running" && session.status !== "waiting") {
    return;
  }

  if (dayStats.count >= settings.dailyCap) {
    await finishSession(`Daily cap reached (${settings.dailyCap}).`);
    return;
  }

  if (session.index >= session.queue.length) {
    await finishSession("All selected groups processed.");
    return;
  }

  // Batch break after every N successful shares in this session
  if (
    session.sharesSinceBatch > 0 &&
    session.sharesSinceBatch % settings.batchSize === 0 &&
    session.waitReason !== "batch_break_done"
  ) {
    const breakSec = FGS.randomBetween(settings.batchBreakMinSec, settings.batchBreakMaxSec);
    await FGS.saveSession({ sharesSinceBatch: 0, waitReason: "batch_break" });
    await scheduleNext(breakSec * 1000, "batch_break");
    return;
  }

  const group = session.queue[session.index];
  let tabId = session.tabId;
  if (tabId == null) {
    const tab = await findFacebookTab();
    if (!tab) {
      await pauseSession("No Facebook tab found. Open the post and Resume.", "blocked");
      return;
    }
    tabId = tab.id;
    await FGS.saveSession({ tabId });
  }

  await FGS.saveSession({
    status: "running",
    currentGroupId: group.id,
    currentGroupName: group.name,
    nextActionAt: null,
    waitReason: null,
    lastError: null,
    message: `Sharing to ${group.name}…`,
  });
  await broadcast({ type: "FGS_STATE" });

  let result;
  try {
    result = await sendShareCommand(tabId, group);
  } catch (err) {
    await pauseSession(
      "Could not reach the Facebook tab. Keep the post tab open, then Resume.",
      "blocked"
    );
    return;
  }

  if (!result || !result.ok) {
    const reason = (result && result.error) || "Share step failed";
    const blocked = result && result.blocked;
    await FGS.saveSession({ lastError: reason });
    await pauseSession(reason, blocked ? "blocked" : "paused");
    return;
  }

  const newStats = await FGS.incrementDayCount(1);
  const nextIndex = session.index + 1;
  const sharesThisSession = (session.sharesThisSession || 0) + 1;
  const sharesSinceBatch = (session.sharesSinceBatch || 0) + 1;

  await FGS.saveSession({
    index: nextIndex,
    sharesThisSession,
    sharesSinceBatch,
    currentGroupId: null,
    currentGroupName: null,
    message: `Shared to ${group.name}`,
    lastError: null,
  });

  if (newStats.count >= settings.dailyCap) {
    await finishSession(`Daily cap reached (${settings.dailyCap}).`);
    return;
  }

  if (nextIndex >= session.queue.length) {
    await finishSession("All selected groups processed.");
    return;
  }

  // After a full batch, take a long break before the next share
  if (sharesSinceBatch % settings.batchSize === 0) {
    const breakSec = FGS.randomBetween(settings.batchBreakMinSec, settings.batchBreakMaxSec);
    await FGS.saveSession({ sharesSinceBatch: 0 });
    await scheduleNext(breakSec * 1000, "batch_break");
    return;
  }

  const delaySec = FGS.randomBetween(settings.delayMinSec, settings.delayMaxSec);
  await scheduleNext(delaySec * 1000, "inter_group");
}

async function startSession({ groupIds, tabId, postUrl }) {
  const [settings, groups, dayStats, existing] = await Promise.all([
    FGS.getSettings(),
    FGS.getGroups(),
    FGS.getDayStats(),
    FGS.getSession(),
  ]);

  if (existing.status === "running" || existing.status === "waiting") {
    return { ok: false, error: "A session is already running. Pause or Stop it first." };
  }

  const remaining = settings.dailyCap - dayStats.count;
  if (remaining <= 0) {
    return { ok: false, error: `Daily cap of ${settings.dailyCap} already reached.` };
  }

  let selected = groups.filter((g) => g.enabled);
  if (Array.isArray(groupIds) && groupIds.length) {
    const set = new Set(groupIds);
    selected = groups.filter((g) => set.has(g.id));
  }
  if (!selected.length) {
    return { ok: false, error: "No groups selected. Enable or select groups in the popup." };
  }

  const queue = selected.slice(0, remaining);
  let resolvedTabId = tabId;
  let resolvedPostUrl = postUrl || null;

  if (resolvedTabId == null) {
    const tab = await findFacebookTab();
    if (!tab) {
      return { ok: false, error: "Open a Facebook post tab first." };
    }
    resolvedTabId = tab.id;
    resolvedPostUrl = tab.url || null;
  }

  await clearNextAlarm();
  await FGS.saveSession({
    status: "running",
    queue,
    index: 0,
    tabId: resolvedTabId,
    postUrl: resolvedPostUrl,
    currentGroupId: null,
    currentGroupName: null,
    sharesThisSession: 0,
    sharesSinceBatch: 0,
    nextActionAt: null,
    waitReason: null,
    lastError: null,
    message: `Starting — ${queue.length} group(s), ${dayStats.count}/${settings.dailyCap} used today`,
  });

  await broadcast({ type: "FGS_STATE" });
  // Small human-like delay before first share
  await scheduleNext(FGS.randomBetween(2, 4) * 1000, "start_delay");
  return { ok: true, queued: queue.length };
}

async function resumeSession() {
  const session = await FGS.getSession();
  if (session.status !== "paused" && session.status !== "blocked" && session.status !== "waiting") {
    return { ok: false, error: "Nothing to resume." };
  }
  if (session.index >= session.queue.length) {
    await finishSession("All selected groups processed.");
    return { ok: true };
  }
  await FGS.saveSession({
    status: "running",
    lastError: null,
    waitReason: null,
    message: "Resuming…",
  });
  await broadcast({ type: "FGS_STATE" });
  await scheduleNext(FGS.randomBetween(1, 3) * 1000, "resume_delay");
  return { ok: true };
}

chrome.runtime.onInstalled.addListener(async () => {
  const { settings, session } = await FGS.getStorage(["settings", "session"]);
  if (!settings) await FGS.setStorage({ settings: FGS.DEFAULT_SETTINGS });
  if (!session) await FGS.setStorage({ session: FGS.SESSION_IDLE });
  await FGS.ensureSetsInitialized();
});

chrome.runtime.onStartup.addListener(async () => {
  await FGS.ensureSetsInitialized();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NEXT) return;
  const session = await FGS.getSession();
  if (session.status !== "waiting" && session.status !== "running") return;
  if (session.waitReason === "batch_break") {
    await FGS.saveSession({ waitReason: "batch_break_done", status: "running" });
  } else {
    await FGS.saveSession({ status: "running", waitReason: null });
  }
  await processNext();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "FGS_GET_STATE": {
        sendResponse({ ok: true, ...(await FGS.getSnapshot()) });
        break;
      }
      case "FGS_START": {
        const tabId = message.tabId ?? sender.tab?.id ?? null;
        const postUrl = message.postUrl ?? sender.tab?.url ?? null;
        sendResponse(await startSession({ groupIds: message.groupIds, tabId, postUrl }));
        break;
      }
      case "FGS_PAUSE": {
        await pauseSession(message.reason || "Paused by you");
        sendResponse({ ok: true });
        break;
      }
      case "FGS_RESUME": {
        sendResponse(await resumeSession());
        break;
      }
      case "FGS_STOP": {
        await stopSession("Stopped by you");
        sendResponse({ ok: true });
        break;
      }
      case "FGS_SKIP_WAIT": {
        // User skips remaining delay / batch break
        const session = await FGS.getSession();
        if (session.status === "waiting") {
          await clearNextAlarm();
          await FGS.saveSession({ status: "running", waitReason: "batch_break_done", nextActionAt: null });
          await processNext();
        }
        sendResponse({ ok: true });
        break;
      }
      case "FGS_STEP": {
        if (message.message) {
          await FGS.saveSession({ message: message.message });
          await broadcast({ type: "FGS_STATE" });
        }
        sendResponse({ ok: true });
        break;
      }
      case "FGS_ACTIVATE_SET": {
        const session = await FGS.getSession();
        if (session.status === "running" || session.status === "waiting") {
          sendResponse({ ok: false, error: "Pause or Stop the session before switching sets." });
          break;
        }
        const result = await FGS.activateSet(message.setId, {
          resetFromFile: Boolean(message.resetFromFile),
        });
        await broadcast({ type: "FGS_STATE" });
        sendResponse({ ok: true, ...result });
        break;
      }
      case "FGS_RESET_SET_FROM_FILE": {
        const session = await FGS.getSession();
        if (session.status === "running" || session.status === "waiting") {
          sendResponse({ ok: false, error: "Pause or Stop the session before resetting the set." });
          break;
        }
        const result = await FGS.resetActiveSetFromFile();
        await broadcast({ type: "FGS_STATE" });
        sendResponse({ ok: true, ...result });
        break;
      }
      default:
        sendResponse({ ok: false, error: "Unknown message" });
    }
  })().catch((err) => {
    sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
  });
  return true;
});
