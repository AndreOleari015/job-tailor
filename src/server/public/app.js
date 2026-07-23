/*
 * No framework, no bundler. Every piece of text that reaches the DOM goes in as
 * textContent: job descriptions, company names and model output are all
 * third-party strings, and none of them may ever be parsed as HTML.
 */

const SETTINGS_KEY = "job-tailor.search";

/*
 * The API's stage names are the contract; these are what a person reads. A
 * generation is three steps of wildly different length, and saying which one is
 * running beats a progress bar that would have to invent a percentage.
 */
const STAGE_LABELS = {
    queued: "Waiting its turn",
    extracting: "Reading the posting",
    tailoring: "Writing the application",
    rendering: "Building the PDFs",
};

/** What the language column prints. "unknown" means too little prose to tell. */
const LANGUAGE_LABELS = {de: "German", en: "English", unknown: "—"};

const POLL_MS = 2000;

/*
 * Flag wording comes from GET /api/flags, which serves core/flags.ts — the same
 * table the CLI prints from. Keeping a second copy here would mean two sets of
 * prose describing one behaviour, and they would drift.
 */
let FLAG_INFO = {};

async function loadFlagInfo() {
    try {
        FLAG_INFO = await api("/api/flags");
    } catch {
        // Labels fall back to the flag's own words; the page still works.
    }
}

/** Flags that stop the renderer producing a PDF. Shown in the warning colour. */
function isBlocking(code) {
    return Boolean(FLAG_INFO[code]?.blocking);
}

/** Never print a raw constant: an unmapped flag still reads as words. */
function flagLabel(code) {
    return FLAG_INFO[code]?.label ?? code.toLowerCase().replace(/_/g, " ");
}

function flagBadge(code) {
    const badge = el("span", `badge${isBlocking(code) ? " is-blocking" : ""}`, flagLabel(code));
    const detail = FLAG_INFO[code]?.detail;
    badge.title = detail ? `${code} — ${detail}` : code;
    return badge;
}

const state = {
    postings: [],
    selectedId: null,
    status: "",
    /** Last /api/status response: what is running and what is waiting. */
    queue: {running: null, queue: [], queueLength: 0},
    polling: false,
};

/** Where a posting sits in the queue right now, if anywhere. */
function queueStateOf(sourceId) {
    if (state.queue.running?.sourceId === sourceId) {
        return {running: true, stage: state.queue.running.stage};
    }
    const waiting = state.queue.queue.find((entry) => entry.sourceId === sourceId);
    return waiting ? {running: false, position: waiting.position} : null;
}

const ORDINALS = ["", "1st", "2nd", "3rd"];
function ordinal(n) {
    return ORDINALS[n] ?? `${n}th`;
}

function seconds(ms) {
    return `${Math.max(0, Math.round(ms / 1000))}s`;
}

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

const STAT_ORDER = ["lead", "new", "generated", "applied", "failed", "dismissed", "closed"];

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

/**
 * A posting in the queue reports that instead of its stored status: the row is
 * what you are watching, and "new" while it is third in line is a lie.
 */
function queuePill(sourceId, status) {
    const queued = queueStateOf(sourceId);
    if (!queued) return statusPill(status);

    return queued.running
        ? el("span", "pill status-generating", `generating · ${STAGE_LABELS[queued.stage] ?? queued.stage}`)
        : el("span", "pill status-queued", `queued · ${ordinal(queued.position)}`);
}

/**
 * Both scores are 0-100. The bands match the one the model's own `lowMatch`
 * flag draws at 50, with a stronger cut at 70, so the colour a row shows and
 * the flag it carries never tell different stories.
 */
function scoreBand(value) {
    if (value === null || value === undefined) return "none";
    if (value >= 70) return "strong";
    if (value >= 50) return "fair";
    return "weak";
}

/**
 * One compatibility chip. `match` is the model's verdict, shown filled and
 * bold; `pre` is only the free keyword pre-filter — a hint that a posting is
 * worth the model's time — so it reads as a quiet outline that never competes
 * with the real score beside it. A null value is "not scored", an em dash with
 * no colour, which is a different statement from a low score.
 */
