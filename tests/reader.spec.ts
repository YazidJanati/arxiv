import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
const fixture = readFileSync(new URL("./fixtures/catchup.html", import.meta.url), "utf8");
const oldAbstract = readFileSync(new URL("./fixtures/abstract.html", import.meta.url), "utf8");
function daily(date: string): string {
  const label = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
  return fixture.replaceAll("{{DATE}}", label).replaceAll("2610.31642", date === "2026-10-16" ? "2610.20642" : "2610.31642").replaceAll("A Fix for Softmax and Cross-Entropy", date === "2026-10-16" ? "Previous Week's Learning Paper" : "A Fix for Softmax and Cross-Entropy");
}
async function openFriday(page: Page, category = "cs.LG", date = "2026-10-23") {
  await page.locator(`[data-day="${date}"]`).click();
  await page.locator(`[data-date="${date}"][data-category="${category}"]`).click();
  await expect(page.locator("#reader")).toHaveAttribute("aria-busy", "false");
}
async function removeDay(page: Page, category = "cs.LG", date = "2026-10-23") {
  await page.evaluate(async ({ category, date }) => { const { removeCache } = await import("/src/platform.ts"); await removeCache(`day-v2-${category}-${date}`); }, { category, date });
}
async function ready(page: Page) {
  await expect(page.locator("[data-day]")).toHaveCount(7);
  await expect(page.locator("#source-label")).toHaveText("2 weeks cached · abstracts included");
}
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-24T12:00:00+02:00") });
  await page.route("**/arxiv/catchup/**", (route) => {
    const date = new URL(route.request().url()).pathname.split("/").at(-1)!;
    return route.fulfill({ contentType: "text/html", body: daily(date) });
  });
  await page.route("**/arxiv/abs/**", (route) => route.fulfill({ contentType: "text/html", body: oldAbstract }));
  await page.goto("/"); await ready(page);
});
test("daily titles expand complete abstracts without additional network requests", async ({ page }) => {
  await expect(page.getByText("Select a day, then a section.")).toBeVisible();
  let requests = 0; page.on("request", (request) => { if (request.url().includes("/arxiv/")) requests++; });
  await openFriday(page);
  await expect(page.locator(".paper")).toHaveCount(2);
  await expect(page.getByText("Émilie Martin", { exact: false })).toBeVisible();
  await expect(page.getByText("A replacement that should not be included")).toHaveCount(0);
  const title = page.getByRole("button", { name: "A Fix for Softmax and Cross-Entropy", exact: true });
  const abstract = page.locator("article").filter({ has: title }).locator(".abstract");
  await expect(abstract).toBeHidden();
  await title.click(); await expect(abstract).toContainText("numerically stable");
  await expect(page.getByText("Loading abstract…", { exact: true })).toHaveCount(0);
  await title.click(); await expect(abstract).toBeHidden();
  expect(requests).toBe(0);
});
test("all two-week snapshots include abstracts before any paper is opened", async ({ page }) => {
  const snapshots = await page.evaluate(async () => {
    const { cacheKeys, read } = await import("/src/platform.ts");
    return Promise.all((await cacheKeys()).map((key) => read<any>(key)));
  });
  expect(snapshots).toHaveLength(20);
  expect(snapshots.every((feed) => feed.schema === 2 && feed.date >= "2026-10-12" && feed.date <= "2026-10-23" && feed.papers.every((paper: any) => paper.abstract.length > 50))).toBe(true);
  await page.route("**/arxiv/**", (route) => route.abort());
  await page.reload(); await ready(page);
  await openFriday(page); await page.locator(".paper-title").first().click();
  await expect(page.locator(".abstract").first()).toContainText("cost-aware");
});
test("week label selects exactly current and previous weeks; startup defaults to current", async ({ page }) => {
  await page.locator("#week-label").click();
  await expect(page.locator("#week-menu button")).toHaveCount(2);
  await page.locator("#previous-week").click();
  await expect(page.locator("[data-day]").first()).toHaveAttribute("data-day", "2026-10-12");
  await expect(page.locator("#breadcrumb")).toHaveText("Previous week");
  await openFriday(page, "cs.LG", "2026-10-16");
  await expect(page.getByRole("button", { name: "Previous Week's Learning Paper", exact: true })).toBeVisible();
  await page.reload(); await ready(page);
  await expect(page.locator("[data-day]").first()).toHaveAttribute("data-day", "2026-10-19");
});
test("search matches titles and authors without case or accent sensitivity", async ({ page }) => {
  await openFriday(page);
  const search = page.getByRole("searchbox");
  await search.fill("SOFTMAX"); await expect(page.locator(".paper")).toHaveCount(1);
  await search.fill("emilie martin"); await expect(page.locator(".paper")).toHaveCount(2);
  await search.fill("Gupta"); await expect(page.locator(".paper-title")).toHaveText([/Cost-Aware/]);
  await search.fill("missing author"); await expect(page.getByText("No matching papers.")).toBeVisible();
  await search.press("Escape"); await expect(page.locator(".paper")).toHaveCount(2);
});
test("bookmarking without opening a title saves its abstract for offline use", async ({ page }) => {
  await openFriday(page);
  await page.getByRole("button", { name: "Bookmark paper: A Fix", exact: false }).click();
  await expect.poll(() => page.evaluate(async () => { const { read } = await import("/src/platform.ts"); return (await read<any>("state"))?.bookmarks[0].abstract; })).toContain("numerically stable");
  await page.route("**/arxiv/**", (route) => route.abort());
  await page.reload(); await ready(page); await page.locator("#saved").click();
  await page.locator(".paper-title").click(); await expect(page.locator(".abstract")).toContainText("numerically stable");
  await page.getByRole("searchbox").fill("barron"); await expect(page.locator(".paper")).toHaveCount(1);
  await page.getByRole("searchbox").fill("");
  await page.getByRole("button", { name: "Remove bookmark:", exact: false }).click();
  await expect(page.getByText("No bookmarks yet.")).toBeVisible();
});
test("category changes and appearance persist; removed sections lose disposable caches", async ({ page }) => {
  await page.getByRole("button", { name: "Add section", exact: true }).click();
  await page.getByLabel("Appearance").selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByLabel("Add an arXiv section").fill("cs.AI"); await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Add an arXiv section").fill("cs.AI"); await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("This section is already in your sidebar.")).toBeVisible();
  await page.getByRole("button", { name: "Remove stat.ML", exact: true }).click();
  await page.getByRole("button", { name: "Close settings", exact: true }).click(); await ready(page);
  await expect.poll(() => page.evaluate(async () => { const { cacheKeys } = await import("/src/platform.ts"); return (await cacheKeys()).filter((key) => key.includes("stat.ML")).length; })).toBe(0);
  await expect.poll(() => page.evaluate(async () => { const { read } = await import("/src/platform.ts"); return (await read<any>("state"))?.categories; })).toEqual(["cs.LG", "cs.AI"]);
  await page.reload(); await ready(page); await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
test("weekends and future days display an honest empty state without fetching", async ({ page }) => {
  let requests = 0; page.on("request", (request) => { if (request.url().includes("/arxiv/")) requests++; });
  await page.locator('[data-day="2026-10-24"]').click();
  await page.locator('[data-date="2026-10-24"][data-category="cs.LG"]').click();
  await expect(page.getByText("No daily listing on weekends.")).toBeVisible();
  await page.locator('[data-day="2026-10-25"]').click();
  await page.locator('[data-date="2026-10-25"][data-category="stat.ML"]').click();
  await expect(page.getByText("This day hasn’t arrived yet.")).toBeVisible(); expect(requests).toBe(0);
});
test("offline refresh preserves complete cached listings and abstracts", async ({ page }) => {
  await openFriday(page); await page.route("**/arxiv/catchup/**", (route) => route.abort());
  await page.getByRole("button", { name: "Refresh papers", exact: true }).click();
  await expect(page.locator("#feed-notice")).toContainText("Showing cached papers");
  await expect(page.locator(".paper")).toHaveCount(2);
  await page.locator(".paper-title").first().click(); await expect(page.locator(".abstract").first()).toContainText("cost-aware");
});
test("delayed foreground requests cannot overwrite another selection", async ({ page }) => {
  await removeDay(page); await removeDay(page, "stat.ML");
  await page.route("**/arxiv/catchup/cs.LG/2026-10-23?*", async (route) => { await new Promise((r) => setTimeout(r, 200)); await route.fulfill({ contentType: "text/html", body: daily("2026-10-23") }); });
  await page.route("**/arxiv/catchup/stat.ML/2026-10-23?*", (route) => route.fulfill({ contentType: "text/html", body: daily("2026-10-23").replace("Cost-Aware Abstention for LLM-Based IT Ticket Classification", "A Statistical Learning Result") }));
  await page.locator('[data-day="2026-10-23"]').click();
  await page.locator('[data-date="2026-10-23"][data-category="cs.LG"]').click();
  await page.locator('[data-date="2026-10-23"][data-category="stat.ML"]').click();
  await expect(page.locator(".paper-title").first()).toHaveText("A Statistical Learning Result");
  await page.waitForTimeout(300); await expect(page.locator("#breadcrumb")).toHaveText("Friday / stat.ML");
  await expect(page.locator(".paper-title").first()).toHaveText("A Statistical Learning Result");
});
test("pagination preserves every new and cross-listed paper with its abstract", async ({ page }) => {
  await removeDay(page);
  const first = daily("2026-10-23").split('<h3>Replacement submissions')[0] + '</dl></div></html>';
  const last = daily("2026-10-23").split('<dl id="articles">')[0] + '<dl id="articles"><h3>Cross-lists (continued)</h3><dt><a title="Abstract" href="/abs/2610.30002">id</a></dt><dd><div class="meta"><div class="list-title">Last paper on next page</div><div class="list-authors"><a>Grace Hopper</a></div><p class="mathjax">A complete abstract from the second page of the daily listing.</p></div></dd></dl></div>';
  await page.route("**/arxiv/catchup/cs.LG/2026-10-23?*", (route) => route.fulfill({ contentType: "text/html", body: new URL(route.request().url()).searchParams.get("page") === "1" ? first : last }));
  await openFriday(page); await expect(page.locator(".paper")).toHaveCount(3);
  await expect(page.getByText("Last paper on next page", { exact: true })).toBeVisible();
});
test("malformed source fails clearly without caching partial data and can be retried", async ({ page }) => {
  await removeDay(page);
  await page.route("**/arxiv/catchup/cs.LG/2026-10-23?*", (route) => route.fulfill({ body: "<html>Service unavailable</html>" }));
  await openFriday(page); await expect(page.locator("#feed-notice")).toContainText("unexpected daily listing");
  expect(await page.evaluate(async () => { const { read } = await import("/src/platform.ts"); return read("day-v2-cs.LG-2026-10-23"); })).toBeNull();
  await page.route("**/arxiv/catchup/cs.LG/2026-10-23?*", (route) => route.fulfill({ contentType: "text/html", body: daily("2026-10-23") }));
  await page.getByRole("button", { name: "Try again", exact: true }).click(); await expect(page.locator(".paper")).toHaveCount(2);
});
test("cleanup keeps only two calendar weeks and never deletes bookmarks or preferences", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { write, read, cacheKeys, removeCache } = await import("/src/platform.ts");
    const { pruneCache, windowBounds } = await import("/src/source.ts");
    const state = { categories: ["cs.LG", "stat.ML"], theme: "light", bookmarks: [{ id: "2401.00001", title: "A saved older paper", date: "2024-01-01", category: "cs.LG", authors: ["A. Author"], abstract: "Preserved bookmark abstract." }] };
    await write("state", state);
    for (const key of ["day-v2-cs.LG-2026-10-09", "day-v2-cs.LG-2026-10-26", "day-v2-cs.AI-2026-10-23", "feed-cs.LG", "abstract-2401.00001"]) await write(key, { old: true });
    await pruneCache(["cs.LG", "stat.ML"]);
    let stateProtected = false; try { await removeCache("state"); } catch { stateProtected = true; }
    return { keys: await cacheKeys(), saved: await read("state"), stateProtected, bounds: windowBounds("2026-10-24"), yearBounds: windowBounds("2027-01-02") };
  });
  expect(result.keys).toHaveLength(20);
  expect(result.keys.every((key) => /^day-v2-(cs.LG|stat.ML)-2026-10-(1[2-6]|19|2[0-3])$/.test(key))).toBe(true);
  expect(result.saved).toMatchObject({ theme: "light", bookmarks: [{ abstract: "Preserved bookmark abstract." }] });
  expect(result.stateProtected).toBe(true); expect(result.bounds).toEqual(["2026-10-12", "2026-10-26"]); expect(result.yearBounds).toEqual(["2026-12-21", "2027-01-04"]);
});
test("legacy saved abstracts migrate before old caches are removed", async ({ page }) => {
  await page.evaluate(async () => {
    const { write } = await import("/src/platform.ts");
    await write("state", { categories: ["cs.LG", "stat.ML"], theme: "dark", bookmarks: [{ id: "2401.00001", title: "Saved before the migration", authors: ["A. Author"], date: "2024-01-01", category: "cs.LG" }] });
    await write("abstract-2401.00001", "The previously cached abstract is preserved with this bookmark.");
    await write("feed-cs.LG", { days: { "2024-01-01": [] } });
  });
  await page.reload(); await ready(page); await page.locator("#saved").click(); await page.locator(".paper-title").click();
  await expect(page.locator(".abstract")).toContainText("previously cached abstract");
  expect(await page.evaluate(async () => { const { cacheKeys } = await import("/src/platform.ts"); return (await cacheKeys()).filter((key) => key.startsWith("abstract-") || key.startsWith("feed-")); })).toEqual([]);
});
test("Monday rollover advances the window, evicts expired snapshots, and keeps bookmarks", async ({ page }) => {
  await openFriday(page); await page.getByRole("button", { name: "Bookmark paper: A Fix", exact: false }).click();
  await page.clock.setSystemTime(new Date("2026-10-26T12:00:00+01:00")); await page.clock.runFor(60000);
  await expect(page.locator("[data-day]").first()).toHaveAttribute("data-day", "2026-10-26"); await ready(page);
  const keys = await page.evaluate(async () => { const { cacheKeys } = await import("/src/platform.ts"); return cacheKeys(); });
  expect(keys).toHaveLength(12); expect(keys.every((key) => key.slice(-10) >= "2026-10-19" && key.slice(-10) <= "2026-10-26")).toBe(true);
  await page.locator("#saved").click(); await page.locator(".paper-title").click(); await expect(page.locator(".abstract")).toContainText("numerically stable");
});
test("an in-flight fetch cannot recreate a removed section's cache", async ({ page }) => {
  await page.route("**/arxiv/catchup/cs.AI/**", async (route) => { await new Promise((r) => setTimeout(r, 100)); await route.fulfill({ contentType: "text/html", body: daily("2026-10-23") }); });
  const keys = await page.evaluate(async () => {
    const { fetchDay, pruneCache } = await import("/src/source.ts"); const { cacheKeys } = await import("/src/platform.ts");
    await pruneCache(["cs.LG", "stat.ML", "cs.AI"]);
    const pending = fetchDay("cs.AI", "2026-10-23"); await pruneCache(["cs.LG", "stat.ML"]); await pending; return cacheKeys();
  });
  expect(keys.some((key) => key.includes("cs.AI"))).toBe(false);
});
test("remote text remains inert and titles retain bold crimson styling", async ({ page }) => {
  await removeDay(page);
  await page.route("**/arxiv/catchup/cs.LG/2026-10-23?*", (route) => route.fulfill({ contentType: "text/html", body: daily("2026-10-23").replace("A Fix for Softmax and Cross-Entropy", "&lt;img src=x onerror=alert(1)&gt; Safe title") }));
  await openFriday(page); const title = page.getByRole("button", { name: "<img src=x onerror=alert(1)> Safe title", exact: true });
  await expect(title).toBeVisible(); await expect(title).toHaveCSS("color", "rgb(179, 27, 27)"); await expect(title).toHaveCSS("font-weight", "700");
  await expect(page.locator(".paper img")).toHaveCount(0);
});
test("incorrect daily dates and missing abstracts are rejected", async ({ page }) => {
  const failures = await page.evaluate(async (html) => {
    const { parseCatchup } = await import("/src/source.ts");
    const result: boolean[] = [];
    for (const [body, date] of [[html, "2026-10-22"], [html.replace(/<p class="mathjax">[^<]*<\/p>/, ""), "2026-10-23"]]) {
      try { parseCatchup(body, "cs.LG", date); result.push(false); } catch { result.push(true); }
    }
    return result;
  }, daily("2026-10-23"));
  expect(failures).toEqual([true, true]);
});
test("a fetch crossing Monday cannot restore an expired day", async ({ page }) => {
  await removeDay(page, "cs.LG", "2026-10-12");
  let release: () => void = () => {};
  const responseReady = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/arxiv/catchup/cs.LG/2026-10-12?*", async (route) => { await responseReady; await route.fulfill({ contentType: "text/html", body: daily("2026-10-12") }); });
  const requested = page.waitForRequest((request) => request.url().includes("/catchup/cs.LG/2026-10-12"));
  const fetch = page.evaluate(async () => { const { fetchDay } = await import("/src/source.ts"); await fetchDay("cs.LG", "2026-10-12"); });
  await requested; await page.clock.setSystemTime(new Date("2026-10-26T12:00:00+01:00"));
  await page.evaluate(async () => { const { pruneCache } = await import("/src/source.ts"); await pruneCache(["cs.LG", "stat.ML"]); });
  release(); await fetch;
  const keys = await page.evaluate(async () => { const { cacheKeys } = await import("/src/platform.ts"); return cacheKeys(); });
  expect(keys.some((key) => key.endsWith("2026-10-12"))).toBe(false);
});

