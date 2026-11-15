/* Content script: on-page controls + Share-to-group DOM automation */

(() => {
  const BANNER_ID = "fgs-banner";
  const PANEL_ID = "fgs-panel";
  const MAX_STEP_ATTEMPTS = 2;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function visible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function textOf(el) {
    return (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function normalize(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function click(el) {
    if (!el) return false;
    el.scrollIntoView({ block: "center", inline: "nearest" });
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    if (typeof el.click === "function") el.click();
    return true;
  }

  function queryAllDeep(selector, root = document) {
    const results = [];
    const visit = (node) => {
      if (!node) return;
      if (node.querySelectorAll) {
        results.push(...node.querySelectorAll(selector));
      }
      const tree = node.querySelectorAll?.("*") || [];
      for (const el of tree) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(root);
    return results;
  }

  function findByRoleAndName(role, nameRe, root = document) {
    const nodes = queryAllDeep(`[role="${role}"]`, root);
    return nodes.find((el) => visible(el) && nameRe.test(normalize(el.getAttribute("aria-label") || textOf(el))));
  }

  function findClickableByText(patterns, root = document) {
    const list = Array.isArray(patterns) ? patterns : [patterns];
    const candidates = [
      ...queryAllDeep('[role="button"]', root),
      ...queryAllDeep("div[tabindex='0']", root),
      ...queryAllDeep("span[role='button']", root),
      ...queryAllDeep("a[role='link']", root),
      ...queryAllDeep("button", root),
    ];
    for (const el of candidates) {
      if (!visible(el)) continue;
      const label = normalize(el.getAttribute("aria-label") || textOf(el));
      if (!label || label.length > 80) continue;
      if (list.some((re) => re.test(label))) return el;
    }
    return null;
  }

  function detectChallenge() {
    const bodyText = normalize(document.body?.innerText?.slice(0, 8000) || "");
    const checks = [
      /enter the characters you see/i,
      /security check/i,
      /confirm your identity/i,
      /suspicious activity/i,
      /we suspended your account/i,
      /your account has been disabled/i,
      /try again later/i,
      /temporarily blocked/i,
      /checkpoint/i,
      /captcha/i,
    ];
    if (checks.some((re) => re.test(bodyText))) {
      return "Facebook showed a security or rate-limit challenge. Complete it manually, then Resume.";
    }
    if (document.querySelector('iframe[src*="captcha"], iframe[title*="captcha" i]')) {
      return "CAPTCHA detected. Complete it manually, then Resume.";
    }
    return null;
  }

  async function waitFor(fn, { timeout = 12000, interval = 300 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const challenge = detectChallenge();
      if (challenge) {
        const err = new Error(challenge);
        err.blocked = true;
        throw err;
      }
      const value = fn();
      if (value) return value;
      await sleep(interval);
    }
    return null;
  }

  async function closeOpenDialogs() {
    for (let i = 0; i < 3; i++) {
      const close =
        findClickableByText([/^close$/, /^dismiss$/]) ||
        findByRoleAndName("button", /^close$/);
      if (!close) break;
      click(close);
      await sleep(400);
    }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(300);
  }

  function findShareButton() {
    // Prefer Share near the article/feed unit in view
    const articles = [...document.querySelectorAll('[role="article"]')].filter(visible);
    const scopes = articles.length ? articles : [document];
    for (const scope of scopes) {
      const btn =
        findClickableByText([/^share$/, /^send$/], scope) ||
        findByRoleAndName("button", /^share$/, scope);
      if (btn) return btn;
    }
    return (
      findClickableByText([/^share$/]) ||
      findByRoleAndName("button", /^share$/)
    );
  }

  function findShareToGroupOption() {
    return (
      findClickableByText([
        /share to (a )?group/,
        /^group$/,
        /share in a group/,
        /post to a group/,
      ]) || findByRoleAndName("menuitem", /group/)
    );
  }

  function findGroupSearchInput() {
    const dialogs = queryAllDeep('[role="dialog"]');
    const roots = dialogs.length ? dialogs : [document];
    for (const root of roots) {
      const inputs = [
        ...queryAllDeep('input[type="search"]', root),
        ...queryAllDeep('input[type="text"]', root),
        ...queryAllDeep('[contenteditable="true"]', root),
        ...queryAllDeep('input[aria-label]', root),
      ].filter(visible);
      const match = inputs.find((el) => {
        const label = normalize(el.getAttribute("aria-label") || el.getAttribute("placeholder") || "");
        return /search|group/.test(label) || el.getAttribute("type") === "search";
      });
      if (match) return match;
      if (inputs[0]) return inputs[0];
    }
    return null;
  }

  async function typeInto(el, text) {
    el.focus();
    if (el.isContentEditable) {
      el.textContent = "";
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
      document.execCommand?.("selectAll", false);
      document.execCommand?.("insertText", false, text);
    } else {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await sleep(500);
  }

  function findGroupResult(groupName) {
    const target = normalize(groupName);
    const dialogs = queryAllDeep('[role="dialog"]');
    const roots = dialogs.length ? dialogs : [document];
    for (const root of roots) {
      const options = [
        ...queryAllDeep('[role="option"]', root),
        ...queryAllDeep('[role="listitem"]', root),
        ...queryAllDeep('[role="row"]', root),
        ...queryAllDeep('[role="button"]', root),
        ...queryAllDeep('div[tabindex="0"]', root),
      ].filter(visible);

      let best = null;
      let bestScore = 0;
      for (const el of options) {
        const label = normalize(el.getAttribute("aria-label") || textOf(el));
        if (!label || label.length > 120) continue;
        if (label === target) return el;
        if (label.includes(target) || target.includes(label)) {
          const score = Math.min(label.length, target.length);
          if (score > bestScore) {
            best = el;
            bestScore = score;
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  function findPostConfirmButton() {
    return (
      findClickableByText([/^post$/, /^share$/, /^publish$/, /^send$/]) ||
      findByRoleAndName("button", /^(post|share|publish|send)$/)
    );
  }

  async function runShareOnce(group) {
    const challenge = detectChallenge();
    if (challenge) return { ok: false, blocked: true, error: challenge };

    for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
      try {
        await closeOpenDialogs();
        await sleep(400);

        const shareBtn = await waitFor(() => findShareButton(), { timeout: 10000 });
        if (!shareBtn) throw new Error("Could not find the Share button on this post.");
        click(shareBtn);
        await sleep(900);

        const groupOpt = await waitFor(() => findShareToGroupOption(), { timeout: 10000 });
        if (!groupOpt) throw new Error('Could not find "Share to a group". Open Share manually once to check the UI.');
        click(groupOpt);
        await sleep(1100);

        const search = await waitFor(() => findGroupSearchInput(), { timeout: 10000 });
        if (!search) throw new Error("Could not find the group search field.");
        await typeInto(search, group.name);
        await sleep(1200);

        const result = await waitFor(() => findGroupResult(group.name), { timeout: 12000 });
        if (!result) throw new Error(`Could not find group "${group.name}" in search results.`);
        click(result);
        await sleep(900);

        const postBtn = await waitFor(() => findPostConfirmButton(), { timeout: 10000 });
        if (!postBtn) throw new Error("Could not find the final Post/Share button.");
        click(postBtn);
        await sleep(1500);

        const after = detectChallenge();
        if (after) return { ok: false, blocked: true, error: after };

        await sleep(600);
        await closeOpenDialogs();
        return { ok: true, groupId: group.id, groupName: group.name };
      } catch (err) {
        if (err.blocked || /challenge|captcha|blocked|suspended/i.test(err.message || "")) {
          return { ok: false, blocked: true, error: err.message };
        }
        if (attempt >= MAX_STEP_ATTEMPTS) {
          return { ok: false, blocked: false, error: err.message || String(err) };
        }
        await closeOpenDialogs();
        await sleep(800);
      }
    }
    return { ok: false, error: "Share failed after retries." };
  }

  function ensureBanner() {
    let el = document.getElementById(BANNER_ID);
    if (el) return el;
    el = document.createElement("div");
    el.id = BANNER_ID;
    el.innerHTML = `
      <div class="fgs-banner-inner">
        <strong class="fgs-banner-title">Group Share</strong>
        <span class="fgs-banner-msg"></span>
        <span class="fgs-banner-meta"></span>
        <div class="fgs-banner-actions">
          <button type="button" data-act="pause">Pause</button>
          <button type="button" data-act="resume">Resume</button>
          <button type="button" data-act="skip">Skip wait</button>
          <button type="button" data-act="stop">Stop</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(el);
    el.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const act = btn.getAttribute("data-act");
      if (act === "pause") chrome.runtime.sendMessage({ type: "FGS_PAUSE" });
      if (act === "resume") chrome.runtime.sendMessage({ type: "FGS_RESUME" });
      if (act === "skip") chrome.runtime.sendMessage({ type: "FGS_SKIP_WAIT" });
      if (act === "stop") chrome.runtime.sendMessage({ type: "FGS_STOP" });
    });
    return el;
  }

  function formatEta(ts) {
    if (!ts) return "";
    const sec = Math.max(0, Math.round((ts - Date.now()) / 1000));
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m ${s}s`;
  }

  function renderBanner(state) {
    const session = state?.session;
    if (!session || session.status === "idle") {
      const existing = document.getElementById(BANNER_ID);
      if (existing) existing.remove();
      return;
    }
    const el = ensureBanner();
    el.dataset.status = session.status;
    const msg = el.querySelector(".fgs-banner-msg");
    const meta = el.querySelector(".fgs-banner-meta");
    const title = el.querySelector(".fgs-banner-title");
    title.textContent = `Group Share · ${session.status}`;
    msg.textContent = session.message || session.lastError || "";
    const used = state.dayStats?.count ?? 0;
    const cap = state.settings?.dailyCap ?? 100;
    const idx = session.index ?? 0;
    const total = session.queue?.length ?? 0;
    let eta = "";
    if (session.status === "waiting" && session.nextActionAt) {
      const reason = session.waitReason === "batch_break" ? "batch break" : "next share";
      eta = ` · ${reason} in ${formatEta(session.nextActionAt)}`;
    }
    meta.textContent = `${idx}/${total} queue · ${used}/${cap} today${eta}`;
  }

  function ensureLauncher() {
    if (document.getElementById(PANEL_ID)) return;
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <button type="button" id="fgs-launch" title="Share this post to your saved groups">Share to my groups</button>
    `;
    document.documentElement.appendChild(panel);
    panel.querySelector("#fgs-launch").addEventListener("click", async () => {
      const btn = panel.querySelector("#fgs-launch");
      btn.disabled = true;
      btn.textContent = "Starting…";
      try {
        const res = await chrome.runtime.sendMessage({
          type: "FGS_START",
          postUrl: location.href,
        });
        if (!res?.ok) {
          alert(res?.error || "Could not start");
        }
      } catch (err) {
        alert(String(err.message || err));
      } finally {
        btn.disabled = false;
        btn.textContent = "Share to my groups";
      }
    });
  }

  async function refreshState() {
    try {
      const state = await chrome.runtime.sendMessage({ type: "FGS_GET_STATE" });
      if (state?.ok) renderBanner(state);
    } catch (_) {
      /* ignore */
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "FGS_SHARE_TO_GROUP") {
      runShareOnce(message.group).then(sendResponse);
      return true;
    }
    if (message?.type === "FGS_STATE") {
      refreshState();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  ensureLauncher();
  refreshState();
  setInterval(refreshState, 5000);
})();