function scoreChip(kind, value) {
    const scored = value !== null && value !== undefined;
    const chip = el("span", `score score-${scoreBand(value)} score-${kind}`);
    chip.append(el("span", "score-val", scored ? value : "—"), el("span", "score-cap", kind));
    const name = kind === "match" ? "Model match" : "Keyword pre-filter";
    chip.title = scored ? `${name}: ${value} / 100` : `${name}: not scored yet`;
    return chip;
}

function buildRow(posting) {
    const blocking = posting.flags.filter(isBlocking);
    const row = el("li", `row${blocking.length ? " has-flags" : ""}`);
    row.dataset.id = posting.sourceId;
    if (posting.sourceId === state.selectedId) row.classList.add("is-selected");

    const head = el("div", "row-head");
    head.append(
        el("span", "row-company", posting.company || "(unknown company)"),
        el("span", "row-title", posting.title || "(untitled)"),
    );

    const scores = el("div", "row-scores");
    // A lead has no description yet, so there is nothing to pre-score — the
    // chip would be a meaningless em dash. For everything else "not scored" is
    // a real statement, distinct from "scored zero", so the chip stays.
    if (posting.status !== "lead") scores.append(scoreChip("pre", posting.preScore));
    if (posting.matchScore !== null && posting.matchScore !== undefined) {
        scores.append(scoreChip("match", posting.matchScore));
    }
    scores.append(queuePill(posting.sourceId, posting.status));
    head.append(scores);

    const meta = el("div", "row-meta");
    meta.append(
        el("span", null, posting.location || "—"),
        el("span", null, posting.source || "—"),
        el("span", "row-language", LANGUAGE_LABELS[posting.language] || "—"),
    );
    for (const flag of posting.flags) meta.append(flagBadge(flag));

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

    // A lead is a sighting from an email alert with no description. The one
    // thing to do with it is paste that description, so the panel is built
    // around that box and nothing competes with it.
    if (posting.status === "lead") {
        renderLeadPanel(pane, posting);
        return;
    }

    /* Actions */
    const actions = el("div", "detail-actions");
    const queued = queueStateOf(id);
    const canGenerate = ["new", "failed", "generated"].includes(posting.status);
    if (canGenerate || queued) {
        const generate = el(
            "button",
            "primary",
            posting.status === "failed" ? "Retry" : posting.status === "generated" ? "Regenerate" : "Generate",
        );
        // Already in the queue: the button says where it is rather than
        // offering to add it a second time.
        if (queued) {
            generate.disabled = true;
            generate.textContent = queued.running
                ? STAGE_LABELS[queued.stage] ?? "Generating…"
                : `Queued · ${ordinal(queued.position)}`;
        } else {
            generate.addEventListener("click", () => runGeneration(id, generate));
        }
        actions.append(generate);
    }
    // The moves that change how far along an application is. Each button offers
    // exactly one legal transition, so the state machine in the store and the
    // buttons here never disagree.
    const stateButton = (label, to, primary) => {
        const button = el("button", primary ? "primary" : null, label);
        button.addEventListener("click", () => changeStatus(id, to));
        actions.append(button);
    };

    if (posting.status === "generated") stateButton("Mark as applied", "applied", true);
    if (posting.status === "applied") {
        stateButton("Mark as not applied", "generated");
        stateButton("Close", "closed");
    }
    if (posting.status === "closed") {
        stateButton("Reopen as applied", "applied");
        stateButton("Reopen, not applied", "generated");
    }
    if (["new", "generated", "failed"].includes(posting.status)) {
        stateButton("Dismiss", "dismissed");
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

    if (posting.status === "failed" && posting.lastError) {
        const failure = el("div", "notice");
        failure.append(el("p", "notice-head", "The last generation failed."));
        failure.append(el("p", null, posting.lastError));
        pane.append(failure);
    }

    /* Generated content */
    pane.append(el("h3", null, "Result"));
    const summary = el("div", "row-scores");
    if (posting.matchScore !== null) summary.append(scoreChip("match", posting.matchScore));
    for (const flag of posting.flags) summary.append(flagBadge(flag));
    pane.append(summary);

    const blocking = posting.flags.filter(isBlocking);
    if (blocking.length) {
        const notice = el("div", "notice");
        notice.append(
            el("p", "notice-head", "No PDFs yet — the letter needs a look first."),
        );

        const reasons = el("ul", "notice-list");
        for (const flag of blocking) {
            reasons.append(el("li", null, FLAG_INFO[flag]?.detail ?? flagLabel(flag)));
        }
        notice.append(reasons);

        notice.append(
            el(
                "p",
                "notice-foot",
                "Edit the letter below and save. The checks run again on what you write, and the " +
                    "PDFs appear as soon as they pass.",
            ),
        );
        pane.append(notice);
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

/**
 * The lead panel. Its whole reason to exist is the paste box, so that is the
 * dominant element: a disabled Generate makes the gate obvious, the snippet
 * gives context, and the textarea is where the work happens.
 */
function renderLeadPanel(pane, posting) {
    const actions = el("div", "detail-actions");
    const generate = el("button", "primary", "Generate");
    generate.disabled = true;
    generate.title = "Paste the job description first";
    actions.append(generate);

    const dismiss = el("button", null, "Dismiss");
    dismiss.addEventListener("click", () => changeStatus(posting.sourceId, "dismissed"));
    actions.append(dismiss);
    pane.append(actions);

    if (posting.leadSource) {
        pane.append(el("p", "lead-origin", `Lead from ${posting.leadSource.replace("gmail:", "Gmail · ")}`));
    }
    if (posting.snippet) {
        pane.append(el("p", "lead-snippet", posting.snippet));
    }

    const box = el("section", "paste-box");
    box.append(el("h3", "paste-heading", "Paste the full job description"));
    box.append(
        el(
            "p",
            "paste-hint",
            "Open the original posting, copy its whole description, and paste it here. That turns " +
                "this lead into a posting you can generate from.",
        ),
    );

    const textarea = el("textarea", "paste-area");
    textarea.rows = 16;
    textarea.placeholder = "Paste the job description…";
    box.append(textarea);

    const save = el("button", "primary paste-save", "Save description");
    save.addEventListener("click", async () => {
        const description = textarea.value.trim();
        if (!description) {
            textarea.focus();
            return;
        }
        save.disabled = true;
        save.textContent = "Saving…";
        try {
            await api(`/api/postings/${encodeURIComponent(posting.sourceId)}/description`, {
                method: "POST",
                body: {description},
            });
            await refreshAll();
            await openDetail(posting.sourceId); // now a `new` posting, Generate enabled
        } catch (error) {
            alert(`Could not save: ${error.message}`);
            save.disabled = false;
            save.textContent = "Save description";
        }
    });
    box.append(save);
    pane.append(box);

    pane.append(el("h3", null, "Notes"));
    pane.append(notesField(posting));
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
    button.textContent = "Queued…";

    // The request only resolves when the whole generation finishes, which can
    // be minutes behind a queue. Start polling now so the strip reports it
    // immediately rather than the page sitting silent.
    const request = api(`/api/postings/${encodeURIComponent(id)}/generate`, {method: "POST"});
    await pollQueue();

    try {
        await request;
    } catch (error) {
        alert(`Generation failed: ${error.message}`);
    }
    await pollQueue();
    await refreshAll();
    if (state.selectedId === id) await openDetail(id);
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
/* Gmail                                                                */
/* ------------------------------------------------------------------ */

/** Shows the Gmail button only when an account is actually authorised. */
async function refreshGmail() {
    const button = $("gmail-fetch");
    try {
        const status = await api("/api/gmail/status");
        button.hidden = !status.authorised;
        if (status.authorised) {
            button.title = `Read ${status.label} in ${status.account}`;
        }
    } catch {
        button.hidden = true;
    }
}

async function fetchFromGmail(button) {
    button.disabled = true;
    button.textContent = "Fetching…";
    try {
        const result = await api("/api/gmail/fetch", {method: "POST", body: {}});
        const suffix = result.unparsed
            ? ` ${result.unparsed} message(s) matched a sender but yielded nothing.`
            : "";
        alert(
            `Read ${result.messagesRead} message(s) under "${result.label}". ` +
                `${result.added} new lead(s).${suffix}`,
        );
        await refreshAll();
    } catch (error) {
        alert(`Gmail fetch failed: ${error.message}`);
    } finally {
        button.disabled = false;
        button.textContent = "Fetch from Gmail";
    }
}

/* ------------------------------------------------------------------ */
/* Polling                                                              */
/* ------------------------------------------------------------------ */

function renderQueueStrip() {
    const strip = $("queue-strip");
    const {running, queue} = state.queue;
    clear(strip);

    if (!running && !queue.length) {
        strip.hidden = true;
        return;
    }
    strip.hidden = false;

    if (running) {
        const head = el("div", "queue-running");
        head.append(
            el("span", "queue-label", "Generating"),
            el("span", "queue-name", `${running.company || "(unknown)"} — ${running.title}`),
        );
        // Elapsed, never a percentage: how long tailoring takes is not knowable,
        // and a bar stuck at 60% is worse than a number that keeps moving.
        head.append(
            el(
                "span",
                "queue-stage",
                `${STAGE_LABELS[running.stage] ?? running.stage} · ${seconds(running.elapsedMs)}`,
            ),
        );
        strip.append(head);
    }

    if (!queue.length) return;

    strip.append(el("h3", "queue-heading", `Queued (${queue.length})`));
    const list = el("ol", "queue-list");
    for (const entry of queue) {
        const item = el("li");
        item.append(el("span", null, `${entry.company || "(unknown)"} — ${entry.title}`));

        const cancel = el("button", "queue-cancel", "cancel");
        cancel.dataset.cancelId = entry.sourceId;
        item.append(cancel);
        list.append(item);
    }
    strip.append(list);
}

/**
 * Polls only while there is something to watch. A quiet server is left alone —
 * a request every two seconds forever is a background cost with no reader.
 */
async function pollQueue() {
    let status;
    try {
        status = await api("/api/status");
    } catch {
        // The server may be restarting; try again on the next tick.
        return;
    }

    const wasBusy = Boolean(state.queue.running) || state.queue.queue.length > 0;
    const finished = state.queue.running && status.running?.sourceId !== state.queue.running.sourceId;

    state.queue = status;
    renderQueueStrip();

    const busy = Boolean(status.running) || status.queue.length > 0;

    // Something completed: bring the row and the counts up to date, and refresh
    // the open panel if it happens to be the posting that just finished.
    if (finished || (wasBusy && !busy)) {
        await refreshAll();
        if (state.selectedId) await openDetail(state.selectedId);
    } else if (wasBusy || busy) {
        // Repaint the rows so their pills follow the stage.
        for (const row of document.querySelectorAll(".row")) {
            const posting = state.postings.find((one) => one.sourceId === row.dataset.id);
            if (posting) row.replaceWith(buildRow(posting));
        }
    }

    setPolling(busy);
}

let pollTimer = null;

function setPolling(on) {
    if (on && !pollTimer) pollTimer = setInterval(pollQueue, POLL_MS);
    if (!on && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    state.polling = on;
}

async function refreshAll() {
    await Promise.all([refreshList(), refreshStats()]);
}

/* ------------------------------------------------------------------ */
/* Wiring                                                               */
/* ------------------------------------------------------------------ */

async function init() {
    loadSettings();
    await loadFlagInfo();

    $("search").addEventListener("click", (event) => runSearch(event.currentTarget));
    $("keywords").addEventListener("keydown", (event) => {
        if (event.key === "Enter") runSearch($("search"));
    });
    $("gmail-fetch").addEventListener("click", (event) => fetchFromGmail(event.currentTarget));

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

    $("queue-strip").addEventListener("click", async (event) => {
        const id = event.target.dataset?.cancelId;
        if (!id) return;

        event.target.disabled = true;
        try {
            await api(`/api/postings/${encodeURIComponent(id)}/cancel`, {method: "POST"});
        } catch (error) {
            alert(`Could not cancel: ${error.message}`);
            event.target.disabled = false;
            return;
        }
        await pollQueue();
        await refreshAll();
    });

    refreshAll();
    refreshGmail();
    // One read to find out whether anything is running; it starts the timer
    // only if there is.
    pollQueue();
}

init();