async function seedSearchPaper(page: Page, overrides: Record<string, string> = {}) {
  await page.evaluate(async (overrides) => {
    const { write } = await import("/src/platform.ts");
    const paper = { id: "2610.19001", title: "Previous Statistics Result", authors: ["Mira Curie"], category: "stat.ML", date: "2026-10-14", abstract: "A complete cached abstract for a paper from another section in the previous week.", ...overrides };
    await write(`day-v2-${paper.category}-${paper.date}`, { schema: 2, category: paper.category, date: paper.date, fetchedAt: Date.now(), papers: [paper] });
  }, overrides);
}
test("search includes another section in the previous week and supports paper actions", async ({ page }) => {
  await seedSearchPaper(page); await page.reload(); await ready(page); await openFriday(page);
  let requests = 0; page.on("request", (request) => { if (request.url().includes("/arxiv/")) requests++; });
  const search = page.getByRole("searchbox"); await search.fill("Mira Curie");
  await expect(page.locator("#breadcrumb")).toHaveText("Search / both weeks");
  await expect(page.locator(".paper-title")).toHaveText("Previous Statistics Result");
  await expect(page.locator(".saved-meta")).toContainText("stat.ML · 14 Oct 2026");
  await page.locator(".paper-title").click(); await expect(page.locator(".abstract")).toContainText("another section in the previous week");
  await page.getByRole("button", { name: "Bookmark paper: Previous Statistics Result", exact: true }).click();
  await expect.poll(() => page.evaluate(async () => { const { read } = await import("/src/platform.ts"); return (await read<any>("state"))?.bookmarks[0]?.id; })).toBe("2610.19001");
  await search.fill(""); await expect(page.locator("#breadcrumb")).toHaveText("Friday / cs.LG");
  await expect(page.locator(".paper")).toHaveCount(2); expect(requests).toBe(0);
});
test("search works from startup and is independent of the displayed week", async ({ page }) => {
  const search = page.getByRole("searchbox"); await search.fill("Previous Week");
  await expect(page.locator(".paper-title")).toHaveText("Previous Week's Learning Paper");
  await page.locator("#week-label").click(); await page.locator("#previous-week").click();
  await expect(search).toHaveValue("Previous Week"); await expect(page.locator(".paper")).toHaveCount(1);
  await search.fill("softmax"); await expect(page.locator(".paper-title")).toHaveText("A Fix for Softmax and Cross-Entropy");
  await expect(page.locator(".saved-meta")).toContainText("23 Oct 2026");
  await search.fill(""); await expect(page.locator("#breadcrumb")).toHaveText("Previous week");
});
test("cross-listed search results are deduplicated with all sections shown", async ({ page }) => {
  await page.getByRole("searchbox").fill("cost-aware");
  await expect(page.locator(".paper")).toHaveCount(1);
  await expect(page.locator(".saved-meta")).toHaveText("cs.LG, stat.ML · 23 Oct 2026");
});
test("older bookmarks remain searchable without affecting the main two-week search", async ({ page }) => {
  await page.evaluate(async () => {
    const { write } = await import("/src/platform.ts");
    await write("state", { categories: ["cs.LG", "stat.ML"], theme: "dark", bookmarks: [{ id: "2401.00001", title: "Ancient Saved Result", authors: ["Old Author"], date: "2024-01-01", category: "cs.LG", abstract: "An older saved abstract." }] });
  });
  await page.reload(); await ready(page); await page.locator("#saved").click();
  await expect(page.locator(".paper-title")).toHaveText("Ancient Saved Result");
  await expect(page.getByRole("searchbox")).toHaveAttribute("placeholder", "Search all bookmarks");
  await page.getByRole("searchbox").fill("Ancient Saved"); await expect(page.locator(".paper-title")).toHaveText("Ancient Saved Result");
  await expect(page.locator("#breadcrumb")).toHaveText("Search / bookmarks");
  await page.getByRole("searchbox").fill("Old Author"); await expect(page.locator(".paper-title")).toHaveText("Ancient Saved Result");
  await page.locator(".paper-title").click(); await expect(page.locator(".abstract")).toContainText("older saved abstract");
  await page.getByRole("searchbox").fill("Previous Week"); await expect(page.getByText("No matching papers.")).toBeVisible();
  await page.getByRole("searchbox").fill(""); await expect(page.locator(".paper-title")).toHaveText("Ancient Saved Result");
  await openFriday(page); await page.getByRole("searchbox").fill("Ancient Saved");
  await expect(page.getByText("No matching papers.")).toBeVisible();
});
test("cached search remains complete when another uncached day cannot download", async ({ page }) => {
  await seedSearchPaper(page); await removeDay(page);
  await page.route("**/arxiv/**", (route) => route.abort()); await page.reload();
  await expect(page.locator("#source-label")).toHaveText("Cache incomplete · will retry");
  await page.getByRole("searchbox").fill("Mira Curie"); await expect(page.locator(".paper-title")).toHaveText("Previous Statistics Result");
});
test("rolling the window forward removes expired papers from an active search", async ({ page }) => {
  await seedSearchPaper(page, { id: "2610.10001", title: "Window Boundary Result from the oldest week", date: "2026-10-12" });
  await seedSearchPaper(page, { id: "2610.30001", title: "Window Boundary Result to retain", date: "2026-10-23", category: "cs.LG" });
  await page.reload(); await ready(page); await page.getByRole("searchbox").fill("Window Boundary Result");
  await expect(page.locator(".paper")).toHaveCount(2);
  await page.clock.setSystemTime(new Date("2026-10-26T12:00:00+01:00")); await page.clock.runFor(60000); await ready(page);
  await expect(page.getByRole("searchbox")).toHaveValue("Window Boundary Result");
  await expect(page.locator(".paper-title")).toHaveText("Window Boundary Result to retain");
});

