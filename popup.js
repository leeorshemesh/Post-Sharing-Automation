(() => {
  const $ = (id) => document.getElementById(id);

  let state = null;
  let selectedIds = new Set();
  let settingsDirty = false;
  let settingsFocused = false;

  function formatEta(ts) {
    if (!ts) return "";
    const sec = Math.max(0, Math.round((ts - Date.now()) / 1000));
    if (sec < 60) return `${sec}s`;
    return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  }

  function setBusy(busy) {
    ["btn-start", "btn-pause", "btn-resume", "btn-skip", "btn-stop"].forEach((id) => {
      const el = $(id);
      if (!el) return;
      if (busy) el.disabled = true;
    });
  }

  function syncActionButtons() {
    const status = state?.session?.status || "idle";
    const running = status === "running" || status === "waiting";
    $("btn-start").disabled = running;
    $("btn-pause").disabled = !running;
    $("btn-resume").disabled = !(status === "paused" || status === "blocked");
    $("btn-skip").disabled = status !== "waiting";
    $("btn-stop").disabled = status === "idle";
  }

  function renderStatus() {
    if (!state) return;
    const { session, dayStats, settings } = state;
    $("status-label").textContent = (session.status || "idle").toUpperCase();
    $("day-count").textContent = `${dayStats.count} / ${settings.dailyCap} today`;
    $("status-message").textContent =
      session.lastError ||
      session.message ||
      "Add groups, open a Facebook post, then Start.";
    const parts = [];
    if (session.queue?.length) {
      parts.push(`Queue ${session.index}/${session.queue.length}`);
    }
    if (session.sharesThisSession) parts.push(`Shared ${session.sharesThisSession}`);
    if (session.skippedThisSession) parts.push(`Skipped ${session.skippedThisSession}`);
    if (session.currentGroupName) parts.push(`Now: ${session.currentGroupName}`);
    if (session.status === "waiting" && session.nextActionAt) {
      const reason = session.waitReason === "batch_break" ? "Batch break" : "Next share";
      parts.push(`${reason} in ${formatEta(session.nextActionAt)}`);
    }
    $("status-meta").textContent = parts.join(" · ");
    syncActionButtons();
  }

  function renderSetPicker() {
    const active = state?.activeSetId || "california";
    document.querySelectorAll(".set-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-set") === active);
    });
    const count = (state?.groups || []).length;
    const max = state?.maxGroupsPerSet || 100;
    const label = state?.groupSets?.[active]?.name || active;
    $("set-meta").textContent = `${label} · ${count}/${max} groups · same list every run`;
    $("group-count").textContent = `(${count}/${max})`;
  }

  function renderGroups() {
    const list = $("group-list");
    const empty = $("group-empty");
    const groups = state?.groups || [];
    list.innerHTML = "";
    empty.style.display = groups.length ? "none" : "block";
    renderSetPicker();

    for (const g of groups) {
      const li = document.createElement("li");
      const checked = selectedIds.size ? selectedIds.has(g.id) : g.enabled;
      li.innerHTML = `
        <input type="checkbox" data-id="${g.id}" class="pick" ${checked ? "checked" : ""} ${g.enabled ? "" : "disabled"} />
        <div>
          <div class="name">${escapeHtml(g.name)}${g.enabled ? "" : " (disabled)"}</div>
          <div class="url">${escapeHtml(g.url || "")}</div>
        </div>
        <div class="ops">
          <button type="button" data-toggle="${g.id}">${g.enabled ? "Disable" : "Enable"}</button>
          <button type="button" data-del="${g.id}" class="danger">Delete</button>
        </div>
      `;
      list.appendChild(li);
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fillSettings({ force = false } = {}) {
    if (!force && (settingsDirty || settingsFocused)) return;
    const s = state.settings;
    $("delay-min").value = s.delayMinSec;
    $("delay-max").value = s.delayMaxSec;
    $("batch-size").value = s.batchSize;
    $("batch-break-min").value = s.batchBreakMinSec;
    $("batch-break-max").value = s.batchBreakMaxSec;
    $("daily-cap").value = s.dailyCap;
  }

  async function refresh() {
    const res = await chrome.runtime.sendMessage({ type: "FGS_GET_STATE" });
    if (!res?.ok) return;
    state = res;
    if (!selectedIds.size) {
      selectedIds = new Set((state.groups || []).filter((g) => g.enabled).map((g) => g.id));
    }
    renderStatus();
    // Don't rebuild the group list while typing in settings (focus flicker)
    if (!settingsFocused) renderGroups();
    fillSettings();
  }

  async function activeFacebookTab() {
    const tabs = await chrome.tabs.query({
      active: true,
      currentWindow: true,
      url: ["https://www.facebook.com/*", "https://facebook.com/*", "https://m.facebook.com/*"],
    });
    return tabs[0] || null;
  }

  async function switchSet(setId) {
    const res = await chrome.runtime.sendMessage({
      type: "FGS_ACTIVATE_SET",
      setId,
      resetFromFile: false,
    });
    if (!res?.ok) {
      alert(res?.error || "Could not switch set");
      return;
    }
    selectedIds = new Set();
    await refresh();
  }

  document.querySelectorAll(".set-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchSet(btn.getAttribute("data-set")));
  });

  $("btn-reset-set").addEventListener("click", async () => {
    if (!confirm("Reload the active set from its data/groups-*.json file? UI edits for this set will be replaced.")) {
      return;
    }
    const res = await chrome.runtime.sendMessage({ type: "FGS_RESET_SET_FROM_FILE" });
    if (!res?.ok) {
      alert(res?.error || "Reset failed");
      return;
    }
    selectedIds = new Set();
    await refresh();
  });

  $("btn-start").addEventListener("click", async () => {
    setBusy(true);
    try {
      const tab = await activeFacebookTab();
      const res = await chrome.runtime.sendMessage({
        type: "FGS_START",
        groupIds: [...selectedIds],
        tabId: tab?.id ?? null,
        postUrl: tab?.url ?? null,
      });
      if (!res?.ok) alert(res?.error || "Start failed");
      await refresh();
    } finally {
      syncActionButtons();
    }
  });

  $("btn-pause").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "FGS_PAUSE" });
    await refresh();
  });

  $("btn-resume").addEventListener("click", async () => {
    const res = await chrome.runtime.sendMessage({ type: "FGS_RESUME" });
    if (!res?.ok) alert(res?.error || "Resume failed");
    await refresh();
  });

  $("btn-skip").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "FGS_SKIP_WAIT" });
    await refresh();
  });

  $("btn-stop").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "FGS_STOP" });
    await refresh();
  });

  $("add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const groups = await FGS.getGroups();
      if (groups.length >= FGS.MAX_GROUPS_PER_SET) {
        alert(`This set is capped at ${FGS.MAX_GROUPS_PER_SET} groups.`);
        return;
      }
      const group = FGS.normalizeGroup({
        name: $("group-name").value,
        url: $("group-url").value,
        enabled: true,
      });
      groups.push(group);
      await FGS.saveGroups(groups);
      selectedIds.add(group.id);
      $("group-name").value = "";
      $("group-url").value = "";
      await refresh();
    } catch (err) {
      alert(err.message || String(err));
    }
  });

  $("btn-import").addEventListener("click", async () => {
    try {
      const imported = FGS.parseImportLines($("import-text").value);
      if (!imported.length) {
        alert("Nothing to import");
        return;
      }
      const groups = await FGS.getGroups();
      const existingUrls = new Set(groups.map((g) => g.url));
      const existingNames = new Set(groups.map((g) => g.name.toLowerCase()));
      let added = 0;
      for (const g of imported) {
        if (groups.length + added >= FGS.MAX_GROUPS_PER_SET) break;
        if (g.url && existingUrls.has(g.url)) continue;
        if (existingNames.has(g.name.toLowerCase())) continue;
        groups.push(g);
        selectedIds.add(g.id);
        added += 1;
      }
      await FGS.saveGroups(groups);
      $("import-text").value = "";
      await refresh();
      alert(`Imported ${added} group(s).`);
    } catch (err) {
      alert(err.message || String(err));
    }
  });

  $("group-list").addEventListener("click", async (e) => {
    const toggleId = e.target.getAttribute?.("data-toggle");
    const delId = e.target.getAttribute?.("data-del");
    if (toggleId) {
      const groups = await FGS.getGroups();
      const g = groups.find((x) => x.id === toggleId);
      if (g) {
        g.enabled = !g.enabled;
        await FGS.saveGroups(groups);
        if (!g.enabled) selectedIds.delete(g.id);
        else selectedIds.add(g.id);
        await refresh();
      }
    }
    if (delId) {
      let groups = await FGS.getGroups();
      groups = groups.filter((x) => x.id !== delId);
      selectedIds.delete(delId);
      await FGS.saveGroups(groups);
      await refresh();
    }
  });

  $("group-list").addEventListener("change", (e) => {
    const t = e.target;
    if (!t.classList?.contains("pick")) return;
    const id = t.getAttribute("data-id");
    if (t.checked) selectedIds.add(id);
    else selectedIds.delete(id);
  });

  $("select-all").addEventListener("change", () => {
    const on = $("select-all").checked;
    selectedIds = new Set(
      (state?.groups || []).filter((g) => g.enabled && on).map((g) => g.id)
    );
    renderGroups();
  });

  const settingsForm = $("settings-form");
  settingsForm.addEventListener("input", () => {
    settingsDirty = true;
  });
  settingsForm.addEventListener("focusin", () => {
    settingsFocused = true;
  });
  settingsForm.addEventListener("focusout", () => {
    // Defer so clicking Save still counts as focused during submit
    setTimeout(() => {
      settingsFocused = Boolean(settingsForm.contains(document.activeElement));
    }, 0);
  });

  settingsForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const delayMinSec = Number($("delay-min").value);
    const delayMaxSec = Number($("delay-max").value);
    if (delayMinSec > delayMaxSec) {
      alert("Delay min must be ≤ delay max");
      return;
    }
    const batchBreakMinSec = Number($("batch-break-min").value);
    const batchBreakMaxSec = Number($("batch-break-max").value);
    if (batchBreakMinSec > batchBreakMaxSec) {
      alert("Batch break min must be ≤ max");
      return;
    }
    await FGS.saveSettings({
      delayMinSec,
      delayMaxSec,
      batchSize: Number($("batch-size").value),
      batchBreakMinSec,
      batchBreakMaxSec,
      dailyCap: Math.min(100, Number($("daily-cap").value)),
      settingsRevision: 3,
    });
    settingsDirty = false;
    settingsFocused = false;
    await refresh();
    fillSettings({ force: true });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "FGS_STATE") refresh();
  });

  $("btn-export").addEventListener("click", async () => {
    const groups = state?.groups || [];
    const setId = state?.activeSetId || "california";
    const payload = {
      id: setId,
      name: state?.groupSets?.[setId]?.name || setId,
      description: "Exported from extension UI",
      groups: groups.map((g) => ({
        name: g.name,
        url: g.url || "",
      })),
    };
    const text = JSON.stringify(payload, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      alert(
        `Copied ${groups.length} group(s) as JSON.\n\nPaste into data/groups-${setId}.json and commit if you want the file to match.`
      );
    } catch (_) {
      prompt("Copy this JSON:", text);
    }
  });

  refresh();
  setInterval(refresh, 1000);
})();
