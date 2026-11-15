/* Content script: on-page controls + Share-to-group DOM automation */

(() => {
  const BANNER_ID = "fgs-banner";
  const PANEL_ID = "fgs-panel";
  const MAX_STEP_ATTEMPTS = 2;

  let lastState = null;
  let countdownTimer = null;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function visible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
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

  function labelOf(el) {
    if (!el) return "";
    return normalize(
      el.getAttribute?.("aria-label") ||
        el.getAttribute?.("title") ||
        el.getAttribute?.("placeholder") ||
        textOf(el)
    );
  }

  async function reportStep(message) {
    try {
      await chrome.runtime.sendMessage({ type: "FGS_STEP", message });
    } catch (_) {
      /* ignore */
    }
    const banner = document.getElementById(BANNER_ID);
    const msg = banner?.querySelector?.(".fgs-banner-msg");
    if (msg) msg.textContent = message;
  }

  function hrefOf(el) {
    const a = el?.closest?.("a[href]") || (el?.tagName === "A" ? el : null);
    return a?.getAttribute?.("href") || "";
  }

  function isNavigatingLink(el) {
    const href = hrefOf(el);
    if (!href || href === "#" || href.startsWith("javascript:")) return false;
    try {
      const u = new URL(href, location.href);
      // External site — never click
      if (u.origin !== location.origin) return true;
      // Different Facebook path (would leave this post view)
      if (u.pathname !== location.pathname || u.search !== location.search) return true;
    } catch (_) {
      return true;
    }
    return false;
  }

  function click(el) {
    if (!el) return false;
    if (isNavigatingLink(el)) {
      console.warn("[FGS] Refusing to click navigating link:", hrefOf(el));
      return false;
    }
    el.scrollIntoView({ block: "center", inline: "nearest" });
    const rect = el.getBoundingClientRect();
    const x = rect.left + Math.min(rect.width / 2, 20);
    const y = rect.top + Math.min(rect.height / 2, 12);
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    el.dispatchEvent(new PointerEvent("pointerover", opts));
    el.dispatchEvent(new MouseEvent("mouseover", opts));
    el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, buttons: 1 }));
    el.dispatchEvent(new MouseEvent("mousedown", { ...opts, buttons: 1 }));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    // Prefer dispatch-only for controls that might be wrapped in links
    if (typeof el.click === "function" && !el.closest?.("a[href]")) el.click();
    return true;
  }

  function queryAll(selector, root = document) {
    try {
      return [...(root.querySelectorAll?.(selector) || [])];
    } catch (_) {
      return [];
    }
  }

  function dialogs() {
    return queryAll('[role="dialog"]').filter(visible);
  }

  function menus() {
    return [
      ...queryAll('[role="menu"]'),
      ...queryAll('[role="listbox"]'),
      ...dialogs(),
    ].filter(visible);
  }

  function findClickables(root = document) {
    // Intentionally avoid blanket a[href] — those navigate away from the post
    return [
      ...queryAll('[role="button"]', root),
      ...queryAll('[role="menuitem"]', root),
      ...queryAll('[role="menuitemradio"]', root),
      ...queryAll('[role="option"]', root),
      ...queryAll("div[tabindex='0']", root),
      ...queryAll("span[role='button']", root),
      ...queryAll("button", root),
    ].filter((el) => visible(el) && !isNavigatingLink(el));
  }

  function pickBest(candidates, scoreFn) {
    let best = null;
    let bestScore = 0;
    for (const el of candidates) {
      const score = scoreFn(el);
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return bestScore > 0 ? best : null;
  }

  function findByLabel(patterns, root = document, { maxLen = 100 } = {}) {
    const list = Array.isArray(patterns) ? patterns : [patterns];
    return pickBest(findClickables(root), (el) => {
      const label = labelOf(el);
      if (!label || label.length > maxLen) return 0;
      for (const re of list) {
        if (re.test(label)) {
          // Prefer shorter, more specific controls
          return 1000 - Math.min(label.length, 200) + (el.getAttribute("role") === "menuitem" ? 50 : 0);
        }
      }
      return 0;
    });
  }

  function detectChallenge() {
    const bodyText = normalize(document.body?.innerText?.slice(0, 10000) || "");
    const checks = [
      /enter the characters you see/i,
      /security check/i,
      /confirm your identity/i,
      /suspicious activity/i,
      /we suspended your account/i,
      /your account has been disabled/i,
      /try again later/i,
      /temporarily blocked/i,
      /you can't use this feature/i,
      /captcha/i,
    ];
    if (checks.some((re) => re.test(bodyText))) {
      return "Facebook showed a security or rate-limit challenge. Complete it manually, then Resume.";
    }
    return null;
  }

  async function waitFor(fn, { timeout = 14000, interval = 250 } = {}) {
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

  function dialogKind(dlg) {
    const label = normalize(dlg.getAttribute("aria-label") || "");
    const text = normalize(textOf(dlg)).slice(0, 800);
    if (/create post/.test(text) || /say something about this/.test(text)) return "create_post";
    if (/share to/.test(text) || /^share$/.test(label)) return "share_sheet";
    if (/search (for )?groups|suggested groups|all groups/.test(text)) return "group_picker";
    // Post opened as a lightbox/modal — must never close this
    if (dlg.querySelector?.('[role="article"]')) return "post_viewer";
    if (/photo|video|reel|post/.test(label) && dlg.querySelector?.('[aria-label*="Like" i], [aria-label="Share" i], [aria-label*="Comment" i]')) {
      return "post_viewer";
    }
    return "other";
  }

  function isDisposableShareUi(dlg) {
    const kind = dialogKind(dlg);
    return kind === "create_post" || kind === "share_sheet" || kind === "group_picker";
  }

  async function dismissLeftoverShareUi() {
    // Only close share/group/create-post sheets. Never Escape (closes the post modal)
    // and never click Close on the post viewer itself.
    for (let i = 0; i < 3; i++) {
      const targets = dialogs().filter(isDisposableShareUi);
      if (!targets.length) break;
      let closed = false;
      for (const root of targets) {
        const close = findByLabel([/^close$/, /^dismiss$/], root, { maxLen: 40 });
        if (close && !isNavigatingLink(close)) {
          click(close);
          closed = true;
          await sleep(400);
          break;
        }
      }
      if (!closed) break;
    }
    await sleep(200);
  }

  function findPrimaryArticle() {
    const articles = queryAll('[role="article"]').filter(visible);
    if (!articles.length) return null;
    // Prefer the article closest to the vertical center / top of viewport with a Share control
    const ranked = articles
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const dist = Math.abs(rect.top - 120);
        return { el, dist, hasShare: Boolean(findShareInRoot(el)) };
      })
      .sort((a, b) => Number(b.hasShare) - Number(a.hasShare) || a.dist - b.dist);
    return ranked[0]?.el || articles[0];
  }

  function findShareInRoot(root) {
    return pickBest(findClickables(root), (el) => {
      if (isNavigatingLink(el)) return 0;
      const label = labelOf(el);
      const aria = normalize(el.getAttribute("aria-label") || "");
      if (!label && !aria) return 0;
      // Destinations / later-step controls — not the post Share arrow
      if (/share to|share now|your story|messenger|send in/.test(label + " " + aria)) return 0;
      if (/^group$|^feed$|^story$|^post$|^close$/.test(label)) return 0;
      // Facebook Share is often an arrow icon with aria-label "Share" / "Send this to…"
      if (aria === "share" || label === "share") return 950;
      if (/^share$/.test(label) || /^share$/.test(aria)) return 900;
      if (/^send this to friends or post it on your profile$/.test(aria)) return 920;
      if (/\bshare\b/.test(aria) && aria.length < 48) return 700;
      return 0;
    });
  }

  function findPostRoot() {
    // Prefer the open post dialog/lightbox if present, else the main article
    const postDlg = dialogs().find((d) => dialogKind(d) === "post_viewer");
    if (postDlg) return postDlg;
    const article = findPrimaryArticle();
    if (article) return article;
    return null;
  }

  function findShareButton() {
    const root = findPostRoot();
    if (root) {
      const btn = findShareInRoot(root);
      if (btn) return btn;
    }
    // Last resort: articles only — never whole-document (hits nav/ads/links)
    const articles = queryAll('[role="article"]').filter(visible);
    for (const article of articles) {
      const btn = findShareInRoot(article);
      if (btn) return btn;
    }
    return null;
  }

  function shareSheetRoots() {
    const layered = [
      ...dialogs(),
      ...queryAll('[role="dialog"]'),
      ...queryAll('[role="menu"]'),
      ...queryAll('[aria-label*="Share" i]'),
      ...queryAll('[aria-label*="share" i]'),
    ].filter(visible);
    // Deduplicate
    return [...new Set(layered.length ? layered : [document])];
  }

  function findGroupUnderShareTo() {
    // Exact UI: share sheet → section labeled "Share to" → button "Group"
    const roots = shareSheetRoots();

    for (const root of roots) {
      // Prefer a control whose accessible name is exactly "Group"
      const exactGroup = pickBest(findClickables(root), (el) => {
        const label = labelOf(el);
        const aria = normalize(el.getAttribute("aria-label") || "");
        if (label === "group" || aria === "group") return 1000;
        if (/^share to group$/.test(label) || /^share to a group$/.test(label)) return 800;
        return 0;
      });
      if (exactGroup) return exactGroup;

      // Find a "Share to" heading/label, then a nearby "Group" control
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node = walker.nextNode();
      while (node) {
        const t = normalize(textOf(node));
        if (visible(node) && (t === "share to" || /^share to$/.test(t)) && t.length < 20) {
          const section =
            node.closest?.("div")?.parentElement ||
            node.parentElement ||
            node;
          const scope = section?.parentElement || section || root;
          const groupBtn = pickBest(findClickables(scope), (el) => {
            const label = labelOf(el);
            if (label === "group") return 1000;
            if (label.startsWith("group")) return 700;
            return 0;
          });
          if (groupBtn) return groupBtn;
        }
        node = walker.nextNode();
      }
    }

    // Fallbacks for older Facebook copy
    for (const root of roots) {
      const hit = findByLabel(
        [/^group$/, /share to (a )?group/, /share in (a )?group/],
        root,
        { maxLen: 60 }
      );
      if (hit) return hit;
    }
    return null;
  }

  function findGroupSearchInput() {
    const roots = dialogs().length ? dialogs() : [document];
    for (const root of roots) {
      const inputs = [
        ...queryAll('input[type="search"]', root),
        ...queryAll('input[type="text"]', root),
        ...queryAll("input:not([type])", root),
        ...queryAll('[contenteditable="true"]', root),
        ...queryAll("input", root),
      ].filter(visible);

      const scored = pickBest(inputs, (el) => {
        const label = normalize(
          el.getAttribute("aria-label") || el.getAttribute("placeholder") || ""
        );
        if (/search (for )?groups|group name|search groups/.test(label)) return 1000;
        if (/search/.test(label)) return 800;
        if (el.getAttribute("type") === "search") return 700;
        if (/group/.test(label)) return 600;
        return 100;
      });
      if (scored) return scored;
    }
    return null;
  }

  async function clearAndType(el, text) {
    el.focus();
    await sleep(120);

    if (el.isContentEditable) {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("delete", false);
      await sleep(80);
      for (const ch of text) {
        document.execCommand("insertText", false, ch);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
        await sleep(35 + Math.floor(Math.random() * 40));
      }
      return;
    }

    // React-friendly value set
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(80);

    // Select-all + delete, then type char by char
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", code: "KeyA", ctrlKey: true, bubbles: true })
    );
    setter?.call(el, "");
    el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));

    let built = "";
    for (const ch of text) {
      built += ch;
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true })
      );
      setter?.call(el, built);
      el.value = built;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      await sleep(35 + Math.floor(Math.random() * 45));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(200);
  }

  function findGroupResult(groupName) {
    const target = normalize(groupName);
    if (!target) return null;
    const roots = dialogs().length ? dialogs() : [document];

    for (const root of roots) {
      // Prefer explicit options / rows
      const candidates = [
        ...queryAll('[role="option"]', root),
        ...queryAll('[role="listitem"]', root),
        ...queryAll('[role="row"]', root),
        ...findClickables(root),
      ].filter(visible);

      const exact = candidates.find((el) => {
        const label = labelOf(el);
        return label === target || label.startsWith(target + " ");
      });
      if (exact) return exact;

      const partial = pickBest(candidates, (el) => {
        const label = labelOf(el);
        if (!label || label.length > 160) return 0;
        if (/^post$|^share$|^cancel$|^close$|^search/.test(label)) return 0;
        if (label === target) return 1000;
        if (label.includes(target)) return 800 - Math.abs(label.length - target.length);
        // Facebook often nests the name in a child span
        const childText = normalize(textOf(el));
        if (childText.includes(target)) return 600;
        return 0;
      });
      if (partial) return partial;

      // Fallback: walk text nodes
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node = walker.currentNode;
      while (node) {
        if (node.nodeType === 1 && visible(node)) {
          const t = normalize(node.childNodes.length <= 3 ? textOf(node) : "");
          if (t === target || (t.includes(target) && t.length < 120)) {
            const clickable =
              node.closest?.('[role="option"], [role="listitem"], [role="row"], [role="button"], [tabindex="0"]') ||
              node;
            if (visible(clickable)) return clickable;
          }
        }
        node = walker.nextNode();
      }
    }
    return null;
  }

  function isCreatePostDialog(root) {
    return dialogKind(root) === "create_post" || (() => {
      const t = normalize(textOf(root)).slice(0, 500);
      return (
        /create post/.test(t) ||
        /say something about this/.test(t) ||
        /write a post/.test(t)
      );
    })();
  }

  function findCreatePostDialog() {
    const all = dialogs();
    const create = all.find(isCreatePostDialog);
    if (create) return create;
    // Sometimes the title is outside role=dialog text sampling — check aria-label
    return (
      all.find((d) => /create post|share/i.test(d.getAttribute("aria-label") || "")) ||
      null
    );
  }

  function scoreCreatePostButton(el) {
    const label = labelOf(el);
    const aria = normalize(el.getAttribute("aria-label") || "");
    const combined = label || aria;
    if (!combined || combined.length > 40) return 0;
    // Final step in "Create post" is Post (not the earlier Share arrow)
    if (/^post$/.test(combined) || /^post$/.test(aria)) return 1000;
    if (/^publish$/.test(combined)) return 800;
    // Only accept Share here as a weak fallback
    if (/^share$/.test(combined)) return 400;
    return 0;
  }

  function findCreatePostSubmitButton() {
    const createDlg = findCreatePostDialog();
    const roots = createDlg ? [createDlg] : dialogs().length ? dialogs() : [];
    for (const root of roots) {
      const candidates = findClickables(root)
        .map((el) => ({ el, score: scoreCreatePostButton(el) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      for (const { el } of candidates) {
        if (!looksUnusable(el)) return el;
      }

      // Text-node fallback: visible "Post" label inside Create post
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node = walker.nextNode();
      while (node) {
        const raw = textOf(node);
        if (visible(node) && normalize(raw) === "post" && raw.length <= 8) {
          const clickable =
            node.closest?.('[role="button"], button, [tabindex="0"]') || node;
          if (visible(clickable) && !looksUnusable(clickable)) return clickable;
        }
        node = walker.nextNode();
      }
    }
    return null;
  }

  function looksUnusable(el) {
    if (!el) return true;
    if (el.hasAttribute("disabled")) return true;
    // Facebook sometimes leaves aria-disabled on controls that are still the right target;
    // only treat as unusable if pointer events are none or it's clearly hidden.
    const style = window.getComputedStyle(el);
    if (style.pointerEvents === "none") return true;
    if (style.visibility === "hidden" || style.display === "none") return true;
    if (Number(style.opacity) === 0) return true;
    return false;
  }

  async function waitForCreatePostSubmit(timeout = 18000) {
    return waitFor(() => findCreatePostSubmitButton(), { timeout, interval: 300 });
  }

  async function waitForShareFinished(timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const challenge = detectChallenge();
      if (challenge) {
        const err = new Error(challenge);
        err.blocked = true;
        throw err;
      }
      // Success when Create post dialog is gone
      if (!findCreatePostDialog()) return true;
      await sleep(300);
    }
    // Dialog still open — treat as uncertain failure
    return false;
  }

  async function runShareOnce(group) {
    const challenge = detectChallenge();
    if (challenge) return { ok: false, blocked: true, error: challenge };

    const startUrl = location.href;

    for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
      try {
        await reportStep(`Preparing share to “${group.name}” (try ${attempt}/${MAX_STEP_ATTEMPTS})…`);
        // Only clear leftover share sheets — Escape/Close was exiting the post lightbox
        await dismissLeftoverShareUi();
        await sleep(400);

        if (location.href !== startUrl) {
          throw new Error("Left the original post page unexpectedly. Re-open the post and Resume.");
        }

        // 1) Post screen → Share (arrow)
        await reportStep("1/5 Clicking Share (arrow) on the post…");
        const shareBtn = await waitFor(() => findShareButton(), { timeout: 12000 });
        if (!shareBtn) {
          throw new Error("Could not find the Share arrow on this post. Open the post and try again.");
        }
        if (!click(shareBtn)) {
          throw new Error("Share control looked like a link that would leave this post — skipped it.");
        }
        await sleep(1200);

        if (location.href !== startUrl) {
          throw new Error("Clicking Share navigated away from the post. Re-open the post and try again.");
        }

        // 2) Share sheet → under "Share to" → Group
        await reportStep('2/5 Clicking “Group” under Share to…');
        const groupOpt = await waitFor(() => findGroupUnderShareTo(), { timeout: 12000 });
        if (!groupOpt) {
          throw new Error(
            'Could not find the “Group” button under “Share to”. Open Share manually once and confirm that row is there.'
          );
        }
        click(groupOpt);
        await sleep(1400);

        // 3) Group picker → search bar at top
        await reportStep(`3/5 Searching for “${group.name}”…`);
        const search = await waitFor(() => findGroupSearchInput(), { timeout: 12000 });
        if (!search) throw new Error("Could not find the group search bar at the top of the popup.");
        await clearAndType(search, group.name);
        await sleep(1500);

        await reportStep(`3/5 Selecting “${group.name}”…`);
        const result = await waitFor(() => findGroupResult(group.name), { timeout: 14000 });
        if (!result) {
          throw new Error(
            `Could not find “${group.name}” in the group list. Use the exact name, and make sure you joined it.`
          );
        }
        click(result);
        await sleep(1400);

        // 4) Create post popup → Post
        await reportStep("4/5 Waiting for Create post…");
        const createDlg = await waitFor(() => findCreatePostDialog(), { timeout: 12000 });
        if (!createDlg) {
          throw new Error('Could not find the “Create post” popup after selecting the group.');
        }

        await reportStep("5/5 Clicking Post…");
        const postBtn = await waitForCreatePostSubmit(18000);
        if (!postBtn) {
          throw new Error('Could not find the Post button in the Create post popup.');
        }
        click(postBtn);

        await reportStep("Waiting for Create post to close…");
        const finished = await waitForShareFinished(12000);
        if (!finished) {
          throw new Error(
            "Create post stayed open after clicking Post — the share may not have gone through."
          );
        }

        const after = detectChallenge();
        if (after) return { ok: false, blocked: true, error: after };

        await reportStep(`Shared to “${group.name}”.`);
        await sleep(400);
        return { ok: true, groupId: group.id, groupName: group.name };
      } catch (err) {
        if (err.blocked || /challenge|captcha|blocked|suspended/i.test(err.message || "")) {
          return { ok: false, blocked: true, error: err.message };
        }
        await reportStep(err.message || String(err));
        if (attempt >= MAX_STEP_ATTEMPTS) {
          return { ok: false, blocked: false, error: err.message || String(err) };
        }
        await dismissLeftoverShareUi();
        await sleep(900);
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
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }

  function stopCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function startCountdownTick() {
    stopCountdown();
    countdownTimer = setInterval(() => {
      if (!lastState) return;
      renderBanner(lastState, true);
    }, 1000);
  }

  function renderBanner(state, fromTick = false) {
    const session = state?.session;
    if (!session || session.status === "idle") {
      stopCountdown();
      const existing = document.getElementById(BANNER_ID);
      if (existing) existing.remove();
      return;
    }
    if (!fromTick) lastState = state;
    const el = ensureBanner();
    el.dataset.status = session.status;
    const msg = el.querySelector(".fgs-banner-msg");
    const meta = el.querySelector(".fgs-banner-meta");
    const title = el.querySelector(".fgs-banner-title");
    title.textContent = `Group Share · ${session.status}`;
    if (!fromTick || session.status !== "waiting") {
      msg.textContent = session.message || session.lastError || "";
    }
    const used = state.dayStats?.count ?? 0;
    const cap = state.settings?.dailyCap ?? 100;
    const idx = session.index ?? 0;
    const total = session.queue?.length ?? 0;
    let eta = "";
    if (session.status === "waiting" && session.nextActionAt) {
      const reason = session.waitReason === "batch_break" ? "batch break" : "next share";
      eta = ` · ${reason} in ${formatEta(session.nextActionAt)}`;
      if (!countdownTimer) startCountdownTick();
    } else {
      stopCountdown();
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
  setInterval(refreshState, 1000);
})();