test("bookmarks from arbitrary weeks and unfollowed sections survive rollover, cleanup, and offline reload", async ({ page }) => {
  await page.evaluate(async () => {
    const { write } = await import("/src/platform.ts");
    await write("state", { categories: ["cs.LG", "stat.ML"], theme: "dark", bookmarks: [
      { id: "2401.00001", title: "Older saved robotics paper", authors: ["Ada Researcher"], date: "2024-01-03", category: "cs.RO", abstract: "The full abstract of the older saved robotics paper." },
      { id: "2606.00002", title: "Saved paper from another month", authors: ["Bea Researcher"], date: "2026-06-01", category: "math.OC", abstract: "The full abstract of a saved paper from another month." },
    ] });
  });
  await page.reload(); await ready(page); await page.locator("#saved").click();
  await expect(page.locator(".paper")).toHaveCount(2);
  await page.getByRole("searchbox").fill("Ada Researcher"); await expect(page.locator(".paper-title")).toHaveText(["Older saved robotics paper"]); await page.locator(".paper-title").click();
  for (const date of ["2026-10-26T12:00:00+01:00", "2026-11-02T12:00:00+01:00"]) {
    await page.clock.setSystemTime(new Date(date)); await page.clock.runFor(60000);
    await expect(page.locator("#breadcrumb")).toHaveText("Search / bookmarks");
    await expect(page.locator(".paper-title")).toHaveText("Older saved robotics paper");
    await expect(page.locator(".abstract")).toContainText("older saved robotics paper");
    await expect(page.locator(".abstract")).toBeVisible();
  }
  await page.route("**/arxiv/**", (route) => route.abort()); await page.reload();
  await expect(page.locator("[data-day]")).toHaveCount(7); await page.locator("#saved").click();
  await expect(page.locator(".paper")).toHaveCount(2);
  await page.getByRole("searchbox").fill("Bea Researcher"); await expect(page.locator(".paper-title")).toHaveText(["Saved paper from another month"]); await page.locator(".paper-title").click();
  await expect(page.locator(".abstract")).toContainText("another month");
  await page.getByRole("button", { name: "Remove bookmark: Saved paper from another month", exact: true }).click();
  await expect(page.getByText("No matching papers.")).toBeVisible();
  await page.getByRole("searchbox").fill(""); await expect(page.locator(".paper-title")).toHaveText("Older saved robotics paper");
});


