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

  function flash(el) {
    if (!el?.style) return;
    const prev = el.style.outline;
    el.style.outline = "3px solid #ff3b30";
    setTimeout(() => {
      try {
        el.style.outline = prev;
      } catch (_) {
        /* ignore */
      }
    }, 800);
  }

  function clickAt(el, clientX, clientY, { allowSameOrigin = false } = {}) {
    if (!el) return false;
    const href = hrefOf(el);
    if (href) {
      try {
        const u = new URL(href, location.href);
        if (u.origin !== location.origin) {
          console.warn("[FGS] Refusing external link:", href);
          return false;
        }
        if (!allowSameOrigin && isNavigatingLink(el)) {
          console.warn("[FGS] Refusing navigating link:", href);
          return false;
        }
      } catch (_) {
        return false;
      }
    }
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
      button: 0,
      buttons: 1,
      detail: 1,
    };
    const target = document.elementFromPoint(clientX, clientY) || el;
    target.dispatchEvent(new PointerEvent("pointerover", opts));
    target.dispatchEvent(new MouseEvent("mouseover", opts));
    target.dispatchEvent(new PointerEvent("pointerenter", opts));
    target.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerId: 1, pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mousedown", opts));
    target.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerId: 1, pointerType: "mouse", buttons: 0 }));
    target.dispatchEvent(new MouseEvent("mouseup", { ...opts, buttons: 0 }));
    target.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
    return true;
  }

  function click(el, { allowSameOrigin = false, once = false } = {}) {
    if (!el) return false;
    el.scrollIntoView({ block: "center", inline: "nearest" });
    flash(el);
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + Math.min(Math.max(rect.height * 0.35, 12), rect.height - 8);
    if (!clickAt(el, x, y, { allowSameOrigin })) return false;
    // Native el.click() on top of dispatched events can double-fire Facebook actions
    // (especially Post). Only use it when explicitly allowed.
    if (!once && typeof el.click === "function" && !el.closest?.("a[href]")) el.click();
    return true;
  }

  function clickPostOnce(postBtn) {
    // Exactly one click sequence — duplicates were causing multi-shares
    flash(postBtn);
    const pr = postBtn.getBoundingClientRect();
    return clickAt(postBtn, pr.left + pr.width / 2, pr.top + pr.height / 2, {
      allowSameOrigin: true,
    });
  }

  async function clickGroupTile(tile) {
    // Try several hit targets: caption, icon area, tile center
    flash(tile);
    const rect = tile.getBoundingClientRect();
    const points = [
      [rect.left + rect.width / 2, rect.top + rect.height * 0.35], // icon
      [rect.left + rect.width / 2, rect.top + rect.height * 0.75], // caption
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
    ];
    for (const [x, y] of points) {
      clickAt(tile, x, y, { allowSameOrigin: true });
      await sleep(350);
      if (groupPickerVisible()) return true;
    }
    // Fallback: click nested button/svg parents
    const nested = [
      ...queryAll('[role="button"]', tile),
      ...queryAll("svg", tile),
      ...queryAll("image", tile),
      tile,
    ].filter(visible);
    for (const el of nested.slice(0, 6)) {
      click(el, { allowSameOrigin: true });
      await sleep(400);
      if (groupPickerVisible()) return true;
    }
    return groupPickerVisible();
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

  function ownText(el) {
    return normalize(
      [...(el?.childNodes || [])]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent || "")
        .join(" ")
    );
  }

  function findExactTextNodes(text, root = document) {
    const target = normalize(text);
    const matches = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    while (node) {
      if (visible(node)) {
        const own = ownText(node);
        const full = normalize(textOf(node));
        // Exact leaf label like "Group" / "Share to"
        if (own === target || (full === target && full.length <= 24)) {
          matches.push(node);
        }
      }
      node = walker.nextNode();
    }
    // Smallest hit first (most specific label node)
    matches.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return ar.width * ar.height - br.width * br.height;
    });
    return matches;
  }

  function clickableAncestor(el) {
    return (
      el.closest?.(
        '[role="button"], [role="menuitem"], [role="menuitemradio"], [role="link"], button, a[href], div[tabindex="0"], span[role="button"]'
      ) || el
    );
  }

  function destinationTileForLabel(labelEl) {
    // Facebook layout: [icon of 3 people] on top, "Group" caption underneath.
    // The caption span is often NOT inside the role=button — both sit in a tile wrapper.
    if (!labelEl) return null;

    const direct = clickableAncestor(labelEl);
    if (
      direct &&
      direct !== labelEl &&
      visible(direct) &&
      !looksUnusable(direct) &&
      (direct.getAttribute("role") === "button" ||
        direct.tagName === "BUTTON" ||
        direct.tagName === "A" ||
        direct.getAttribute("tabindex") === "0")
    ) {
      return direct;
    }

    // Walk up a few wrappers looking for a compact tile that also has an icon/button
    let scope = labelEl.parentElement;
    for (let depth = 0; depth < 5 && scope; depth++) {
      const rect = scope.getBoundingClientRect();
      // Destination tiles are small (icon + caption), not the whole share menu
      if (rect.width > 20 && rect.width < 160 && rect.height > 20 && rect.height < 180) {
        if (
          scope.getAttribute("role") === "button" ||
          scope.getAttribute("tabindex") === "0" ||
          scope.tagName === "A"
        ) {
          if (!looksUnusable(scope)) return scope;
        }
        const inner =
          scope.querySelector?.('[role="button"], a[href], button, [tabindex="0"]') || null;
        if (inner && visible(inner) && !looksUnusable(inner)) return inner;
        // Whole tile div is the hit target even without role
        if (!looksUnusable(scope)) return scope;
      }
      scope = scope.parentElement;
    }

    return direct && visible(direct) && !looksUnusable(direct) ? direct : null;
  }

  function isShareDestinationCluster(el) {
    const t = normalize(textOf(el)).slice(0, 400);
    if (!t) return false;
    // Share sheet destinations: Group with caption under people icon, among Feed/Story/etc.
    const hasGroup = /\bgroup\b/.test(t);
    const peers =
      Number(/\bfeed\b/.test(t)) +
      Number(/\bstory\b/.test(t)) +
      Number(/\bpage\b/.test(t)) +
      Number(/\breel\b/.test(t)) +
      Number(/\bmessenger\b/.test(t)) +
      Number(/\bfriend\b/.test(t));
    const hasShareTo = /share to/.test(t);
    return hasGroup && (hasShareTo || peers >= 1);
  }

  function shareSheetRoots() {
    const layered = [
      ...dialogs(),
      ...queryAll('[role="menu"]'),
      ...queryAll('[role="listbox"]'),
      ...queryAll('[aria-label*="Share" i]'),
      ...queryAll('[aria-label*="share" i]'),
    ].filter(visible);

    // Popover often has no dialog role — climb from "Share to" or a Group caption
    const anchors = [
      ...findExactTextNodes("Share to", document),
      ...findExactTextNodes("Share", document).filter((el) => {
        // Section heading near destinations, not the post Share arrow
        const t = normalize(textOf(el.parentElement || el));
        return t.includes("group") || t.includes("feed") || t.includes("story");
      }),
      ...findExactTextNodes("Group", document),
    ];

    for (const label of anchors) {
      let scope = label.parentElement;
      for (let i = 0; i < 10 && scope; i++) {
        if (isShareDestinationCluster(scope)) {
          layered.push(scope);
          break;
        }
        scope = scope.parentElement;
      }
    }

    return [...new Set(layered)];
  }

  function findGroupUnderShareTo() {
    // UI: Share arrow → sheet with section "Share to" → tile = people icon + "Group" caption
    const roots = shareSheetRoots();
    const searchRoots = roots.length ? roots : [document];

    for (const root of searchRoots) {
      // A) aria-label="Group" on the icon button (common for the 3-people glyph)
      const ariaGroup = pickBest(
        [
          ...queryAll('[aria-label="Group" i]', root),
          ...queryAll('[aria-label="group" i]', root),
          ...findClickables(root),
          ...queryAll('[role="link"]', root),
          ...queryAll("a[href]", root),
        ].filter(visible),
        (el) => {
          if (looksUnusable(el)) return 0;
          try {
            const href = hrefOf(el);
            if (href && new URL(href, location.href).origin !== location.origin) return 0;
          } catch (_) {
            return 0;
          }
          const aria = normalize(el.getAttribute("aria-label") || "");
          const label = labelOf(el);
          if (aria === "group" || label === "group") return 1000;
          if (/^share to (a )?group$/.test(label) || /^share to (a )?group$/.test(aria)) return 900;
          return 0;
        }
      );
      if (ariaGroup) return ariaGroup;

      // B) Visible caption "Group" under the people icon → resolve its tile wrapper
      const groupLabels = findExactTextNodes("Group", root);
      for (const labelEl of groupLabels) {
        // Skip left-rail "Groups" style targets
        const ancestors = normalize(textOf(labelEl.closest?.('[role="navigation"]') || ""));
        if (ancestors && ancestors.length > 0) continue;

        const tile = destinationTileForLabel(labelEl);
        if (!tile) continue;

        const aria = normalize(tile.getAttribute("aria-label") || "");
        if (aria === "groups" || /see (all )?groups/.test(aria)) continue;

        // Prefer tiles that live in a Share to / Feed / Story cluster
        let inCluster = false;
        let p = tile.parentElement;
        for (let i = 0; i < 8 && p; i++) {
          if (isShareDestinationCluster(p)) {
            inCluster = true;
            break;
          }
          p = p.parentElement;
        }
        if (roots.length && !inCluster && root === document) continue;
        if (inCluster || roots.length) return tile;
      }
    }

    // C) Last resort document-wide caption → tile (only if Share to / peer destinations exist)
    if (shareSheetVisible()) {
      for (const labelEl of findExactTextNodes("Group", document)) {
        const tile = destinationTileForLabel(labelEl);
        if (!tile) continue;
        let p = tile.parentElement;
        for (let i = 0; i < 8 && p; i++) {
          if (isShareDestinationCluster(p)) return tile;
          p = p.parentElement;
        }
      }
    }

    return null;
  }

  function shareSheetVisible() {
    if (findExactTextNodes("Share to", document).length) return true;
    // Destination row without relying on exact "Share to" wording
    for (const g of findExactTextNodes("Group", document)) {
      let p = g.parentElement;
      for (let i = 0; i < 8 && p; i++) {
        if (isShareDestinationCluster(p)) return true;
        p = p.parentElement;
      }
    }
    return shareSheetRoots().some((root) => isShareDestinationCluster(root));
  }

  function groupPickerVisible() {
    // After Group tile is clicked, Facebook shows a group chooser with search
    if (findGroupSearchInput()) return true;
    const blobs = [
      ...dialogs().map((d) => normalize(textOf(d)).slice(0, 500)),
      ...shareSheetRoots().map((d) => normalize(textOf(d)).slice(0, 500)),
    ];
    return blobs.some(
      (t) =>
        /search (for )?groups/.test(t) ||
        /suggested groups/.test(t) ||
        (/groups/.test(t) && /search/.test(t) && !/share to/.test(t))
    );
  }

  function findGroupSearchInput() {
    // Prefer dialogs / share UI — never fall back to scoring random page inputs
    const roots = [
      ...dialogs(),
      ...shareSheetRoots(),
    ].filter(Boolean);
    const searchRoots = roots.length ? [...new Set(roots)] : [];

    for (const root of searchRoots) {
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
        if (/search/.test(label) && /group/.test(label)) return 900;
        if (/search/.test(label)) return 700;
        if (el.getAttribute("type") === "search") return 600;
        return 0; // do not match arbitrary text fields
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
    if (!root) return false;
    if (dialogKind(root) === "create_post") return true;
    const label = normalize(root.getAttribute?.("aria-label") || "");
    const t = normalize(textOf(root)).slice(0, 600);
    // Must look like the composer after picking a group — not the Share to sheet
    if (/share to/.test(t) && /\bfeed\b/.test(t) && /\bgroup\b/.test(t)) return false;
    if (/^create post$/.test(label) || /create post/.test(label)) return true;
    if (/create post/.test(t) || /say something about this/.test(t) || /write a post/.test(t)) {
      return true;
    }
    return false;
  }

  function findCreatePostDialog() {
    const byRole = dialogs().find(isCreatePostDialog);
    if (byRole) return byRole;

    // Create post is sometimes a layer without role="dialog"
    for (const label of findExactTextNodes("Create post", document)) {
      let scope = label.parentElement;
      for (let i = 0; i < 10 && scope; i++) {
        const rect = scope.getBoundingClientRect();
        if (rect.width > 280 && rect.height > 200 && isCreatePostDialog(scope)) return scope;
        if (rect.width > 280 && rect.height > 200) {
          const t = normalize(textOf(scope)).slice(0, 400);
          if (/create post/.test(t) || /say something about this/.test(t)) return scope;
        }
        scope = scope.parentElement;
      }
    }
    return null;
  }

  function isFacebookBlueButton(el) {
    const style = window.getComputedStyle(el);
    const bg = style.backgroundColor || "";
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (!m) return false;
    const r = Number(m[1]);
    const g = Number(m[2]);
    const b = Number(m[3]);
    // FB primary blue ~ rgb(24, 119, 242) and close variants
    return r >= 0 && r <= 80 && g >= 90 && g <= 170 && b >= 200 && b <= 255;
  }

  function postButtonLooksClickable(el) {
    if (!el || !visible(el)) return false;
    if (el.hasAttribute("disabled")) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (Number(style.opacity) === 0) return false;
    // Do NOT reject aria-disabled — FB often leaves it set while the blue Post is usable
    return true;
  }

  function resolvePostControl(labelEl) {
    if (!labelEl) return null;
    const candidates = [];
    const direct = clickableAncestor(labelEl);
    if (direct) candidates.push(direct);

    let scope = labelEl.parentElement;
    for (let depth = 0; depth < 6 && scope; depth++) {
      candidates.push(scope);
      const inner = scope.querySelector?.(
        '[role="button"], button, [tabindex="0"], a[href]'
      );
      if (inner) candidates.push(inner);
      scope = scope.parentElement;
    }

    // Prefer compact blue controls near the caption
    const ranked = [...new Set(candidates)]
      .filter(postButtonLooksClickable)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        let score = 0;
        if (rect.width >= 40 && rect.width <= 280 && rect.height >= 24 && rect.height <= 80) {
          score += 50;
        }
        if (isFacebookBlueButton(el)) score += 100;
        const aria = normalize(el.getAttribute("aria-label") || "");
        const label = labelOf(el);
        if (aria === "post" || label === "post" || normalize(textOf(el)) === "post") score += 80;
        if (el.getAttribute("role") === "button" || el.tagName === "BUTTON") score += 20;
        // Prefer lower on screen (footer)
        score += Math.min(40, Math.floor(rect.top / 40));
        return { el, score, rect };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    return ranked[0]?.el || null;
  }

  function findCreatePostSubmitButton() {
    const createDlg = findCreatePostDialog();
    const roots = [];
    if (createDlg) {
      roots.push(createDlg);
      if (createDlg.parentElement) roots.push(createDlg.parentElement);
    }
    for (const d of dialogs()) {
      if (isCreatePostDialog(d)) roots.push(d);
    }
    // Footer actions are sometimes portaled beside the dialog
    if (createDlg || findExactTextNodes("Create post", document).length) {
      roots.push(document.body);
    }

    for (const root of [...new Set(roots.filter(Boolean))]) {
      // 1) Caption / aria "Post"
      for (const labelEl of findExactTextNodes("Post", root)) {
        // Ignore "Create post" heading matches — exact text "Post" only from findExactTextNodes
        const btn = resolvePostControl(labelEl);
        if (btn) return btn;
      }

      const ariaPosts = [
        ...queryAll('[aria-label="Post" i]', root),
        ...queryAll('[aria-label="post" i]', root),
      ].filter(postButtonLooksClickable);
      if (ariaPosts[0]) return ariaPosts[0];

      // 2) Blue primary button in the create-post surface
      const scope = createDlg || root;
      const blues = findClickables(scope)
        .filter(postButtonLooksClickable)
        .filter(isFacebookBlueButton)
        .filter((el) => {
          const t = normalize(textOf(el));
          const aria = normalize(el.getAttribute("aria-label") || "");
          return t === "post" || aria === "post" || t.length <= 12;
        });
      if (blues.length) {
        blues.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
        return blues[0];
      }

      // 3) Any blue button in the lower half of the create dialog
      if (createDlg && root === createDlg) {
        const dlgRect = createDlg.getBoundingClientRect();
        const midY = dlgRect.top + dlgRect.height * 0.55;
        const footerBlues = findClickables(createDlg)
          .filter(postButtonLooksClickable)
          .filter(isFacebookBlueButton)
          .filter((el) => el.getBoundingClientRect().top >= midY);
        if (footerBlues.length === 1) return footerBlues[0];
        const named = footerBlues.find((el) => {
          const t = normalize(textOf(el) + " " + (el.getAttribute("aria-label") || ""));
          return /\bpost\b/.test(t);
        });
        if (named) return named;
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
    let postClicked = false;

    for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
      try {
        // Never re-run the flow after Post was clicked — that caused duplicate shares
        if (postClicked) {
          return { ok: true, groupId: group.id, groupName: group.name };
        }

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

        await reportStep("1/5 Waiting for Share to sheet…");
        const sheet = await waitFor(() => shareSheetVisible(), { timeout: 12000 });
        if (!sheet) {
          throw new Error(
            'Share sheet did not appear after clicking the Share arrow. Try clicking Share once manually to confirm it opens.'
          );
        }
        await sleep(500);

        if (location.href !== startUrl) {
          throw new Error("Clicking Share navigated away from the post. Re-open the post and try again.");
        }

        // 2) Share sheet → under "Share to" → Group (people icon + caption)
        await reportStep('2/5 Clicking “Group” (people icon) under Share to…');
        const groupOpt = await waitFor(() => findGroupUnderShareTo(), { timeout: 12000 });
        if (!groupOpt) {
          throw new Error(
            'Could not find the “Group” tile under “Share to”. Open Share manually once and confirm that row is there.'
          );
        }
        const openedPicker = await clickGroupTile(groupOpt);
        if (!openedPicker) {
          // One more wait in case UI is slow
          const late = await waitFor(() => groupPickerVisible(), { timeout: 5000 });
          if (!late) {
            throw new Error(
              "Clicked Group but the group list/search never opened. The wrong control may have been targeted — try again after Reload."
            );
          }
        }
        await sleep(600);

        // 3) Group picker → search bar at top
        await reportStep(`3/5 Searching for “${group.name}”…`);
        const search = await waitFor(() => findGroupSearchInput(), { timeout: 12000 });
        if (!search) {
          throw new Error(
            "Group picker did not show a search bar. Group tile click may have failed."
          );
        }
        await clearAndType(search, group.name);
        await sleep(1500);

        await reportStep(`3/5 Selecting “${group.name}”…`);
        const result = await waitFor(() => findGroupResult(group.name), { timeout: 14000 });
        if (!result) {
          throw new Error(
            `Could not find “${group.name}” in the group list. Use the exact name, and make sure you joined it.`
          );
        }
        click(result, { allowSameOrigin: true });
        await sleep(1400);

        // 4) Create post popup → Post
        await reportStep("4/5 Waiting for Create post…");
        const createDlg = await waitFor(() => findCreatePostDialog(), { timeout: 14000 });
        if (!createDlg) {
          throw new Error(
            'Could not find the “Create post” popup after selecting the group. If the group list is still open, the group row may not have been selected.'
          );
        }

        await reportStep("5/5 Clicking Post (once)…");
        await sleep(600);
        const postBtn = await waitForCreatePostSubmit(20000);
        if (!postBtn) {
          throw new Error(
            'Create post opened, but no Post button was found. Look for a blue Post button and tell me the exact label if it differs.'
          );
        }
        clickPostOnce(postBtn);
        postClicked = true;

        await reportStep("Waiting for Create post to close…");
        const finished = await waitForShareFinished(12000);
        // Even if close detection is flaky, do NOT retry — Post was already clicked
        if (!finished) {
          await reportStep(
            `Post clicked for “${group.name}” (dialog still open — not retrying to avoid duplicates).`
          );
        } else {
          await reportStep(`Shared to “${group.name}”.`);
        }

        const after = detectChallenge();
        if (after) return { ok: false, blocked: true, error: after };

        await sleep(400);
        return { ok: true, groupId: group.id, groupName: group.name };
      } catch (err) {
        if (postClicked) {
          // Share likely already went through; retrying would duplicate
          await reportStep(`Post already clicked for “${group.name}” — skipping retry.`);
          return { ok: true, groupId: group.id, groupName: group.name };
        }
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
