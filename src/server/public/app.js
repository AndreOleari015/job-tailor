/*
 * No framework, no bundler. Every piece of text that reaches the DOM goes in as
 * textContent: job descriptions, company names and model output are all
 * third-party strings, and none of them may ever be parsed as HTML.
 */

const SETTINGS_KEY = "job-tailor.search";

/** What the language column prints. "unknown" means too little prose to tell. */
const LANGUAGE_LABELS = {de: "German", en: "English", unknown: "—"};

const POLL_MS = 2000;

/** Flags that stop the renderer producing a PDF. Shown in the warning colour. */
const BLOCKING_FLAGS = new Set([
    "UNEXPECTED_AUTHORISATION_CLAIM",
    "COVER_LETTER_REF_MISMATCH",
    "UNSUPPORTED_TECH_CLAIM",
    "INVALID_BULLET_IDS_DROPPED",
]);

const state = {
    postings: [],
    selectedId: null,
    status: "",
};

/* ------------------------------------------------------------------ */
/* DOM helpers                                                          */
/* ------------------------------------------------------------------ */

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
}

function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
}

function $(id) {
    return document.getElementById(id);
}

async function api(path, options = {}) {
    // Only claim to send JSON when there is JSON to send: a content-type with
    // an empty body is a request that describes itself wrongly, and a strict
    // server is right to reject it.
    const response = await fetch(path, {
        ...options,
        ...(options.body
            ? {headers: {"content-type": "application/json"}, body: JSON.stringify(options.body)}
            : {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
}

/* ------------------------------------------------------------------ */
/* Settings                                                             */
/* ------------------------------------------------------------------ */

function sourceChips() {
    return [...document.querySelectorAll("#sources .chip")];
}

/** Selected source names. Empty means every source, as the CLI reads it too. */
function selectedSources() {
    return sourceChips()
        .filter((chip) => chip.classList.contains("is-active"))
        .map((chip) => chip.dataset.source);
}

function saveSettings() {
    const settings = {
        keywords: $("keywords").value,
        country: $("country").value,
        language: $("language").value,
        location: $("location").value,
        sources: selectedSources(),
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function loadSettings() {
    let settings;
    try {
        settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    } catch {
        return;
    }
    if (settings.keywords) $("keywords").value = settings.keywords;
    if (settings.country) $("country").value = settings.country;
    if (settings.language) $("language").value = settings.language;
    if (settings.location) $("location").value = settings.location;
    for (const chip of sourceChips()) {
        chip.classList.toggle("is-active", (settings.sources || []).includes(chip.dataset.source));
    }
}

/* ------------------------------------------------------------------ */
/* Stats                                                                */
/* ------------------------------------------------------------------ */

const STAT_ORDER = ["new", "generated", "applied", "failed", "dismissed", "closed"];

async function refreshStats() {
    const stats = await api("/api/stats");
    const counts = $("stat-counts");
    clear(counts);

    const total = el("div", "stat");
    total.append(el("b", null, stats.total), el("span", null, "total"));
    counts.append(total);

    for (const status of STAT_ORDER) {
        const value = stats.byStatus[status];
        if (!value) continue;
        const card = el("div", "stat");
        card.append(el("b", null, value), el("span", null, status));
        counts.append(card);
    }

    for (const [outcome, value] of Object.entries(stats.byOutcome || {})) {
        const card = el("div", "stat");
        card.append(el("b", null, value), el("span", null, outcome.replace(/_/g, " ")));
        counts.append(card);
    }

    const block = $("gaps-block");
    const list = $("gaps-list");
    clear(list);
    if (stats.topGaps.length) {
        block.hidden = false;
        for (const {gap, count} of stats.topGaps) {
            const item = el("li");
            item.append(document.createTextNode(gap), el("span", "count", ` — ${count}`));
            list.append(item);
        }
    } else {
        block.hidden = true;
    }
}

/* ------------------------------------------------------------------ */
/* List                                                                 */
/* ------------------------------------------------------------------ */

function statusPill(status) {
    return el("span", `pill status-${status}`, status);
}

function buildRow(posting) {
    const blocking = posting.flags.filter((flag) => BLOCKING_FLAGS.has(flag));
    const row = el("li", `row${blocking.length ? " has-flags" : ""}`);
    row.dataset.id = posting.sourceId;
    if (posting.sourceId === state.selectedId) row.classList.add("is-selected");

    const head = el("div", "row-head");
    head.append(
        el("span", "row-company", posting.company || "(unknown company)"),
        el("span", "row-title", posting.title || "(untitled)"),
    );

    const scores = el("div", "row-scores");
    // An em dash, not a hidden badge: "not scored" is a different statement
    // from "scored zero", and the list has to say which one it means.
    const pre = posting.preScore === null || posting.preScore === undefined ? "—" : posting.preScore;
    scores.append(el("span", "badge", `pre ${pre}`));
    if (posting.matchScore !== null && posting.matchScore !== undefined) {
        scores.append(el("span", "badge", `match ${posting.matchScore}`));
    }
    scores.append(statusPill(posting.status));
    head.append(scores);

    const meta = el("div", "row-meta");
    meta.append(
        el("span", null, posting.location || "—"),
        el("span", null, posting.source || "—"),
        el("span", "row-language", LANGUAGE_LABELS[posting.language] || "—"),
    );
    for (const flag of posting.flags) {
        meta.append(el("span", `badge${BLOCKING_FLAGS.has(flag) ? " is-blocking" : ""}`, flag));
    }

    row.append(head, meta);
    return row;
}

async function refreshList() {
    const params = new URLSearchParams();
    if (state.status) params.set("status", state.status);
    // The toolbar's language choice filters the list too, not only the search:
    // it is the same question asked of postings already in the database.
    if ($("language").value) params.set("language", $("language").value);

    const query = params.toString();
    state.postings = await api(`/api/postings${query ? `?${query}` : ""}`);

    const list = $("list");
    clear(list);
    $("empty").hidden = state.postings.length > 0;

    for (const posting of state.postings) list.append(buildRow(posting));
}

/* ------------------------------------------------------------------ */
/* Detail                                                               */
/* ------------------------------------------------------------------ */

function fileUrl(id, name) {
    return `/api/postings/${encodeURIComponent(id)}/files/${encodeURIComponent(name)}`;
}

async function openDetail(id) {
    state.selectedId = id;

    // Usually already in the list, but a click that lands before the first
    // load finishes must still open something rather than silently marking the
    // row selected and doing nothing.
    let posting = state.postings.find((one) => one.sourceId === id);
    if (!posting) {
        try {
            posting = await api(`/api/postings/${encodeURIComponent(id)}`);
        } catch {
            return;
        }
    }

    for (const row of document.querySelectorAll(".row")) {
        row.classList.toggle("is-selected", row.dataset.id === id);
    }

    const pane = $("detail");
    pane.hidden = false;
    // A hidden grid item still reserves its track, so the list would sit in
    // half the window with nothing beside it. The second column only exists
    // once there is something to put in it.
    document.querySelector(".layout").classList.add("has-detail");
    clear(pane);

    pane.append(el("h2", null, posting.company || "(unknown company)"));
    pane.append(el("p", "detail-meta", `${posting.title || ""} · ${posting.location || "—"} · ${posting.source || ""}`));

    if (posting.url) {
        const link = el("a", "detail-link", "Open the original posting ↗");
        link.href = posting.url;
        link.target = "_blank";
        link.rel = "noreferrer noopener";
        pane.append(link);
    }

    /* Actions */
    const actions = el("div", "detail-actions");
    const canGenerate = ["new", "failed", "generated"].includes(posting.status);
    if (canGenerate) {
        const generate = el("button", "primary", posting.status === "generated" ? "Regenerate" : "Generate");
        generate.addEventListener("click", () => runGeneration(id, generate));
        actions.append(generate);
    }
    if (posting.status === "generated") {
        const applied = el("button", null, "Mark as applied");
        applied.addEventListener("click", () => changeStatus(id, "applied"));
        actions.append(applied);
    }
    if (posting.status === "new" || posting.status === "generated" || posting.status === "failed") {
        const dismiss = el("button", null, "Dismiss");
        dismiss.addEventListener("click", () => changeStatus(id, "dismissed"));
        actions.append(dismiss);
    }
    if (posting.status === "applied") {
        const close = el("button", null, "Close");
        close.addEventListener("click", () => changeStatus(id, "closed"));
        actions.append(close);
    }
    pane.append(actions);

    if (posting.lastError) {
        pane.append(el("div", "notice", `Last generation failed: ${posting.lastError}`));
    }

    if (posting.status !== "generated" && posting.status !== "applied" && posting.status !== "closed") {
        pane.append(el("h3", null, "Job text"));
        const pre = el("textarea");
        pre.value = posting.rawText || "";
        pre.rows = 12;
        pre.readOnly = true;
        pane.append(pre);
        renderTracking(pane, posting);
        return;
    }

    /* Generated content */
    pane.append(el("h3", null, "Result"));
    const summary = el("div", "row-scores");
    if (posting.matchScore !== null) summary.append(el("span", "badge", `match ${posting.matchScore}`));
    for (const flag of posting.flags) {
        summary.append(el("span", `badge${BLOCKING_FLAGS.has(flag) ? " is-blocking" : ""}`, flag));
    }
    pane.append(summary);

    if (posting.flags.some((flag) => BLOCKING_FLAGS.has(flag))) {
        pane.append(
            el(
                "div",
                "notice",
                "This application carries a factual flag, so no PDF was produced. Fix the letter " +
                    "below and save — the flags are recomputed from what you write.",
            ),
        );
    }

    if (posting.gaps.length) {
        pane.append(el("h3", null, "Gaps"));
        const gaps = el("ul", "plain");
        for (const gap of posting.gaps) gaps.append(el("li", null, gap));
        pane.append(gaps);
    }

    /* The hand-edit loop, the primary manual step. */
    pane.append(el("h3", null, "Cover letter"));
    pane.append(
        el(
            "p",
            "editor-note",
            "Edit and save to re-render the PDFs. This never calls the model, and the flags are " +
                "recomputed against what you wrote.",
        ),
    );

    const editor = el("textarea");
    editor.rows = 14;
    editor.value = "Loading…";
    editor.disabled = true;
    pane.append(editor);

    const saveRow = el("div", "detail-actions");
    const save = el("button", "primary", "Save & re-render");
    save.disabled = true;
    saveRow.append(save);
    pane.append(saveRow);

    try {
        const artefacts = await api(`/api/postings/${encodeURIComponent(id)}/application`);
        editor.value = artefacts.application.cover_letter || "";
        editor.disabled = false;
        save.disabled = false;
    } catch (error) {
        editor.value = `Could not load the application: ${error.message}`;
    }

    save.addEventListener("click", async () => {
        save.disabled = true;
        save.textContent = "Saving…";
        try {
            await api(`/api/postings/${encodeURIComponent(id)}/cover-letter`, {
                method: "PUT",
                body: {cover_letter: editor.value},
            });
            await refreshAll();
            await openDetail(id);
        } catch (error) {
            alert(`Could not save: ${error.message}`);
            save.disabled = false;
            save.textContent = "Save & re-render";
        }
    });

    /* Previews and downloads */
    const files = await listFiles(id);
    if (files.length) {
        pane.append(el("h3", null, "Documents"));
        const links = el("div", "file-links");
        for (const name of files) {
            const link = el("a", null, name);
            link.href = fileUrl(id, name);
            link.target = "_blank";
            link.rel = "noreferrer noopener";
            links.append(link);
        }
        pane.append(links);

        for (const name of files) {
            const frame = document.createElement("iframe");
            frame.className = "preview";
            frame.src = fileUrl(id, name);
            frame.title = name;
            pane.append(frame);
        }
    }

    renderTracking(pane, posting);
}

/** The server knows which documents exist; the client must not guess names. */
async function listFiles(id) {
    try {
        const payload = await api(`/api/postings/${encodeURIComponent(id)}/files`);
        return payload.files || [];
    } catch {
        return [];
    }
}

function renderTracking(pane, posting) {
    if (!["applied", "closed"].includes(posting.status)) {
        pane.append(el("h3", null, "Notes"));
        pane.append(notesField(posting));
        return;
    }

    pane.append(el("h3", null, "Outcome"));
    const select = el("select");
    for (const [value, label] of [
        ["", "— not yet —"],
        ["no_response", "No response"],
        ["rejected", "Rejected"],
        ["interview", "Interview"],
        ["offer", "Offer"],
    ]) {
        const option = el("option", null, label);
        option.value = value;
        if ((posting.outcome || "") === value) option.selected = true;
        select.append(option);
    }
    select.addEventListener("change", async () => {
        try {
            await api(`/api/postings/${encodeURIComponent(posting.sourceId)}/outcome`, {
                method: "POST",
                body: {outcome: select.value || null},
            });
            await refreshAll();
        } catch (error) {
            alert(error.message);
        }
    });
    pane.append(select);

    pane.append(el("h3", null, "Notes"));
    pane.append(notesField(posting));
}

function notesField(posting) {
    const wrapper = el("div");
    const notes = el("textarea");
    notes.rows = 4;
    notes.value = posting.notes || "";
    wrapper.append(notes);

    const save = el("button", null, "Save notes");
    save.addEventListener("click", async () => {
        try {
            await api(`/api/postings/${encodeURIComponent(posting.sourceId)}/notes`, {
                method: "POST",
                body: {notes: notes.value},
            });
            save.textContent = "Saved";
            setTimeout(() => (save.textContent = "Save notes"), 1500);
        } catch (error) {
            alert(error.message);
        }
    });

    const row = el("div", "detail-actions");
    row.append(save);
    wrapper.append(row);
    return wrapper;
}

/* ------------------------------------------------------------------ */
/* Actions                                                              */
/* ------------------------------------------------------------------ */

async function runGeneration(id, button) {
    button.disabled = true;
    button.textContent = "Generating…";
    try {
        await api(`/api/postings/${encodeURIComponent(id)}/generate`, {method: "POST"});
    } catch (error) {
        alert(`Generation failed: ${error.message}`);
    }
    await refreshAll();
    await openDetail(id);
}

async function changeStatus(id, status) {
    try {
        await api(`/api/postings/${encodeURIComponent(id)}/status`, {
            method: "POST",
            body: {status},
        });
        await refreshAll();
        await openDetail(id);
    } catch (error) {
        alert(error.message);
    }
}

async function runSearch(button) {
    saveSettings();
    button.disabled = true;
    button.textContent = "Searching…";

    try {
        const keywords = $("keywords").value.split(/[,\s]+/).map((word) => word.trim()).filter(Boolean);
        const sources = selectedSources();

        const result = await api("/api/search", {
            method: "POST",
            body: {
                keywords,
                country: $("country").value || undefined,
                language: $("language").value || undefined,
                location: $("location").value || undefined,
                sources: sources.length ? sources : undefined,
            },
        });

        for (const warning of result.warnings || []) console.warn("[job-tailor]", warning);
        await refreshAll();
    } catch (error) {
        alert(`Search failed: ${error.message}`);
    } finally {
        button.disabled = false;
        button.textContent = "Search";
    }
}

/* ------------------------------------------------------------------ */
/* Polling                                                              */
/* ------------------------------------------------------------------ */

async function pollQueue() {
    try {
        const status = await api("/api/status");
        const node = $("queue-state");
        if (status.current) {
            node.hidden = false;
            const waiting = status.pending.length ? ` (+${status.pending.length} queued)` : "";
            node.textContent = `Generating ${status.current}${waiting}`;
        } else {
            node.hidden = true;
        }
    } catch {
        /* the server may be restarting; the next tick will tell us */
    }
}

async function refreshAll() {
    await Promise.all([refreshList(), refreshStats()]);
}

/* ------------------------------------------------------------------ */
/* Wiring                                                               */
/* ------------------------------------------------------------------ */

function init() {
    loadSettings();

    $("search").addEventListener("click", (event) => runSearch(event.currentTarget));
    $("keywords").addEventListener("keydown", (event) => {
        if (event.key === "Enter") runSearch($("search"));
    });

    for (const button of document.querySelectorAll(".filter")) {
        button.addEventListener("click", async () => {
            for (const other of document.querySelectorAll(".filter")) {
                other.classList.remove("is-active");
            }
            button.classList.add("is-active");
            state.status = button.dataset.status || "";
            await refreshList();
        });
    }

    // Language narrows the list you are already looking at, not only the next
    // search, so it has to redraw on change rather than waiting for Search.
    for (const chip of sourceChips()) {
        chip.addEventListener("click", () => {
            chip.classList.toggle("is-active");
            chip.setAttribute("aria-pressed", String(chip.classList.contains("is-active")));
            saveSettings();
        });
    }

    $("language").addEventListener("change", async () => {
        saveSettings();
        await refreshList();
    });

    $("list").addEventListener("click", (event) => {
        const row = event.target.closest(".row");
        if (row) openDetail(row.dataset.id);
    });

    refreshAll();
    pollQueue();
    setInterval(pollQueue, POLL_MS);
}

init();