test("large cached searches leave input events light and reveal every match in scroll batches", async ({ page }) => {
  await page.evaluate(async () => {
    const { write } = await import("/src/platform.ts");
    const papers = Array.from({ length: 4000 }, (_, i) => ({
      id: `2610.${String(i).padStart(5, "0")}`, title: `Batch candidate ${i === 0 ? "targetzero" : i}`,
      authors: ["Émilie Researcher"], category: "cs.LG", date: "2026-10-23",
      abstract: `Complete abstract for candidate ${i}. `.repeat(50),
    }));
    await write("day-v2-cs.LG-2026-10-23", { schema: 2, category: "cs.LG", date: "2026-10-23", fetchedAt: Date.now(), papers });
  });
  await page.reload(); await ready(page);
  // Observe the input event itself: rendering must happen after it returns,
  // and rapid inputs must discard the superseded result work.
  const mutations = await page.evaluate(() => {
    const observer = new MutationObserver(() => {});
    observer.observe(document.getElementById("app")!, { subtree: true, childList: true, attributes: true, characterData: true });
    const input = document.getElementById("search") as HTMLInputElement;
    for (const query of ["B", "Batch", "Batch candidate"]) {
      input.value = query; input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const count = observer.takeRecords().length; observer.disconnect(); return count;
  });
  expect(mutations).toBe(0);
  await expect(page.locator("#status")).toContainText("4000 results");
  await expect(page.locator(".paper")).toHaveCount(60);
  await expect(page.locator(".paper-title").first()).toHaveText("Batch candidate 3999");
  await page.locator(".paper-title").last().scrollIntoViewIfNeeded();
  await expect(page.locator(".paper")).toHaveCount(120);
  await page.locator(".paper-title").nth(70).click();
  await expect(page.locator(".abstract").nth(70)).toBeVisible();
  await expect(page.locator(".abstract").nth(70)).toContainText("Complete abstract for candidate 3929");
  // Searching targets the full index, including matches not yet in the DOM.
  const search = page.getByRole("searchbox");
  await search.fill("targetzero"); await expect(page.locator(".paper-title")).toHaveText(["Batch candidate targetzero"]);
  await page.getByRole("button", { name: "Bookmark paper: Batch candidate targetzero", exact: true }).click();
  await page.locator("#saved").click();
  await search.fill("emilie researcher"); await expect(page.locator(".paper-title")).toHaveText("Batch candidate targetzero");
  await search.fill("missing"); await search.press("Escape");
  await expect(search).toHaveValue(""); await expect(page.locator(".paper-title")).toHaveText("Batch candidate targetzero");
});
