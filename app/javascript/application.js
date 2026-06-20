// Proofs — vanilla JS port of the original React/TSX prototype.
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
    verdict: "",
    copyToast: false,
    discussingId: null,
    conversations: {}, // revId -> [{role, content}]
    discussInput: "",
    isDiscussing: false,
    isEditingEssay: false,
    essayEditValue: "",
  };

  const segmentRefs = {};

  function editorByKey(key) {
    return editors.find((e) => e.key === key);
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
    });
    render();
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
    renderHeader();
    if (state.phase === "input") {
      renderInputPhase();
    } else {
      renderReadingOrReviewingPhase();
    }
    renderFooterNav();
  }

  function renderHeader() {
    const actions = document.getElementById("header-actions");
    actions.innerHTML = "";
    if (state.phase === "reading" || state.phase === "reviewing") {
      const runBtn = document.createElement("button");
      runBtn.className = "btn-primary";
      runBtn.disabled = state.isRunning || !state.essay;
      const editor = editorByKey(state.editorKey);
      runBtn.textContent = state.isRunning
        ? "Reading…"
        : state.phase === "reviewing"
          ? `Run ${editor?.name} again`
          : `Run ${editor?.name}`;
      runBtn.onclick = () => runPass();

      const newBtn = document.createElement("button");
      newBtn.className = "btn-ghost";
      newBtn.disabled = state.isRunning;
      newBtn.textContent = "New essay";
      newBtn.title = "Start over with a new essay";
      newBtn.onclick = startOver;

      actions.append(runBtn, newBtn);
    }
  }

  function renderInputPhase() {
    const main = document.getElementById("main");
    main.innerHTML = "";
    const tpl = document.getElementById("tpl-input-phase").content.cloneNode(true);

    const textarea = tpl.getElementById("paste-input");
    textarea.value = state.pasteValue;
    textarea.addEventListener("input", (e) => {
      state.pasteValue = e.target.value;
      document.getElementById("continue-btn").disabled = !state.pasteValue.trim();
    });

    tpl.getElementById("load-demo-btn").addEventListener("click", loadDemo);
    const continueBtn = tpl.getElementById("continue-btn");
    continueBtn.disabled = !state.pasteValue.trim();
    continueBtn.addEventListener("click", submitEssay);

    const cardsContainer = tpl.getElementById("editor-cards");
    editors.forEach((e) => {
      const card = document.getElementById("tpl-editor-card").content.cloneNode(true);
      const btn = card.querySelector(".editor-card");
      btn.disabled = !e.available;
      card.querySelector(".editor-card-name").textContent = e.name;
      card.querySelector(".editor-card-author").innerHTML = `${e.author}, <em>${e.source}</em>`;
      card.querySelector(".editor-card-focus").textContent = e.focus;
      btn.addEventListener("click", () => {
        if (e.available) showEditorInfo(e);
      });
      cardsContainer.appendChild(card);
    });

    main.appendChild(tpl);
  }

  function renderReadingOrReviewingPhase() {
    const main = document.getElementById("main");
    main.innerHTML = "";
    const tpl = document.getElementById("tpl-reading-phase").content.cloneNode(true);

    // Editor picker
    tpl.getElementById("picker-label").textContent =
      state.phase === "reviewing" ? "Switch editor for next pass" : "Pick an editor";
    const compactGrid = tpl.getElementById("editor-compact-cards");
    editors.forEach((e) => {
      const card = document.getElementById("tpl-editor-compact-card").content.cloneNode(true);
      const wrapper = card.querySelector(".compact-card");
      const isSelected = state.editorKey === e.key;
      wrapper.classList.toggle("compact-card-active", isSelected);
      wrapper.classList.toggle("disabled", !e.available);
      wrapper.tabIndex = e.available ? 0 : -1;
      wrapper.setAttribute("aria-pressed", String(isSelected));
      card.querySelector(".compact-card-name").textContent = e.name;
      card.querySelector(".compact-card-author").textContent = e.author;
      card.querySelector(".compact-card-usecase").textContent = e.useCase;
      card.querySelector(".info-button").addEventListener("click", (ev) => {
        ev.stopPropagation();
        window.location.href = `/editors/${e.key}`;
      });
      wrapper.addEventListener("click", () => {
        if (!e.available) return;
        state.editorKey = e.key;
        render();
      });
      wrapper.addEventListener("keydown", (ev) => {
        if (e.available && (ev.key === "Enter" || ev.key === " ")) {
          ev.preventDefault();
          state.editorKey = e.key;
          render();
        }
      });
      compactGrid.appendChild(card);
    });

    // Running banner
    if (state.isRunning) {
      tpl.getElementById("running-banner").hidden = false;
      tpl.getElementById("running-banner-title").textContent =
        `${editorByKey(state.runningEditor)?.name || "Editor"} is reading`;
    }

    // Status bar
    const statusLeft = tpl.getElementById("status-left");
    if (state.phase === "reading") {
      statusLeft.innerHTML = `<span class="mono-label">Ready · pick an editor and run a pass</span>`;
    } else if (state.phase === "reviewing" && state.appliedEditor) {
      const e = editorByKey(state.appliedEditor);
      const pendingCount = pendingRevisions().length;
      const accepted = state.revisions.filter((r) => r.status === "accepted").length;
      const declined = state.revisions.filter((r) => r.status === "declined").length;
      statusLeft.innerHTML = `<span class="editor-badge">${e?.name || ""}</span><span class="mono-label">${pendingCount} pending · ${accepted} accepted · ${declined} declined</span>`;
    }
    if (state.phase === "reviewing") {
      const copyBtn = tpl.getElementById("copy-essay-btn");
      copyBtn.hidden = false;
      copyBtn.textContent = state.copyToast ? "Copied" : "Copy essay";
      copyBtn.addEventListener("click", copyEssay);
    }
    const editTextBtn = document.createElement("button");
    editTextBtn.className = "btn-ghost";
    editTextBtn.textContent = state.isEditingEssay ? "Editing…" : "Edit text";
    editTextBtn.disabled = state.isRunning || state.isEditingEssay;
    editTextBtn.addEventListener("click", startEssayEdit);
    tpl.getElementById("status-left").after(editTextBtn);

    // Error
    if (state.error) {
      const box = tpl.getElementById("error-box");
      box.hidden = false;
      box.textContent = state.error;
    }

    // Verdict
    if (state.phase === "reviewing" && state.verdict) {
      tpl.getElementById("verdict-card").hidden = false;
      tpl.getElementById("verdict-text").textContent = state.verdict;
    }

    // All resolved
    const pending = pendingRevisions();
    const allResolved = state.revisions.length > 0 && pending.length === 0;
    if (state.phase === "reviewing" && allResolved) {
      const accepted = state.revisions.filter((r) => r.status === "accepted").length;
      const declined = state.revisions.filter((r) => r.status === "declined").length;
      tpl.getElementById("all-resolved-banner").hidden = false;
      tpl.getElementById("all-resolved-text").textContent =
        `All revisions reviewed. ${accepted} accepted, ${declined} declined. You can run another pass with the same or a different editor.`;
    }

    // Essay body
    const article = tpl.getElementById("essay-prose");
    if (state.isEditingEssay) {
      const ta = document.createElement("textarea");
      ta.className = "essay-edit-textarea";
      ta.value = state.essayEditValue;
      ta.addEventListener("input", (e) => { state.essayEditValue = e.target.value; });
      const bar = document.createElement("div");
      bar.className = "essay-edit-bar";
      bar.appendChild(button("btn-primary", "Save", saveEssayEdit));
      bar.appendChild(button("btn-ghost", "Cancel", cancelEssayEdit));
      article.appendChild(ta);
      article.appendChild(bar);
      setTimeout(() => ta.focus(), 0);
    } else if (state.phase === "reading") {
      article.textContent = state.essay;
    } else {
      renderEssaySegments(article);
    }

    main.appendChild(tpl);

    if (state.activeId && segmentRefs[state.activeId]) {
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
        article.appendChild(document.createTextNode(seg.content));
        return;
      }
      const isActive = seg.rev.id === state.activeId;
      const isAccepted = seg.rev.status === "accepted";
      const span = document.createElement("span");
      span.textContent = seg.content;
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

  function showEditorInfo(e) {
    document.getElementById("editor-info-name").textContent = e.name;
    document.getElementById("editor-info-byline").textContent = `${e.author} · ${e.source}`;
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
