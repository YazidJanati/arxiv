import "./style.css";
import { windowPapers, type SearchPaper } from "./search";
import { icon } from "./icons";
import { formatDate, isWeekend, offsetDate, today, weekDays } from "./dates";
import { cachedDay, fetchAbstract, fetchDay, fresh, inWindow, pruneCache, validCategory, windowDates } from "./source";
import { desktop, openExternal, read, setAppearance, write } from "./platform";
import type { DayFeed, Paper, Selection, State, Theme } from "./types";
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const escape = (text: string) => text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const tool = (id: string, glyph: string, label: string) => `<button id="${id}" class="icon-button" aria-label="${label}" title="${label}">${icon(glyph)}</button>`;
let state: State = { categories: ["cs.LG", "stat.ML"], theme: "dark", bookmarks: [] };
let currentMonday = weekDays()[0], displayedMonday = currentMonday;
let days = weekDays(), selection: Selection | null = null, mode: "day" | "saved" = "day";
let papers: Paper[] = [], loading = false, error = "", cacheTime: number | null = null, query = "", epoch = 0;
const windowFeeds = new Map<string, DayFeed>();
const searching = () => query.trim().length > 0;
const expandedDays = new Set<string>();
const expandedPapers = new Set<string>();
const abstractValues = new Map<string, string>();
const abstractErrors = new Map<string, string>();
const abstractLoading = new Set<string>();
let saveQueue = Promise.resolve(), unsaved = false;
let warmEpoch = 0, lastWarm = 0, lastCalendarDate = today(), cacheProgress = "", appReady = false;
const categoryNames: Record<string, string> = {
  "cs.LG": "Machine Learning", "stat.ML": "Machine Learning", "cs.AI": "Artificial Intelligence",
  "cs.CL": "Computation and Language", "cs.CV": "Computer Vision", "cs.RO": "Robotics",
  "cs.IR": "Information Retrieval", "cs.NE": "Neural and Evolutionary Computing",
  "stat.TH": "Statistics Theory", "math.OC": "Optimization and Control", "math.ST": "Statistics Theory",
  "cs.DS": "Data Structures and Algorithms", "cs.CR": "Cryptography and Security", "quant-ph": "Quantum Physics",
};
document.querySelector("#app")!.innerHTML = `
<aside id="sidebar" aria-label="Daily papers">
  <div class="sidebar-heading"><span>arxiv</span>${tool("add-section", "plus", "Add section")}</div>
  <div class="week-picker"><button id="week-label" aria-label="Choose week" aria-expanded="false" aria-controls="week-menu"></button><div id="week-menu" role="group" aria-label="Choose week" hidden><button id="this-week"></button><button id="previous-week"></button></div></div>
  <nav id="days" aria-label="Days of the week"></nav>
  <div class="sidebar-bottom"><button id="saved" class="nav-row">${icon("bookmark")}<span>Bookmarks</span><span id="saved-count"></span></button>
  <button id="settings" class="nav-row">${icon("settings")}<span>Settings</span></button></div>
</aside>
<main><header>${tool("toggle-sidebar", "sidebar", "Toggle sidebar (⌘B)")}<span id="breadcrumb">This week</span><div class="header-space"></div>
  <div class="search-field">${icon("search")}<input id="search" type="search" placeholder="Search both weeks" aria-label="Search by title or author" autocomplete="off" spellcheck="false" /></div>
  ${tool("refresh", "refresh", "Refresh papers")}</header>
  <div id="reader" tabindex="-1"><div id="view-heading"></div><div id="feed-notice" role="status"></div><div id="papers"></div></div>
  <footer><span id="status" role="status"></span><span id="source-label">arXiv daily listings</span></footer>
</main>
<div id="notice" role="alert" hidden><span></span><button id="retry-save" hidden>Retry save</button>${tool("dismiss-notice", "close", "Dismiss notice")}</div>
<dialog id="settings-dialog" aria-labelledby="settings-title">
  <div class="dialog-heading"><h2 id="settings-title">Settings</h2>${tool("close-settings", "close", "Close settings")}</div>
  <label for="theme" class="field-label">Appearance</label><select id="theme"><option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option></select>
  <h3>Sections</h3><div id="section-list"></div>
  <form id="section-form"><label class="field-label" for="category-code">Add an arXiv section</label><div class="add-field"><input id="category-code" placeholder="e.g. cs.AI" list="category-options" autocomplete="off" spellcheck="false" maxlength="50" required /><button type="submit">Add</button></div><p id="category-error" class="form-error" role="alert"></p></form>
  <datalist id="category-options">${Object.entries(categoryNames).map(([code, name]) => `<option value="${code}">${name}</option>`).join("")}</datalist>
  <p class="hint">Use any arXiv category code. Sections appear under every day.</p><p class="hint">Bookmarks, preferences, and cached papers stay on this Mac.</p>
  <div class="dialog-footer"><button id="help">Keyboard shortcuts</button><button id="taxonomy">Browse arXiv sections ${icon("external")}</button></div>
</dialog>
<dialog id="help-dialog" aria-labelledby="help-title"><div class="dialog-heading"><h2 id="help-title">Keyboard shortcuts</h2>${tool("close-help", "close", "Close keyboard shortcuts")}</div><dl class="shortcuts"><dt>Search both weeks</dt><dd>⌘F</dd><dt>Toggle sidebar</dt><dd>⌘B</dd><dt>Refresh papers</dt><dd>⌘R</dd><dt>Settings</dt><dd>⌘,</dd><dt>Navigate controls</dt><dd>Tab / Shift+Tab</dd><dt>Expand title / day</dt><dd>Enter / Space</dd><dt>Close dialog / clear search</dt><dd>Esc</dd></dl></dialog>`;
function notice(message: string) {
  $("notice").hidden = false;
  $("notice").querySelector("span")!.textContent = message;
  $("retry-save").hidden = !unsaved;
}
function persist(): void {
  const snapshot = structuredClone(state);
  saveQueue = saveQueue.then(async () => {
    try {
      await write("state", snapshot);
      unsaved = false;
      $("retry-save").hidden = true;
      if ($("notice").querySelector("span")!.textContent?.startsWith("Could not save")) $("notice").hidden = true;
    } catch (cause) {
      unsaved = true;
      notice(`Could not save your changes. ${String(cause)} Use Retry save before quitting.`);
    }
  });
}
function applyTheme(): void {
  const dark = state.theme === "dark" || (state.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  setAppearance(state.theme);
}
function renderSidebar(): void {
  const range = (monday: string) => `${formatDate(monday, { day: "numeric", month: "short" })}–${formatDate(offsetDate(monday, 6), { day: "numeric", month: "short" })}`;
  $("week-label").innerHTML = `<span>${range(displayedMonday)}</span><span class="week-chevron">${icon("chevron")}</span>`;
  $("this-week").textContent = `This week · ${range(currentMonday)}`;
  $("previous-week").textContent = `Previous week · ${range(offsetDate(currentMonday, -7))}`;
  $("this-week").setAttribute("aria-pressed", String(displayedMonday === currentMonday));
  $("previous-week").setAttribute("aria-pressed", String(displayedMonday !== currentMonday));
  $("days").innerHTML = days.map((date) => {
    const open = expandedDays.has(date);
    return `<div class="day-group"><button class="nav-row day-row ${open ? "expanded" : ""} ${date > today() ? "future" : ""}" data-day="${date}" aria-expanded="${open}" aria-controls="sections-${date}"><span class="chevron">${icon("chevron")}</span><span>${formatDate(date, { weekday: "long" })}</span><span class="day-date">${date === today() ? "today" : formatDate(date, { day: "numeric", month: "short" })}</span></button>
    <div id="sections-${date}" ${open ? "" : "hidden"}>${state.categories.map((category) => `<button class="nav-row section-row ${!searching() && mode === "day" && selection?.date === date && selection.category === category ? "selected" : ""}" data-date="${date}" data-category="${escape(category)}" ${!searching() && mode === "day" && selection?.date === date && selection.category === category ? 'aria-current="page"' : ""} title="${escape(categoryNames[category] ?? category)}">${icon("file")}<span>${escape(category)}</span></button>`).join("")}</div></div>`;
  }).join("");
  // The small category mark deliberately matches text's file rows.
  $("days").querySelectorAll<SVGElement>(".section-row svg").forEach((svg) => { svg.innerHTML = '<path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h4"/>'; });
  $("saved").classList.toggle("selected", mode === "saved" && !searching());
  if (mode === "saved" && !searching()) $("saved").setAttribute("aria-current", "page"); else $("saved").removeAttribute("aria-current");
  $("saved-count").textContent = state.bookmarks.length ? String(state.bookmarks.length) : "";
}
function normalize(value: string): string { return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase(); }
function viewPapers(): Paper[] {
  return searching() ? windowPapers(windowFeeds.values(), state.categories) : mode === "saved" ? state.bookmarks : papers;
}
function visiblePapers(): Paper[] {
  const all = viewPapers();
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  return all.filter((paper) => { const haystack = normalize(`${paper.title} ${paper.authors.join(" ")}`); return terms.every((term) => haystack.includes(term)); });
}
function paperMarkup(paper: Paper, index: number): string {
  const open = expandedPapers.has(paper.id), saved = state.bookmarks.some((p) => p.id === paper.id);
  const abstract = abstractValues.get(paper.id) ?? paper.abstract;
  const abstractError = abstractErrors.get(paper.id);
  const categories = (paper as Partial<SearchPaper>).categories ?? [paper.category];
  return `<article class="paper" data-paper="${escape(paper.id)}"><div class="paper-top"><div class="paper-text"><button class="paper-title" data-action="toggle" aria-expanded="${open}" aria-controls="abstract-${index}" id="title-${index}">${escape(paper.title)}</button><p class="authors">${escape(paper.authors.join(", "))}</p>${mode === "saved" || searching() ? `<p class="saved-meta">${escape(categories.join(", "))} · ${formatDate(paper.date, { day: "numeric", month: "short", year: "numeric" })}</p>` : ""}</div><button class="icon-button bookmark ${saved ? "is-saved" : ""}" data-action="bookmark" aria-label="${saved ? "Remove bookmark" : "Bookmark paper"}: ${escape(paper.title)}" aria-pressed="${saved}" title="${saved ? "Remove bookmark" : "Bookmark paper"}">${icon("bookmark")}</button></div>
  <div class="abstract" id="abstract-${index}" role="region" aria-labelledby="title-${index}" ${open ? "" : "hidden"}>${abstract ? `<p>${escape(abstract)}</p>` : abstractError ? `<p class="abstract-error">${escape(abstractError)} <button data-action="retry-abstract">Try again</button></p>` : '<p class="hint" role="status">Loading abstract…</p>'}<div class="paper-links"><button data-action="open">arXiv ${icon("external")}</button><button data-action="pdf">PDF ${icon("external")}</button><span>${escape(paper.id)}</span></div></div></article>`;
}
function renderPapers(): void {
  const visible = visiblePapers();
  const activeSearch = searching(), total = viewPapers().length;
  $("refresh").classList.toggle("loading", activeSearch ? cacheProgress.startsWith("Caching") : loading);
  ($("refresh") as HTMLButtonElement).disabled = activeSearch ? cacheProgress.startsWith("Caching") : loading || mode === "saved" || !selection;
  $("reader").setAttribute("aria-busy", String(loading && !activeSearch));
  $("breadcrumb").textContent = activeSearch ? "Search / both weeks" : mode === "saved" ? "Bookmarks" : selection ? `${formatDate(selection.date, { weekday: "long" })} / ${selection.category}` : displayedMonday === currentMonday ? "This week" : "Previous week";
  renderCacheStatus();
  $("search").setAttribute("placeholder", "Search both weeks");
  $("feed-notice").innerHTML = error && !activeSearch ? `<span>${escape(error)}</span> <button id="retry-feed">Try again</button>` : "";
  $("feed-notice").hidden = !error || activeSearch;
  if (!activeSearch && mode === "day" && !selection) {
    $("view-heading").innerHTML = "";
    $("papers").innerHTML = '<div class="empty-state"><p>Select a day, then a section.</p><p class="hint">Your daily papers, one title at a time.</p></div>';
    $("status").textContent = "";
    return;
  }
  const title = activeSearch ? "Search results" : mode === "saved" ? "Bookmarks" : selection!.category;
  const subtitle = activeSearch ? `${formatDate(offsetDate(currentMonday, -7), { day: "numeric", month: "short" })}–${formatDate(today(), { day: "numeric", month: "short", year: "numeric" })} · all sections` : mode === "saved" ? "Papers to come back to." : formatDate(selection!.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  $("view-heading").innerHTML = `<h1>${escape(title)}</h1><p>${escape(subtitle)}</p>`;
  if (visible.length) $("papers").innerHTML = visible.map(paperMarkup).join("");
  else {
    let message = "No papers for this day.", detail = "There may be a holiday or no new announcements in this section.";
    if (activeSearch) {
      message = "No matching papers.";
      detail = cacheProgress.startsWith("Caching") ? "Still caching both weeks; results update as papers arrive." : cacheProgress.startsWith("Cache incomplete") ? "Some listings are unavailable. Search covers the cached papers." : "Try a different title or author name.";
    }
    else if (loading && total === 0) { message = "Loading papers…"; detail = "Fetching the daily listing from arXiv."; }
    else if (error && total === 0) { message = "Couldn’t load papers."; detail = "Check your connection, then try again."; }
    else if (query.trim()) { message = "No matching papers."; detail = "Try a different title or author name."; }
    else if (mode === "saved") { message = "No bookmarks yet."; detail = "Use the bookmark beside any paper to save it here."; }
    else if (selection!.date > today()) { message = "This day hasn’t arrived yet."; detail = "Papers will appear after arXiv publishes its daily listing."; }
    else if (isWeekend(selection!.date)) { message = "No daily listing on weekends."; detail = "Choose a weekday to read its papers."; }
    else if (selection!.date === today()) { message = "No papers announced for this day yet."; detail = "Try refreshing later, or choose an earlier weekday."; }
    $("papers").innerHTML = `<div class="empty-state"><p>${escape(message)}</p><p class="hint">${escape(detail)}</p></div>`;
  }
  const count = activeSearch ? `${visible.length} result${visible.length === 1 ? "" : "s"} · ${total} papers in both weeks` : `${total} paper${total === 1 ? "" : "s"}`;
  $("status").textContent = `${loading && !activeSearch ? "Refreshing · " : ""}${count}${cacheTime && !activeSearch ? ` · cached ${new Date(cacheTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}`;
}
async function loadSelection(force = false): Promise<void> {
  if (!selection || mode !== "day") return;
  const current = { ...selection }, token = ++epoch;
  error = ""; papers = []; cacheTime = null;
  if (isWeekend(current.date) || current.date > today()) { loading = false; renderPapers(); return; }
  loading = true; renderPapers();
  let cache: DayFeed | null = null;
  try { cache = await cachedDay(current.category, current.date); } catch { /* Read from arXiv instead. */ }
  if (token !== epoch) return;
  if (cache) { absorbFeed(cache, false); papers = cache.papers; cacheTime = cache.fetchedAt; renderPapers(); }
  if (!force && cache && fresh(cache)) { loading = false; renderPapers(); return; }
  try {
    const feed = await fetchDay(current.category, current.date);
    if (token !== epoch) return;
    absorbFeed(feed, false); papers = feed.papers; cacheTime = feed.fetchedAt;
  } catch (cause) {
    if (token !== epoch) return;
    error = cache ? `Offline or arXiv unavailable. Showing cached papers. ${String(cause).replace(/^Error: /, "")}` : String(cause).replace(/^Error: /, "");
  }
  if (token !== epoch) return;
  loading = false; renderPapers();
}
function selectDay(date: string, category: string): void {
  selection = { date, category }; mode = "day"; query = ""; $<HTMLInputElement>("search").value = "";
  expandedPapers.clear(); renderSidebar(); void loadSelection();
  $("reader").scrollTop = 0;
}
async function loadAbstract(paper: Paper): Promise<void> {
  if (abstractLoading.has(paper.id) || abstractValues.has(paper.id) || paper.abstract) return;
  abstractLoading.add(paper.id); abstractErrors.delete(paper.id);
  try {
    const abstract = await fetchAbstract(paper.id);
    abstractValues.set(paper.id, abstract);
    const saved = state.bookmarks.find((p) => p.id === paper.id);
    if (saved) { saved.abstract = abstract; persist(); }
  } catch (cause) { abstractErrors.set(paper.id, String(cause).replace(/^Error: /, "")); }
  finally {
    abstractLoading.delete(paper.id);
    // Update just the abstract so keyboard focus and reading position survive.
    const article = Array.from($("papers").querySelectorAll<HTMLElement>("article")).find((a) => a.dataset.paper === paper.id);
    if (article) {
      const index = Array.from($("papers").children).indexOf(article);
      const holder = document.createElement("div"); holder.innerHTML = paperMarkup(paper, index);
      article.querySelector(".abstract")!.replaceWith(holder.querySelector(".abstract")!);
    }
  }
}
function showSettings(focusAdd = false): void {
  renderSettings(); $<HTMLDialogElement>("settings-dialog").showModal();
  if (focusAdd) $("category-code").focus();
}
function renderSettings(): void {
  $<HTMLSelectElement>("theme").value = state.theme;
  $("section-list").innerHTML = state.categories.map((code) => `<div class="setting-section"><span>${escape(code)}</span><span class="hint">${escape(categoryNames[code] ?? "arXiv section")}</span><button class="icon-button" data-remove="${escape(code)}" aria-label="Remove ${escape(code)}" title="Remove section" ${state.categories.length < 2 ? "disabled" : ""}>${icon("close")}</button></div>`).join("");
}
$("days").onclick = (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!button) return;
  if (button.dataset.day) {
    const date = button.dataset.day;
    const opening = !expandedDays.has(date);
    expandedDays.clear();
    if (opening) expandedDays.add(date);
    renderSidebar(); $("days").querySelector<HTMLButtonElement>(`[data-day="${date}"]`)?.focus();
  } else if (button.dataset.date && button.dataset.category) {
    selectDay(button.dataset.date, button.dataset.category);
    $("days").querySelector<HTMLButtonElement>(`[data-date="${button.dataset.date}"][data-category="${button.dataset.category}"]`)?.focus();
  }
};
$("saved").onclick = () => {
  ++epoch; mode = "saved"; loading = false; error = ""; query = ""; cacheTime = null;
  $<HTMLInputElement>("search").value = ""; expandedPapers.clear(); renderSidebar(); renderPapers(); $("reader").scrollTop = 0;
};
$("papers").onclick = (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
  const article = button?.closest<HTMLElement>("article");
  const paper = viewPapers().find((p) => p.id === article?.dataset.paper);
  if (!button || !paper || !article) return;
  const action = button.dataset.action;
  if (action === "toggle") {
    const open = !expandedPapers.has(paper.id);
    if (open) expandedPapers.add(paper.id); else expandedPapers.delete(paper.id);
    button.setAttribute("aria-expanded", String(open));
    (article.querySelector(".abstract") as HTMLElement).hidden = !open;
    if (open) void loadAbstract(paper);
  } else if (action === "retry-abstract") {
    abstractErrors.delete(paper.id); button.textContent = "Retrying…"; button.disabled = true; void loadAbstract(paper);
  } else if (action === "bookmark") {
    const index = state.bookmarks.findIndex((p) => p.id === paper.id);
    if (index >= 0) state.bookmarks.splice(index, 1);
    else state.bookmarks.unshift({ ...paper, abstract: abstractValues.get(paper.id) ?? paper.abstract });
    persist(); renderSidebar();
    if (mode === "saved" && !searching()) { renderPapers(); $("papers").querySelector<HTMLButtonElement>(".bookmark")?.focus(); }
    else {
      const saved = index < 0;
      button.classList.toggle("is-saved", saved); button.setAttribute("aria-pressed", String(saved));
      button.setAttribute("aria-label", `${saved ? "Remove bookmark" : "Bookmark paper"}: ${paper.title}`);
      button.title = saved ? "Remove bookmark" : "Bookmark paper";
    }
  } else if (action === "open" || action === "pdf") {
    void openExternal(`https://arxiv.org/${action === "pdf" ? "pdf" : "abs"}/${paper.id}`).catch((cause) => notice(String(cause)));
  }
};
$("search").oninput = () => { query = $<HTMLInputElement>("search").value; renderSidebar(); renderPapers(); $("reader").scrollTop = 0; };
$("refresh").onclick = () => { if (searching()) void maintainAndWarm(true); else { void loadSelection(true); void maintainAndWarm(); } };
$("feed-notice").onclick = (event) => { if ((event.target as HTMLElement).closest("#retry-feed")) void loadSelection(true); };
$("toggle-sidebar").onclick = () => document.body.classList.toggle("sidebar-hidden");
$("settings").onclick = () => showSettings();
$("add-section").onclick = () => showSettings(true);
$("close-settings").onclick = () => $<HTMLDialogElement>("settings-dialog").close();
$("close-help").onclick = () => $<HTMLDialogElement>("help-dialog").close();
$("help").onclick = () => { $<HTMLDialogElement>("settings-dialog").close(); $<HTMLDialogElement>("help-dialog").showModal(); };
$("taxonomy").onclick = () => void openExternal("https://arxiv.org/category_taxonomy").catch((cause) => notice(String(cause)));
$("theme").onchange = () => { state.theme = $<HTMLSelectElement>("theme").value as Theme; applyTheme(); persist(); };
$("section-form").onsubmit = (event) => {
  event.preventDefault();
  const input = $<HTMLInputElement>("category-code"), code = input.value.trim();
  if (!validCategory(code)) { $("category-error").textContent = "Enter a category code such as cs.LG, stat.ML, or quant-ph (case sensitive)."; return; }
  if (state.categories.includes(code)) { $("category-error").textContent = "This section is already in your sidebar."; return; }
  state.categories.push(code); input.value = ""; $("category-error").textContent = "";
  persist(); renderSettings(); renderSidebar(); input.focus(); void maintainAndWarm();
};
$("section-list").onclick = (event) => {
  const code = (event.target as HTMLElement).closest<HTMLElement>("[data-remove]")?.dataset.remove;
  if (!code || state.categories.length < 2) return;
  state.categories = state.categories.filter((c) => c !== code); persist();
  if (selection?.category === code) { ++epoch; selection = null; papers = []; loading = false; error = ""; }
  renderSettings(); renderSidebar(); renderPapers(); void maintainAndWarm();
};
$("dismiss-notice").onclick = () => { $("notice").hidden = true; };
$("retry-save").onclick = persist;
function command(name: string): void {
  if (name === "settings") { if (!$<HTMLDialogElement>("settings-dialog").open) showSettings(); }
  else if (name === "search") $("search").focus();
  else if (name === "sidebar") $("toggle-sidebar").click();
  else if (name === "refresh") $("refresh").click();
}
window.arxivCommand = command;
window.arxivBeforeQuit = async () => { await saveQueue; return !unsaved; };
document.addEventListener("keydown", (event) => {
  const mod = event.metaKey || event.ctrlKey;
  if (mod && ["f", "b", "r", ","].includes(event.key.toLowerCase())) {
    event.preventDefault(); command(({ f: "search", b: "sidebar", r: "refresh", ",": "settings" } as Record<string, string>)[event.key.toLowerCase()]);
  } else if (event.key === "Escape" && document.activeElement === $("search")) {
    $<HTMLInputElement>("search").value = ""; query = ""; renderSidebar(); renderPapers(); $("search").blur();
  } else if (event.key === "F1") { event.preventDefault(); $<HTMLDialogElement>("help-dialog").showModal(); }
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
function renderCacheStatus(): void {
  $("source-label").textContent = mode === "saved" && !searching() ? "Saved on this Mac" : cacheProgress || "arXiv daily listings";
  if (searching()) {
    ($("refresh") as HTMLButtonElement).disabled = cacheProgress.startsWith("Caching");
    $("refresh").classList.toggle("loading", cacheProgress.startsWith("Caching"));
  }
}
function switchWeek(monday: string): void {
  if (![currentMonday, offsetDate(currentMonday, -7)].includes(monday)) return;
  displayedMonday = monday; days = weekDays(monday); ++epoch;
  selection = null; mode = "day"; papers = []; loading = false; error = ""; cacheTime = null;
  expandedDays.clear(); expandedPapers.clear();
  $("week-menu").hidden = true; $("week-label").setAttribute("aria-expanded", "false");
  renderSidebar(); renderPapers(); $("reader").scrollTop = 0;
}
$("week-label").onclick = () => {
  $("week-menu").hidden = !$("week-menu").hidden;
  $("week-label").setAttribute("aria-expanded", String(!$("week-menu").hidden));
};
$("this-week").onclick = () => switchWeek(currentMonday);
$("previous-week").onclick = () => switchWeek(offsetDate(currentMonday, -7));
document.addEventListener("click", (event) => {
  if (!(event.target as HTMLElement).closest(".week-picker")) {
    $("week-menu").hidden = true; $("week-label").setAttribute("aria-expanded", "false");
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("week-menu").hidden) {
    $("week-menu").hidden = true; $("week-label").setAttribute("aria-expanded", "false"); $("week-label").focus();
  }
});
function absorbFeed(feed: DayFeed, render = true): void {
  if (!inWindow(feed.date) || !state.categories.includes(feed.category)) return;
  windowFeeds.set(`${feed.category}:${feed.date}`, feed);
  let changed = false;
  for (const paper of feed.papers) {
    const bookmark = state.bookmarks.find((saved) => saved.id === paper.id);
    if (bookmark && !bookmark.abstract && paper.abstract) { bookmark.abstract = paper.abstract; changed = true; }
  }
  if (changed) persist();
  const selected = !loading && mode === "day" && selection?.category === feed.category && selection.date === feed.date;
  if (selected) { papers = feed.papers; cacheTime = feed.fetchedAt; error = ""; }
  if (render && (selected || searching())) renderPapers();
}
async function maintainAndWarm(force = false): Promise<void> {
  if (!appReady) return;
  const generation = ++warmEpoch;
  lastWarm = Date.now();
  const categories = [...state.categories];
  try {
    await pruneCache(categories);
    if (generation !== warmEpoch) return;
    const jobs = windowDates().flatMap((date) => categories.map((category) => ({ date, category })));
    for (const [key, feed] of windowFeeds) if (!inWindow(feed.date) || !categories.includes(feed.category)) windowFeeds.delete(key);
    let done = 0;
    cacheProgress = `Caching listings + abstracts · ${done}/${jobs.length} days`; renderCacheStatus();
    // Index every available snapshot first. A missing day or a slow network
    // request must not hide other cached days from the two-week search.
    const cached = await Promise.all(jobs.map((job) => cachedDay(job.category, job.date).catch(() => null)));
    if (generation !== warmEpoch) return;
    for (const feed of cached) if (feed) absorbFeed(feed, false);
    if (searching()) renderPapers();
    for (const [index, job] of jobs.entries()) {
      if (generation !== warmEpoch) return;
      const feed = cached[index];
      if (!feed || !fresh(feed) || (force && job.date === today())) {
        const updated = await fetchDay(job.category, job.date);
        if (generation !== warmEpoch) return;
        absorbFeed(updated);
      }
      cacheProgress = `Caching listings + abstracts · ${++done}/${jobs.length} days`; renderCacheStatus();
    }
    cacheProgress = "2 weeks cached · abstracts included"; renderCacheStatus();
  } catch (cause) {
    if (generation !== warmEpoch) return;
    cacheProgress = "Cache incomplete · will retry"; renderCacheStatus();
    // Keep the currently readable data. A selected day's own loader provides
    // its detailed error; background work should not interrupt reading.
    console.warn("Two-week cache incomplete:", cause);
  }
}
async function migrateSavedAbstracts(): Promise<void> {
  let changed = false;
  for (const bookmark of state.bookmarks) {
    if (bookmark.abstract) continue;
    const abstract = await read<string>(`abstract-${bookmark.id.replace(/\//g, "_")}`);
    if (typeof abstract === "string" && abstract) { bookmark.abstract = abstract; changed = true; }
  }
  if (changed) { persist(); await saveQueue; if (unsaved) throw new Error("Save bookmarks before migrating the old cache."); }
}
async function start(): Promise<void> {
  let storageReady = true;
  try {
    const saved = await read<State>("state");
    if (saved) {
      if (Array.isArray(saved.categories)) {
        const valid = [...new Set(saved.categories.filter((c) => typeof c === "string" && validCategory(c)))];
        if (valid.length) state.categories = valid;
      }
      if (["system", "dark", "light"].includes(saved.theme)) state.theme = saved.theme;
      if (Array.isArray(saved.bookmarks)) state.bookmarks = saved.bookmarks.filter((p) => p && typeof p.id === "string" && typeof p.title === "string" && Array.isArray(p.authors) && p.authors.every((a: unknown) => typeof a === "string") && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && typeof p.category === "string");
    }
  } catch (cause) { storageReady = false; notice(`Could not read your saved preferences. ${String(cause)}`); }
  applyTheme(); renderSidebar(); renderPapers();
  if (!storageReady) return;
  try { await migrateSavedAbstracts(); appReady = true; void maintainAndWarm(); }
  catch (cause) { notice(`Could not migrate saved abstracts. ${String(cause)}`); }
}
void start();
function checkCalendar(): void {
  if (!appReady) return;
  const updated = weekDays()[0];
  if (updated !== currentMonday) {
    currentMonday = updated; displayedMonday = updated;
    abstractValues.clear(); abstractErrors.clear(); expandedPapers.clear();
    switchWeek(updated);
  }
  if (lastCalendarDate !== today() || Date.now() - lastWarm >= 30 * 60 * 1000) {
    lastCalendarDate = today(); void maintainAndWarm();
  }
  renderSidebar();
}
setInterval(checkCalendar, 60000);
window.addEventListener("focus", checkCalendar);
// Native persistence is atomic; browser mode uses IndexedDB transactions.
if (!desktop) window.addEventListener("beforeunload", (event) => { if (unsaved) event.preventDefault(); });
