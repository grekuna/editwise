import { marked } from "marked";

// editwise — vanilla JS port of the original React/TSX prototype.
//
// This file owns the entire client-side state machine (input -> reading ->
// reviewing) for the essay-editing app. It talks to the Rails backend via
// fetch for anything that needs the Claude API (POST /passes, POST
// /discussions) and for saving custom prompts (handled on the editor
// primer page, see the second half of this file).
//
// Future extension point: if this grows much further, split it into
// modules (state.js, render.js, api.js) and import them here. For a
// single-screen app this size, one file keeps it easy to follow.

function csrfToken() {
  const tag = document.querySelector('meta[name="csrf-token"]');
  return tag ? tag.content : null;
}

async function postJSON(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken(),
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status}).`);
  }
  return data;
}

// ============================================================================
// ESSAY APP (input / reading / reviewing phases)
// ============================================================================

function initEssayApp() {
  const root = document.getElementById("app");
  if (!root) return;

  const editors = JSON.parse(root.dataset.editors);

  const state = {
    essay: "",
    pasteValue: "",
    phase: "input", // input | reading | reviewing
    editorKey: "williams",
    revisions: [], // {id, original, suggested, principle, explanation, status, userEdit, appliedText}
    activeId: null,
    editingId: null,
    editValue: "",
    error: null,
    isRunning: false,
    runningEditor: null,
    appliedEditor: null,
    passCounts: {}, // editorKey -> number of completed passes
    verdict: "",
    copyToast: false,
    discussingId: null,
    conversations: {}, // revId -> [{role, content}]
    discussInput: "",
    isDiscussing: false,
    isEditingEssay: false,
    essayEditValue: "",
    passHistory: [], // [{id, editorKey, editorName, timestamp, verdict, revisions}]
    expandedHistoryId: null,
    pickerCollapsed: false,
    historyCollapsed: false,
    editorFilter: "all",
    report: null,
    isGeneratingReport: false,
    panelPos: null,
  };

  const segmentRefs = {};

  // Scope overlap groups — used to dim editors whose territory is already covered
  // Animated verb phrases shown while a pass runs
  const RUNNING_VERBS = {
    mcphee:      ["Reading structure", "Tracing the narrative arc", "Checking your lede", "Looking at sequence", "Following the kicker"],
    pinker:      ["Checking confidence", "Looking for hedging", "Reviewing directness", "Reading for stance"],
    classic:     ["Checking voice", "Looking for earned content", "Reading for stance"],
    gopen:       ["Parsing sentence flow", "Checking stress positions", "Looking for topic strings", "Reviewing reader expectations"],
    zinsser:     ["Hunting for clutter", "Checking simplicity", "Looking for warmth", "Reviewing word choice"],
    williams:    ["Checking sentence structure", "Looking for nominalisations", "Reviewing passive constructions", "Checking verb strength"],
    klinkenborg: ["Reading each sentence", "Listening to the rhythm", "Checking line by line", "Following the breath"],
    sword:       ["Reviewing academic register", "Looking for zombie nouns", "Checking for human actors", "Reviewing jargon"],
    hart:        ["Checking narrative tension", "Looking for the complicating action", "Reviewing stakes", "Looking for the turn", "Checking the payoff"],
    kr:          ["Checking the hook", "Looking for the named anchor", "Reviewing rhythm variance", "Looking for the turn", "Checking the ending"],
    llm:         ["Scanning vocabulary", "Checking for generic phrases", "Looking for AI patterns", "Reviewing filler words"],
  };
  const FALLBACK_VERBS = ["Reading your essay", "Applying editorial principles", "Flagging revisions", "Building your feedback"];

  let phraseIntervalId = null;

  function startRunningAnimation(editorKey) {
    const bodyEl = document.getElementById("running-banner-body");
    if (!bodyEl) return;
    const verbs = RUNNING_VERBS[editorKey] || FALLBACK_VERBS;
    let idx = 0;
    bodyEl.textContent = verbs[0] + "…";
    phraseIntervalId = setInterval(() => {
      bodyEl.classList.add("phrase-out");
      setTimeout(() => {
        idx = (idx + 1) % verbs.length;
        bodyEl.textContent = verbs[idx] + "…";
        bodyEl.classList.remove("phrase-out");
      }, 350);
    }, 2200);
  }

  function editorByKey(key) {
    return editors.find((e) => e.key === key);
  }

  function authorDisplay(e) {
    return e.author === "editwise" ? e.author : `after ${e.author}`;
  }

  function applyMarkdownFormat(ta, format) {
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const val = ta.value;
    const selected = val.slice(start, end);

    let before, newText, newStart, newEnd;

    if (format === "bold") {
      const inner = selected || "bold";
      before = val.slice(0, start);
      newText = `**${inner}**`;
      newStart = start + 2;
      newEnd = newStart + inner.length;
    } else if (format === "italic") {
      const inner = selected || "italic";
      before = val.slice(0, start);
      newText = `*${inner}*`;
      newStart = start + 1;
      newEnd = newStart + inner.length;
    } else if (format === "h1" || format === "h2") {
      const prefix = format === "h1" ? "# " : "## ";
      const lineStart = val.lastIndexOf("\n", start - 1) + 1;
      const lineEndRaw = val.indexOf("\n", start);
      const lineEnd = lineEndRaw === -1 ? val.length : lineEndRaw;
      const lineContent = val.slice(lineStart, lineEnd);
      const stripped = lineContent.replace(/^#{1,6} /, "");
      const already = lineContent.startsWith(prefix);
      const newLine = already ? stripped : prefix + stripped;
      before = val.slice(0, lineStart);
      const after = val.slice(lineEnd);
      ta.value = before + newLine + after;
      ta.selectionStart = ta.selectionEnd = lineStart + newLine.length;
      ta.focus();
      if (state.phase === "reading") state.essay = ta.value;
      else state.essayEditValue = ta.value;
      return;
    }

    const after = val.slice(end);
    ta.value = before + newText + after;
    ta.selectionStart = newStart;
    ta.selectionEnd = newEnd;
    ta.focus();
    if (state.phase === "reading") state.essay = ta.value;
    else state.essayEditValue = ta.value;
  }

  function buildMarkdownToolbar() {
    const bar = document.createElement("div");
    bar.className = "essay-toolbar";
    [
      { label: "B", md: "bold", title: "Bold (**text**)" },
      { label: "I", md: "italic", title: "Italic (*text*)" },
      { sep: true },
      { label: "H1", md: "h1", title: "Heading 1" },
      { label: "H2", md: "h2", title: "Heading 2" },
    ].forEach((t) => {
      if (t.sep) {
        const s = document.createElement("span");
        s.className = "toolbar-sep";
        bar.appendChild(s);
        return;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "toolbar-btn";
      btn.dataset.md = t.md;
      btn.title = t.title;
      btn.textContent = t.label;
      bar.appendChild(btn);
    });
    return bar;
  }

  function wireToolbar(toolbar, ta) {
    toolbar.querySelectorAll("[data-md]").forEach((btn) => {
      btn.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        applyMarkdownFormat(ta, btn.dataset.md);
      });
    });
  }

  function collapsibleHeader(labelText, isCollapsed, onToggle, rightEl = null) {
    const header = document.createElement("div");
    header.className = "section-header";
    const left = document.createElement("div");
    left.className = "section-header-left";
    const label = document.createElement("span");
    label.className = "mono-label";
    label.textContent = labelText;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "section-toggle";
    btn.setAttribute("aria-expanded", String(!isCollapsed));
    btn.textContent = isCollapsed ? "▸" : "▾";
    btn.addEventListener("click", onToggle);
    left.append(label, btn);
    header.appendChild(left);
    if (rightEl) header.appendChild(rightEl);
    return header;
  }

  function pendingRevisions() {
    return state.revisions.filter((r) => r.status === "pending" && state.essay.includes(r.original));
  }

  function navigableRevisions() {
    return state.revisions
      .filter((r) => {
        if (r.status === "pending") return state.essay.includes(r.original);
        if (r.status === "accepted") return state.essay.includes(r.appliedText || r.suggested);
        return false;
      })
      .sort((a, b) => {
        const aText = a.status === "accepted" ? a.appliedText || a.suggested : a.original;
        const bText = b.status === "accepted" ? b.appliedText || b.suggested : b.original;
        return state.essay.indexOf(aText) - state.essay.indexOf(bText);
      });
  }

  function buildSegments() {
    const navigable = state.revisions
      .filter((r) => r.status === "pending" || r.status === "accepted")
      .map((r) => {
        const text = r.status === "accepted" ? r.appliedText || r.suggested : r.original;
        return { rev: r, text, pos: state.essay.indexOf(text) };
      })
      .filter((p) => p.pos !== -1)
      .sort((a, b) => a.pos - b.pos);

    const filtered = [];
    let lastEnd = -1;
    for (const p of navigable) {
      if (p.pos >= lastEnd) {
        filtered.push(p);
        lastEnd = p.pos + p.text.length;
      }
    }

    const segments = [];
    let cursor = 0;
    for (const p of filtered) {
      if (p.pos > cursor) {
        segments.push({ kind: "text", content: state.essay.slice(cursor, p.pos) });
      }
      segments.push({ kind: "rev", rev: p.rev, content: p.text });
      cursor = p.pos + p.text.length;
    }
    if (cursor < state.essay.length) {
      segments.push({ kind: "text", content: state.essay.slice(cursor) });
    }
    return segments;
  }

  // ==========================================================================
  // ACTIONS
  // ==========================================================================

  function acceptRevision(id, overrideText) {
    const rev = state.revisions.find((r) => r.id === id);
    if (!rev) return;
    const replacement = overrideText != null ? overrideText : rev.userEdit != null ? rev.userEdit : rev.suggested;

    state.essay = state.essay.replace(rev.original, replacement);
    rev.status = "accepted";
    rev.appliedText = replacement;
    if (overrideText != null) rev.userEdit = overrideText;

    const pending = pendingRevisions();
    const idx = pending.findIndex((r) => r.id === id);
    const remaining = pending.filter((r) => r.id !== id);
    const next = remaining[idx] || remaining[0];
    if (next) state.activeId = next.id;

    render();
  }

  function declineRevision(id) {
    const rev = state.revisions.find((r) => r.id === id);
    if (!rev) return;
    const pending = pendingRevisions();
    rev.status = "declined";
    const idx = pending.findIndex((r) => r.id === id);
    const remaining = pending.filter((r) => r.id !== id);
    const next = remaining[idx] || remaining[0];
    state.activeId = next ? next.id : null;
    render();
  }

  function revertRevision(id) {
    const rev = state.revisions.find((r) => r.id === id);
    if (!rev || rev.status !== "accepted") return;
    const appliedText = rev.appliedText || rev.suggested;
    state.essay = state.essay.replace(appliedText, rev.original);
    rev.status = "pending";
    rev.appliedText = null;
    render();
  }

  function nextRevision() {
    const nav = navigableRevisions();
    if (nav.length === 0) return;
    const idx = nav.findIndex((r) => r.id === state.activeId);
    state.activeId = nav[(idx + 1) % nav.length].id;
    render();
  }

  function prevRevision() {
    const nav = navigableRevisions();
    if (nav.length === 0) return;
    const idx = nav.findIndex((r) => r.id === state.activeId);
    state.activeId = nav[(idx - 1 + nav.length) % nav.length].id;
    render();
  }

  function loadDemo() {
    fetch("/essays/demo")
      .then((r) => r.json())
      .then((data) => {
        state.essay = data.essay;
        state.phase = "reading";
        render();
      });
  }

  function submitEssay() {
    if (!state.pasteValue.trim()) return;
    state.essay = state.pasteValue.trim();
    state.phase = "reading";
    render();
  }

  async function runPass(editorOverride) {
    const useKey = editorOverride && editorByKey(editorOverride) ? editorOverride : state.editorKey;

    // Snapshot the outgoing pass before wiping state
    if (state.appliedEditor && state.revisions.length > 0) {
      state.passHistory.push({
        id: `pass-${Date.now()}`,
        editorKey: state.appliedEditor,
        editorName: editorByKey(state.appliedEditor)?.name || state.appliedEditor,
        timestamp: new Date(),
        verdict: state.verdict,
        revisions: state.revisions.map((r) => ({ ...r })),
      });
    }

    state.isRunning = true;
    state.runningEditor = useKey;
    state.error = null;
    state.revisions = [];
    state.verdict = "";
    state.activeId = null;
    render();

    try {
      const data = await postJSON("/passes", { editor_key: useKey, essay: state.essay });
      state.verdict = data.verdict || "";
      state.revisions = (data.revisions || []).map((r) => ({ ...r, userEdit: null, appliedText: null }));
      state.activeId = state.revisions[0]?.id || null;
      state.appliedEditor = useKey;
      state.passCounts[useKey] = (state.passCounts[useKey] || 0) + 1;
      state.phase = "reviewing";
    } catch (e) {
      state.error = e.message || "Something went wrong.";
      state.phase = "reading";
    } finally {
      state.isRunning = false;
      state.runningEditor = null;
      render();
    }
  }

  function startEdit(id) {
    const rev = state.revisions.find((r) => r.id === id);
    if (!rev) return;
    state.editingId = id;
    state.editValue = rev.userEdit != null ? rev.userEdit : rev.suggested;
    render();
  }

  function saveEdit() {
    const rev = state.revisions.find((r) => r.id === state.editingId);
    if (rev) rev.userEdit = state.editValue;
    state.editingId = null;
    render();
  }

  function cancelEdit() {
    state.editingId = null;
    state.editValue = "";
    render();
  }

  function acceptCurrentEdit() {
    const id = state.editingId;
    const text = state.editValue;
    state.editingId = null;
    acceptRevision(id, text);
  }

  function startOver() {
    Object.assign(state, {
      essay: "",
      pasteValue: "",
      revisions: [],
      verdict: "",
      activeId: null,
      error: null,
      editingId: null,
      phase: "input",
      passHistory: [],
      passCounts: {},
      report: null,
      isGeneratingReport: false,
      _lastScrolledId: null,
      panelPos: null,
    });
    render();
  }

  async function finishRevision() {
    if (state.isGeneratingReport || state.passHistory.length === 0) return;
    state.isGeneratingReport = true;
    state.report = null;
    render();

    try {
      const passes = state.passHistory.map((pass) => ({
        editorName: pass.editorName,
        editorFocus: editorByKey(pass.editorKey)?.focus || "",
        verdict: pass.verdict,
        revisions: pass.revisions.map((r) => ({
          original: r.original,
          suggested: r.suggested,
          principle: r.principle,
          status: r.status,
        })),
      }));

      const data = await postJSON("/synthesis", { essay: state.essay, passes });
      state.report = data.synthesis;
    } catch (e) {
      state.error = e.message || "Could not generate report.";
    } finally {
      state.isGeneratingReport = false;
      render();
    }
  }

  async function copyEssay() {
    try {
      await navigator.clipboard.writeText(state.essay);
      state.copyToast = true;
      render();
      setTimeout(() => {
        state.copyToast = false;
        render();
      }, 1800);
    } catch (e) {
      console.error("Copy failed", e);
    }
  }

  function startEssayEdit() {
    state.isEditingEssay = true;
    state.essayEditValue = state.essay;
    state.editingId = null;
    state.discussingId = null;
    render();
  }

  function saveEssayEdit() {
    state.essay = state.essayEditValue;
    state.revisions.forEach((rev) => {
      if (rev.status === "pending" && !state.essay.includes(rev.original)) {
        rev.status = "declined";
      }
      if (rev.status === "accepted" && !state.essay.includes(rev.appliedText || rev.suggested)) {
        rev.status = "pending";
        rev.appliedText = null;
      }
    });
    state.activeId = pendingRevisions()[0]?.id || null;
    state.isEditingEssay = false;
    render();
  }

  function cancelEssayEdit() {
    state.isEditingEssay = false;
    render();
  }

  function openDiscussion(id) {
    state.discussingId = id;
    state.editingId = null;
    if (!state.conversations[id]) state.conversations[id] = [];
    render();
  }

  function closeDiscussion() {
    state.discussingId = null;
    state.discussInput = "";
    render();
  }

  async function sendDiscussMessage(text, revision) {
    const trimmed = text.trim();
    if (!trimmed || state.isDiscussing) return;

    const revId = revision.id;
    const messages = state.conversations[revId] || [];
    messages.push({ role: "user", content: trimmed });
    state.conversations[revId] = messages;
    state.discussInput = "";
    state.isDiscussing = true;
    render();

    try {
      const data = await postJSON("/discussions", {
        editor_key: state.appliedEditor,
        essay: state.essay,
        revision: {
          original: revision.original,
          suggested: revision.suggested,
          principle: revision.principle,
          explanation: revision.explanation,
        },
        messages,
      });
      messages.push({ role: "assistant", content: data.reply });
    } catch (e) {
      messages.push({ role: "assistant", content: `(Error: ${e.message || "request failed"}.)` });
    } finally {
      state.isDiscussing = false;
      render();
    }
  }

  // ==========================================================================
  // RENDERING
  // ==========================================================================

  function render() {
    hideHoverPopup();
    renderHeader();
    if (state.report !== null || state.isGeneratingReport) {
      renderReportPhase();
    } else if (state.phase === "input") {
      renderInputPhase();
    } else {
      renderReadingOrReviewingPhase();
    }
    renderFooterNav();
  }

  function renderReportPhase() {
    removeEditorPanel();
    const main = document.getElementById("main");
    main.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.className = "report-wrap";

    if (state.isGeneratingReport) {
      const loading = document.createElement("div");
      loading.className = "report-loading";
      loading.innerHTML = `
        <div class="report-loading-dot"></div>
        <div>
          <div class="report-loading-title">Reviewing your session…</div>
          <div class="report-loading-body">Reading your choices, finding patterns. Usually takes 15–20 seconds.</div>
        </div>`;
      wrap.appendChild(loading);
    } else if (state.report) {
      // Stats bar
      const totalPasses = state.passHistory.length;
      const totalAccepted = state.passHistory.reduce((n, p) => n + p.revisions.filter(r => r.status === "accepted").length, 0);
      const totalDeclined = state.passHistory.reduce((n, p) => n + p.revisions.filter(r => r.status === "declined").length, 0);
      const editorNames = [...new Set(state.passHistory.map(p => p.editorName))].join(", ");

      const stats = document.createElement("div");
      stats.className = "report-stats";
      stats.innerHTML = `
        <span class="report-stat">${totalPasses} ${totalPasses === 1 ? "pass" : "passes"}</span>
        <span class="report-stat-sep">·</span>
        <span class="report-stat">${totalAccepted} accepted</span>
        <span class="report-stat-sep">·</span>
        <span class="report-stat">${totalDeclined} declined</span>
        <span class="report-stat-sep">·</span>
        <span class="report-stat report-stat--editors">${editorNames}</span>`;
      wrap.appendChild(stats);

      const prose = document.createElement("div");
      prose.className = "report-prose";
      prose.innerHTML = marked.parse(state.report);
      wrap.appendChild(prose);
    }

    main.appendChild(wrap);
  }

  function renderHeader() {
    const actions = document.getElementById("header-actions");
    actions.innerHTML = "";

    if (state.report !== null || state.isGeneratingReport) {
      const backBtn = document.createElement("button");
      backBtn.className = "btn-ghost";
      backBtn.textContent = "← Back to essay";
      backBtn.onclick = () => { state.report = null; state.isGeneratingReport = false; render(); };
      const newBtn = document.createElement("button");
      newBtn.className = "btn-ghost";
      newBtn.textContent = "New essay";
      newBtn.onclick = startOver;
      actions.append(backBtn, newBtn);
      return;
    }

    if (state.phase === "reading" || state.phase === "reviewing") {
      const newBtn = document.createElement("button");
      newBtn.className = "btn-ghost";
      newBtn.disabled = state.isRunning;
      newBtn.textContent = "New essay";
      newBtn.onclick = startOver;
      actions.appendChild(newBtn);

      if (state.passHistory.length > 0 && !state.isRunning) {
        const finishBtn = document.createElement("button");
        finishBtn.className = "btn-finish";
        finishBtn.textContent = "Finish revision →";
        finishBtn.onclick = finishRevision;
        actions.appendChild(finishBtn);
      }
    }
  }

  function setupPanelDrag(panel, handle) {
    let dragging = false;
    let ox = 0, oy = 0;
    handle.addEventListener("mousedown", (ev) => {
      dragging = true;
      const r = panel.getBoundingClientRect();
      ox = ev.clientX - r.left;
      oy = ev.clientY - r.top;
      ev.preventDefault();
    });
    const onMove = (ev) => {
      if (!dragging) return;
      panel.style.left  = (ev.clientX - ox) + "px";
      panel.style.top   = (ev.clientY - oy) + "px";
      panel.style.right = "auto";
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      const r = panel.getBoundingClientRect();
      state.panelPos = { left: Math.round(r.left), top: Math.round(r.top) };
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",   onUp);
    panel._dragCleanup = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",   onUp);
    };
  }

  function removeEditorPanel() {
    const p = document.getElementById("editor-float-panel");
    if (p) { if (p._dragCleanup) p._dragCleanup(); p.remove(); }
  }

  function renderEditorPanel(hasText) {
    let panel = document.getElementById("editor-float-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id   = "editor-float-panel";
      panel.className = "editor-float-panel";
      if (state.panelPos) {
        panel.style.left  = state.panelPos.left + "px";
        panel.style.top   = state.panelPos.top  + "px";
        panel.style.right = "auto";
      }
      document.body.appendChild(panel);
    } else {
      panel.className = "editor-float-panel";
      if (panel._dragCleanup) { panel._dragCleanup(); panel._dragCleanup = null; }
    }

    panel.innerHTML = "";

    // Handle
    const handle = document.createElement("div");
    handle.className = "efp-handle";
    handle.innerHTML = `<span class="efp-title">Editors</span><span class="efp-grip">⠿</span>`;
    panel.appendChild(handle);
    setupPanelDrag(panel, handle);

    // Editor list
    const list = document.createElement("div");
    list.className = "efp-list";
    editors.forEach((e) => {
      const item = document.createElement("div");
      const sel  = state.editorKey === e.key;
      item.className = "efp-item" +
        (sel          ? " efp-item--selected"   : "") +
        (!e.available ? " efp-item--unavailable" : "");
      item.innerHTML = `<div class="efp-item-content">
        <div class="efp-item-name">${e.name}</div>
        <div class="efp-item-sub">${authorDisplay(e)} · <em>${e.source}</em></div>
      </div>`;
      if (e.available) {
        item.addEventListener("click", () => { state.editorKey = e.key; render(); });
        let hoverTimer = null;
        item.addEventListener("mouseenter", () => { hoverTimer = setTimeout(() => showHoverPopup(e, item), 600); });
        item.addEventListener("mouseleave", () => { clearTimeout(hoverTimer); hoverTimer = null; hideHoverPopup(); });
      }
      list.appendChild(item);
    });
    panel.appendChild(list);

    // Footer
    const footer = document.createElement("div");
    footer.className = "efp-footer";
    const demoBtn = document.createElement("button");
    demoBtn.className = "btn-ghost efp-demo-btn";
    demoBtn.textContent = "Load demo";
    demoBtn.addEventListener("click", loadDemo);
    const continueBtn = document.createElement("button");
    continueBtn.id = "panel-continue-btn";
    continueBtn.className = "btn-primary";
    continueBtn.textContent = "Continue →";
    continueBtn.disabled = !hasText;
    continueBtn.addEventListener("click", submitEssay);
    footer.append(demoBtn, continueBtn);
    panel.appendChild(footer);
  }

  function renderInputPhase() {
    const main = document.getElementById("main");
    main.innerHTML = "";
    const tpl = document.getElementById("tpl-input-phase").content.cloneNode(true);

    const textarea = tpl.getElementById("paste-input");
    textarea.value = state.pasteValue;
    textarea.addEventListener("input", (e) => {
      state.pasteValue = e.target.value;
      const btn = document.getElementById("panel-continue-btn");
      if (btn) btn.disabled = !state.pasteValue.trim();
    });

    main.appendChild(tpl);
    renderEditorPanel(!!state.pasteValue.trim());

    setTimeout(() => textarea.focus(), 0);
  }

  function renderPassHistory(container) {
    if (state.passHistory.length === 0) return;

    const section = document.createElement("div");
    section.className = "pass-history";

    const header = collapsibleHeader(
      `Past passes`,
      state.historyCollapsed,
      () => { state.historyCollapsed = !state.historyCollapsed; render(); }
    );
    section.appendChild(header);

    if (state.historyCollapsed) {
      container.appendChild(section);
      return;
    }

    [...state.passHistory].reverse().forEach((pass) => {
      const accepted = pass.revisions.filter((r) => r.status === "accepted").length;
      const declined = pass.revisions.filter((r) => r.status === "declined").length;
      const isExpanded = state.expandedHistoryId === pass.id;

      const row = document.createElement("div");
      row.className = "history-row" + (isExpanded ? " history-row--open" : "");

      // Header
      const header = document.createElement("div");
      header.className = "history-row-header";

      const name = document.createElement("span");
      name.className = "history-editor-name";
      name.textContent = pass.editorName;

      const stats = document.createElement("span");
      stats.className = "history-stats";
      const parts = [];
      if (accepted > 0) parts.push(`${accepted} accepted`);
      if (declined > 0) parts.push(`${declined} declined`);
      if (parts.length === 0) parts.push("no revisions");
      stats.textContent = parts.join(" · ");

      const time = document.createElement("span");
      time.className = "history-time";
      time.textContent = pass.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

      const chevron = document.createElement("span");
      chevron.className = "history-chevron";
      chevron.textContent = isExpanded ? "▴" : "▾";

      header.append(name, stats, time, chevron);
      header.addEventListener("click", () => {
        state.expandedHistoryId = isExpanded ? null : pass.id;
        render();
      });
      row.appendChild(header);

      if (isExpanded) {
        if (pass.verdict) {
          const verdict = document.createElement("div");
          verdict.className = "history-verdict";
          verdict.textContent = pass.verdict;
          row.appendChild(verdict);
        }

        const list = document.createElement("div");
        list.className = "history-rev-list";

        pass.revisions.forEach((rev) => {
          const item = document.createElement("div");
          item.className = `history-rev-item history-rev-item--${rev.status}`;

          const meta = document.createElement("div");
          meta.className = "history-rev-meta";

          const principle = document.createElement("span");
          principle.className = "rev-principle";
          principle.textContent = rev.principle;
          meta.appendChild(principle);

          const badge = document.createElement("span");
          badge.className = `history-rev-badge history-rev-badge--${rev.status}`;
          badge.textContent = rev.status;
          meta.appendChild(badge);

          item.appendChild(meta);

          const original = document.createElement("div");
          original.className = "history-rev-original";
          original.innerHTML = marked.parseInline(`"${rev.original}"`);
          item.appendChild(original);

          if (rev.status === "accepted") {
            const applied = document.createElement("div");
            applied.className = "history-rev-applied";
            applied.innerHTML = "→ " + marked.parseInline(`"${rev.appliedText || rev.suggested}"`);
            item.appendChild(applied);
          }

          list.appendChild(item);
        });

        row.appendChild(list);
      }

      section.appendChild(row);
    });

    container.appendChild(section);
  }

  function buildCompactCard(e) {
    const card = document.getElementById("tpl-editor-compact-card").content.cloneNode(true);
    const wrapper = card.querySelector(".compact-card");
    const isSelected = state.editorKey === e.key;
    wrapper.classList.toggle("compact-card-active", isSelected);
    card.querySelector(".compact-card-name").textContent = e.name;
    card.querySelector(".compact-card-author").textContent = authorDisplay(e);
    card.querySelector(".compact-card-usecase").textContent = e.focus || e.useCase;
    const count = state.passCounts[e.key] || 0;
    if (count > 0) {
      const badge = document.createElement("span");
      badge.className = "compact-card-count";
      badge.textContent = count;
      card.querySelector(".compact-card-name").appendChild(badge);
    }
    const selectBtn = card.querySelector(".compact-card-select");
    const aboutBtn = card.querySelector(".compact-card-about");
    if (!e.available) {
      wrapper.classList.add("compact-card-unavailable");
      selectBtn.disabled = true;
      aboutBtn.disabled = true;
    } else if (isSelected) {
      selectBtn.textContent = "Selected ✓";
      selectBtn.classList.add("compact-card-select--active");
      selectBtn.disabled = true;
    }
    selectBtn.addEventListener("click", () => {
      if (!e.available || isSelected) return;
      state.editorKey = e.key;
      render();
    });
    aboutBtn.addEventListener("click", () => showEditorInfo(e));
    return card;
  }

  function renderEditingPanel() {
    let panel = document.getElementById("editor-float-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "editor-float-panel";
      panel.className = "editor-float-panel editor-float-panel--editing";
      if (state.panelPos) {
        panel.style.left = state.panelPos.left + "px";
        panel.style.top = state.panelPos.top + "px";
        panel.style.right = "auto";
      }
      document.body.appendChild(panel);
    } else {
      panel.className = "editor-float-panel editor-float-panel--editing";
      if (panel._dragCleanup) { panel._dragCleanup(); panel._dragCleanup = null; }
    }
    panel.innerHTML = "";

    // Drag handle
    const handle = document.createElement("div");
    handle.className = "efp-handle";
    const grip = document.createElement("span");
    grip.className = "efp-grip";
    grip.textContent = "⠿";
    handle.appendChild(grip);
    if (state.isRunning) {
      const editorName = document.createElement("span");
      editorName.className = "efp-title";
      editorName.textContent = editorByKey(state.runningEditor)?.name || "";
      handle.appendChild(editorName);
    }
    panel.appendChild(handle);
    setupPanelDrag(panel, handle);

    // Error
    if (state.error) {
      const err = document.createElement("div");
      err.className = "efp-error";
      err.textContent = state.error;
      panel.appendChild(err);
    }

    if (state.isRunning) {
      // Running: active item + verb animation
      const runSection = document.createElement("div");
      runSection.className = "efp-body efp-running-section";
      const activeEditor = editors.find((e) => e.key === state.runningEditor);
      if (activeEditor) {
        const activeItem = document.createElement("div");
        activeItem.className = "efp-item efp-item--selected";
        activeItem.innerHTML = `<div class="efp-item-name">${activeEditor.name}</div>
          <div class="efp-item-sub">${authorDisplay(activeEditor)} · <em>${activeEditor.source}</em></div>`;
        runSection.appendChild(activeItem);
      }
      const verb = document.createElement("div");
      verb.id = "running-banner-body";
      verb.className = "running-banner-body efp-verb";
      verb.textContent = "Reading your essay…";
      runSection.appendChild(verb);
      panel.appendChild(runSection);
    } else {
      const body = document.createElement("div");
      body.className = "efp-body";

      // Filter bar
      const FILTERS = [
        { value: "all",               label: "All editors" },
        { value: "core_editorial",    label: "Core editorial" },
        { value: "extended_editorial",label: "Extended editorial" },
        { value: "core_academic",     label: "Core academic" },
        { value: "extended_academic", label: "Extended academic" },
      ];
      const filterBar = document.createElement("div");
      filterBar.className = "efp-filter-bar";
      const filterHeading = document.createElement("div");
      filterHeading.className = "efp-filter-heading";
      filterHeading.textContent = "Filter by focus";
      filterBar.appendChild(filterHeading);
      FILTERS.forEach(({ value, label }) => {
        const btn = document.createElement("button");
        btn.className = "efp-filter-btn" + (state.editorFilter === value ? " efp-filter-btn--active" : "");
        btn.textContent = label;
        btn.addEventListener("click", () => { state.editorFilter = value; render(); });
        filterBar.appendChild(btn);
      });
      body.appendChild(filterBar);

      // Editor list with label
      const editorSection = document.createElement("div");
      editorSection.className = "efp-section";
      const editorLabel = document.createElement("div");
      editorLabel.className = "efp-section-label";
      editorLabel.textContent = "Select an editor and run a pass";
      editorSection.appendChild(editorLabel);
      {
        const visibleEditors = state.editorFilter === "all"
          ? editors
          : editors.filter((e) => e.category === state.editorFilter);
        const itemList = document.createElement("div");
        itemList.className = "efp-list";
        visibleEditors.forEach((e) => {
          const item = document.createElement("div");
          const sel = state.editorKey === e.key;
          const count = state.passCounts[e.key] || 0;
          const countHtml = count > 0 ? ` <span class="efp-item-count">${count}×</span>` : "";
          item.className = "efp-item" +
            (sel ? " efp-item--selected" : "") +
            (!e.available ? " efp-item--unavailable" : "");
          item.innerHTML = `<div class="efp-item-content">
            <div class="efp-item-name">${e.name}${countHtml}</div>
            <div class="efp-item-sub">${authorDisplay(e)} · <em>${e.source}</em></div>
          </div>`;
          if (e.available) {
            item.addEventListener("click", () => { state.editorKey = e.key; render(); });
            const runBtn = document.createElement("button");
            runBtn.className = "efp-item-run";
            runBtn.textContent = "Run";
            runBtn.addEventListener("click", (ev) => {
              ev.stopPropagation();
              state.editorKey = e.key;
              runPass();
            });
            item.appendChild(runBtn);
            let hoverTimer = null;
            item.addEventListener("mouseenter", () => { hoverTimer = setTimeout(() => showHoverPopup(e, item), 600); });
            item.addEventListener("mouseleave", () => { clearTimeout(hoverTimer); hoverTimer = null; hideHoverPopup(); });
          }
          itemList.appendChild(item);
        });
        editorSection.appendChild(itemList);
      }
      body.appendChild(editorSection);

      // All resolved notice
      if (state.phase === "reviewing") {
        const pending = pendingRevisions();
        if (state.revisions.length > 0 && pending.length === 0) {
          const accepted = state.revisions.filter((r) => r.status === "accepted").length;
          const declined = state.revisions.filter((r) => r.status === "declined").length;
          const ar = document.createElement("div");
          ar.className = "efp-section efp-all-resolved";
          ar.innerHTML = `<span class="mono-label">Pass complete · </span><span class="efp-resolved-text">${accepted} accepted, ${declined} declined.</span>`;
          body.appendChild(ar);
        }
      }

      panel.appendChild(body);
    }
  }

  function renderReadingOrReviewingPhase() {
    clearInterval(phraseIntervalId);
    phraseIntervalId = null;
    const main = document.getElementById("main");
    main.innerHTML = "";
    const tpl = document.getElementById("tpl-reading-phase").content.cloneNode(true);
    const sheet = tpl.querySelector(".document-sheet--editing");

    // Editorial header: status + verdict + history, above the essay
    if (state.phase === "reviewing" && state.appliedEditor) {
      const hdr = document.createElement("div");
      hdr.className = "doc-editorial-header";

      // Status line: editor name + revision counts
      const e = editorByKey(state.appliedEditor);
      const pendingCount = pendingRevisions().length;
      const accepted = state.revisions.filter((r) => r.status === "accepted").length;
      const declined  = state.revisions.filter((r) => r.status === "declined").length;
      const allDone   = state.revisions.length > 0 && pendingCount === 0;

      const statusLine = document.createElement("div");
      statusLine.className = "doc-status-line";

      const editorLabel = document.createElement("span");
      editorLabel.className = "doc-status-editor";
      editorLabel.textContent = e?.name || "";
      statusLine.appendChild(editorLabel);

      const sep = document.createElement("span");
      sep.className = "doc-status-sep";
      sep.textContent = "·";
      statusLine.appendChild(sep);

      const countsEl = document.createElement("span");
      countsEl.className = "doc-status-counts" + (allDone ? " doc-status-counts--done" : "");
      countsEl.textContent = allDone
        ? `All reviewed — ${accepted} accepted · ${declined} declined`
        : `${pendingCount} pending · ${accepted} accepted · ${declined} declined`;
      statusLine.appendChild(countsEl);

      hdr.appendChild(statusLine);

      // Verdict block
      if (state.verdict) {
        const verdictBlock = document.createElement("div");
        verdictBlock.className = "doc-verdict-block";

        const verdictLabel = document.createElement("div");
        verdictLabel.className = "doc-verdict-label";
        verdictLabel.textContent = "Verdict";
        verdictBlock.appendChild(verdictLabel);

        const verdictText = document.createElement("div");
        verdictText.className = "doc-verdict-text";
        verdictText.textContent = state.verdict;
        verdictBlock.appendChild(verdictText);

        hdr.appendChild(verdictBlock);
      }

      // Pass history (collapsible)
      if (state.passHistory.length > 0) {
        renderPassHistory(hdr);
      }

      sheet.insertBefore(hdr, sheet.firstChild);
    }

    // Essay workspace inside the document sheet
    const article = tpl.getElementById("essay-prose");
    const workspace = document.createElement("div");
    workspace.className = "essay-workspace";
    article.replaceWith(workspace);

    if (state.isEditingEssay) {
      const ta = document.createElement("textarea");
      ta.className = "essay-editor";
      ta.value = state.essayEditValue;
      ta.addEventListener("input", (ev) => { state.essayEditValue = ev.target.value; });
      const bar = document.createElement("div");
      bar.className = "essay-edit-bar";
      bar.appendChild(button("btn-primary", "Save", saveEssayEdit));
      bar.appendChild(button("btn-ghost", "Cancel", cancelEssayEdit));
      workspace.appendChild(ta);
      workspace.appendChild(bar);
      setTimeout(() => ta.focus(), 0);
    } else if (state.phase === "reading") {
      const prose = document.createElement("div");
      prose.className = "essay-prose essay-prose--rendered";
      prose.innerHTML = marked.parse(state.essay);
      workspace.appendChild(prose);
    } else {
      const prose = document.createElement("article");
      prose.className = "essay-prose";
      workspace.appendChild(prose);
      renderEssaySegments(prose);
    }

    // Document action bar: Edit text + Copy essay, bottom of the white card
    if (!state.isEditingEssay && !state.isRunning) {
      const docActions = document.createElement("div");
      docActions.className = "doc-action-bar";
      const editBtn = document.createElement("button");
      editBtn.className = "doc-action-btn";
      editBtn.textContent = "Edit text";
      editBtn.addEventListener("click", startEssayEdit);
      docActions.appendChild(editBtn);
      if (state.phase === "reviewing") {
        const copyBtn = document.createElement("button");
        copyBtn.className = "doc-action-btn";
        copyBtn.textContent = state.copyToast ? "Copied ✓" : "Copy essay";
        copyBtn.addEventListener("click", copyEssay);
        docActions.appendChild(copyBtn);
      }
      sheet.appendChild(docActions);
    }

    main.appendChild(tpl);
    renderEditingPanel();

    if (state.isRunning) startRunningAnimation(state.runningEditor);

    if (state.activeId && segmentRefs[state.activeId] && state.activeId !== state._lastScrolledId) {
      state._lastScrolledId = state.activeId;
      const el = segmentRefs[state.activeId];
      const rect = el.getBoundingClientRect();
      const inView = rect.top >= 100 && rect.bottom <= window.innerHeight - 100;
      if (!inView) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function renderEssaySegments(article) {
    article.innerHTML = "";
    Object.keys(segmentRefs).forEach((k) => delete segmentRefs[k]);

    buildSegments().forEach((seg) => {
      if (seg.kind === "text") {
        const el = document.createElement("span");
        el.innerHTML = marked.parseInline(seg.content);
        article.appendChild(el);
        return;
      }
      const isActive = seg.rev.id === state.activeId;
      const isAccepted = seg.rev.status === "accepted";
      const span = document.createElement("span");
      span.innerHTML = marked.parseInline(seg.content);
      span.className = isAccepted
        ? isActive ? "rev-accepted-active" : "rev-accepted"
        : isActive ? "rev-active" : "rev-pending";
      span.addEventListener("click", () => {
        state.activeId = seg.rev.id;
        render();
      });
      segmentRefs[seg.rev.id] = span;
      article.appendChild(span);

      if (isActive) {
        const wrapper = document.createElement("span");
        wrapper.style.display = "block";
        wrapper.style.whiteSpace = "normal";
        wrapper.appendChild(renderRevisionCard(seg.rev));
        article.appendChild(wrapper);
      }
    });
  }

  function renderRevisionCard(revision) {
    const tpl = document.getElementById("tpl-revision-card").content.cloneNode(true);
    const card = tpl.querySelector(".rev-card");
    const isAccepted = revision.status === "accepted";
    const isEditing = state.editingId === revision.id;
    const isDiscussOpen = state.discussingId === revision.id;
    const hasUserEdit = revision.userEdit != null;
    const finalText = isEditing
      ? state.editValue
      : isAccepted
        ? revision.appliedText || revision.suggested
        : hasUserEdit ? revision.userEdit : revision.suggested;

    card.classList.toggle("accepted", isAccepted);

    const principle = tpl.querySelector(".rev-principle");
    principle.textContent = revision.principle;
    if (isAccepted) {
      const tag = document.createElement("span");
      tag.className = "rev-tag accepted-tag";
      tag.textContent = " · accepted";
      principle.appendChild(tag);
    } else if (hasUserEdit && !isEditing) {
      const tag = document.createElement("span");
      tag.className = "rev-tag edited-tag";
      tag.textContent = " · edited";
      principle.appendChild(tag);
    }

    const body = tpl.querySelector(".rev-body");
    if (isAccepted) {
      body.innerHTML = `
        <div class="rev-block-label">Original</div>
        <div class="rev-text"><span class="rev-strike">${escapeHtml(revision.original)}</span></div>
        <div class="rev-block-label">Now reads</div>
        <div class="rev-text"><span class="rev-highlight-green">${escapeHtml(finalText)}</span></div>
      `;
    } else if (isEditing) {
      body.innerHTML = `<div class="rev-block-label">Suggestion</div>`;
      const textarea = document.createElement("textarea");
      textarea.className = "rev-edit-textarea";
      textarea.value = state.editValue;
      textarea.addEventListener("input", (e) => {
        state.editValue = e.target.value;
      });
      body.appendChild(textarea);
      setTimeout(() => textarea.focus(), 0);
    } else {
      body.innerHTML = `
        <div class="rev-block-label">Suggestion</div>
        <div class="rev-text"><span class="rev-highlight-green">${escapeHtml(finalText)}</span></div>
      `;
    }

    tpl.querySelector(".rev-explanation").textContent = revision.explanation || "";

    const actions = tpl.querySelector(".rev-actions");
    if (isEditing) {
      actions.appendChild(button("btn-primary btn-success", "Save & accept", acceptCurrentEdit));
      actions.appendChild(button("btn-ghost", "Save edit", saveEdit));
      actions.appendChild(button("btn-ghost", "Cancel", cancelEdit));
    } else if (isAccepted) {
      actions.appendChild(button("btn-ghost", "Revert to original", () => revertRevision(revision.id)));
      actions.appendChild(
        button("btn-ghost", isDiscussOpen ? "Close discussion" : "Discuss", () =>
          isDiscussOpen ? closeDiscussion() : openDiscussion(revision.id)
        )
      );
    } else {
      actions.appendChild(button("btn-primary btn-success", "Accept", () => acceptRevision(revision.id)));
      actions.appendChild(button("btn-ghost", "Edit", () => startEdit(revision.id)));
      actions.appendChild(
        button("btn-ghost", isDiscussOpen ? "Close discussion" : "Discuss", () =>
          isDiscussOpen ? closeDiscussion() : openDiscussion(revision.id)
        )
      );
      actions.appendChild(button("btn-ghost", "Decline", () => declineRevision(revision.id)));
    }

    const discussion = tpl.querySelector(".rev-discussion");
    if (isDiscussOpen) {
      discussion.hidden = false;
      renderDiscussion(discussion, revision);
    }

    return card;
  }

  function renderDiscussion(container, revision) {
    const editorName = state.appliedEditor ? editorByKey(state.appliedEditor)?.name || "Editor" : "Editor";
    const conversation = state.conversations[revision.id] || [];

    container.innerHTML = `<div class="discuss-identity">In conversation with ${editorName} <span class="sep">·</span> <span class="muted">about this revision</span></div>`;

    if (conversation.length > 0) {
      const history = document.createElement("div");
      history.className = "discuss-history";
      conversation.forEach((msg) => {
        const block = document.createElement("div");
        block.className = "discuss-message";
        block.innerHTML = `<div class="discuss-role ${msg.role === "user" ? "role-user" : "role-editor"}">${msg.role === "user" ? "You" : editorName}</div><div class="discuss-content">${escapeHtml(msg.content)}</div>`;
        if (msg.role === "assistant") {
          const useBtn = document.createElement("button");
          useBtn.className = "btn-ghost discuss-use-btn";
          useBtn.textContent = "Use as suggestion →";
          useBtn.addEventListener("click", () => {
            state.editValue = extractSuggestionText(msg.content);
            state.editingId = revision.id;
            state.discussingId = null;
            state.discussInput = "";
            render();
          });
          block.appendChild(useBtn);
        }
        history.appendChild(block);
      });
      if (state.isDiscussing) {
        const typing = document.createElement("div");
        typing.className = "discuss-message";
        typing.innerHTML = `<div class="discuss-role role-editor">${editorName}</div><div class="typing">···</div>`;
        history.appendChild(typing);
      }
      container.appendChild(history);
    } else if (!state.isDiscussing) {
      const chips = document.createElement("div");
      chips.className = "discuss-chips";
      ["Why does this matter?", "Suggest an alternative wording.", "Is the original defensible?"].forEach((q) => {
        const chip = document.createElement("button");
        chip.className = "chip";
        chip.textContent = q;
        chip.addEventListener("click", () => sendDiscussMessage(q, revision));
        chips.appendChild(chip);
      });
      container.appendChild(chips);
    }

    const inputRow = document.createElement("div");
    inputRow.className = "discuss-input-row";
    const textarea = document.createElement("textarea");
    textarea.placeholder = `Ask ${editorName} about this suggestion…`;
    textarea.disabled = state.isDiscussing;
    textarea.value = state.discussInput;
    textarea.rows = 2;
    textarea.addEventListener("input", (e) => (state.discussInput = e.target.value));
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendDiscussMessage(state.discussInput, revision);
      }
    });
    const sendBtn = document.createElement("button");
    sendBtn.className = "btn-primary";
    sendBtn.textContent = "Send";
    sendBtn.disabled = !state.discussInput.trim() || state.isDiscussing;
    sendBtn.addEventListener("click", () => sendDiscussMessage(state.discussInput, revision));
    inputRow.append(textarea, sendBtn);
    container.appendChild(inputRow);

    const hint = document.createElement("div");
    hint.className = "discuss-hint";
    hint.textContent = "↵ to send · ⇧↵ for newline";
    container.appendChild(hint);

    setTimeout(() => {
      const h = container.querySelector(".discuss-history");
      if (h) h.scrollTop = h.scrollHeight;
    }, 0);
  }

  function renderFooterNav() {
    const footer = document.getElementById("footer-nav");
    footer.innerHTML = "";
    if (state.phase !== "reviewing") return;
    const nav = navigableRevisions();
    if (nav.length === 0) return;

    const activeIdx = nav.findIndex((r) => r.id === state.activeId);
    const bar = document.createElement("div");
    bar.className = "footer-nav-bar";
    bar.innerHTML = `
      <button class="nav-arrow" id="prev-rev-btn" title="Previous (↑ or k)">↑</button>
      <span class="mono-label nav-counter">${activeIdx >= 0 ? activeIdx + 1 : "–"} of ${nav.length}</span>
      <button class="nav-arrow" id="next-rev-btn" title="Next (↓ or j)">↓</button>
      <span class="footer-divider"></span>
      <span class="mono-label nav-hint">↵ accept · ⌫ decline</span>
    `;
    footer.appendChild(bar);
    document.getElementById("prev-rev-btn").addEventListener("click", prevRevision);
    document.getElementById("next-rev-btn").addEventListener("click", nextRevision);
  }

  function showHoverPopup(editor, triggerEl) {
    let popup = document.getElementById("efp-hover-popup");
    if (!popup) {
      popup = document.createElement("div");
      popup.id = "efp-hover-popup";
      popup.className = "efp-hover-popup";
      document.body.appendChild(popup);
    }
    popup.innerHTML = `<div class="efp-popup-name">${editor.name}</div>
      <div class="efp-popup-byline">${authorDisplay(editor)} · <em>${editor.source}</em></div>
      <div class="efp-popup-lead">${editor.lead || editor.focus || ""}</div>`;
    popup.hidden = false;
    const r = triggerEl.getBoundingClientRect();
    const popupW = 240;
    popup.style.left = Math.max(8, r.left - popupW - 12) + "px";
    popup.style.top = Math.round(r.top + r.height / 2) + "px";
    popup.style.transform = "translateY(-50%)";
  }

  function hideHoverPopup() {
    const popup = document.getElementById("efp-hover-popup");
    if (popup) popup.hidden = true;
  }

  function showEditorInfo(e) {
    document.getElementById("editor-info-name").textContent = e.name;
    document.getElementById("editor-info-byline").textContent = `${authorDisplay(e)} · ${e.source}`;
    document.getElementById("editor-info-lead").textContent = e.lead || e.focus;
    document.getElementById("editor-info-readmore").href = `/editors/${e.key}`;
    document.getElementById("editor-info-modal").hidden = false;
  }

  function hideEditorInfo() {
    document.getElementById("editor-info-modal").hidden = true;
  }

  document.getElementById("editor-info-backdrop").addEventListener("click", hideEditorInfo);
  document.getElementById("editor-info-close").addEventListener("click", hideEditorInfo);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideEditorInfo(); });

  function extractSuggestionText(text) {
    const matches = [];
    const curlyRe = /“([\s\S]*?)”/g;
    const straightRe = /"([\s\S]*?)"/g;
    let m;
    while ((m = curlyRe.exec(text)) !== null) matches.push(m[1]);
    while ((m = straightRe.exec(text)) !== null) matches.push(m[1]);
    if (matches.length === 0) return text;
    return matches.reduce((a, b) => (b.length > a.length ? b : a));
  }

  function button(className, label, onClick) {
    const btn = document.createElement("button");
    btn.className = className;
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ==========================================================================
  // KEYBOARD SHORTCUTS
  // ==========================================================================

  document.addEventListener("keydown", (e) => {
    if (state.phase !== "reviewing" || state.editingId || state.isEditingEssay) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "textarea" || tag === "input") return;

    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      nextRevision();
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      prevRevision();
    } else if (e.key === "Enter" && !e.shiftKey && state.activeId) {
      const active = state.revisions.find((r) => r.id === state.activeId);
      if (active && active.status === "pending") {
        e.preventDefault();
        acceptRevision(state.activeId);
      }
    } else if ((e.key === "Backspace" || e.key === "d") && state.activeId) {
      const active = state.revisions.find((r) => r.id === state.activeId);
      if (active && active.status === "pending") {
        e.preventDefault();
        declineRevision(state.activeId);
      }
    }
  });

  render();
}

// ============================================================================
// EDITOR PRIMER PAGE (prompt editing)
// ============================================================================

function initEditorPrimer() {
  const draft = document.getElementById("prompt-draft");
  if (!draft) return;

  const editorKey = window.EDITWISE_EDITOR_KEY;
  const defaultPrompt = window.EDITWISE_DEFAULT_PROMPT;
  const savedPrompt = draft.value;

  const saveBtn = document.getElementById("save-prompt-btn");
  const resetBtn = document.getElementById("reset-prompt-btn");
  const charCount = document.getElementById("char-count");
  const badge = document.getElementById("customised-badge");

  function syncSaveButton() {
    saveBtn.disabled = draft.value === savedPrompt;
    charCount.textContent = `${draft.value.length.toLocaleString()} chars`;
  }

  draft.addEventListener("input", () => {
    saveBtn.textContent = "Save changes";
    syncSaveButton();
  });

  saveBtn.addEventListener("click", async () => {
    const data = await postJSON(`/editors/${editorKey}/prompt`, { prompt: draft.value }).catch((e) => {
      alert(e.message);
      return null;
    });
    if (!data) return;
    saveBtn.textContent = "Saved";
    saveBtn.disabled = true;
    badge.hidden = false;
    resetBtn.disabled = false;
    setTimeout(() => (saveBtn.textContent = "Save changes"), 2400);
  });

  resetBtn.addEventListener("click", async () => {
    const response = await fetch(`/editors/${editorKey}/prompt`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken() },
    });
    if (!response.ok) return;
    draft.value = defaultPrompt;
    badge.hidden = true;
    resetBtn.disabled = true;
    syncSaveButton();
  });

  syncSaveButton();
}

document.addEventListener("DOMContentLoaded", () => {
  initEssayApp();
  initEditorPrimer();
});
