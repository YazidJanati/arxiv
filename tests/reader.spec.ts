import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
const listing = readFileSync(new URL("./fixtures/listing.html", import.meta.url), "utf8");
const abstract = readFileSync(new URL("./fixtures/abstract.html", import.meta.url), "utf8");
async function openFriday(page: Page, category = "cs.LG") {
  await page.getByRole("button", { name: "Friday 23 Oct", exact: false }).click();
  await page.locator(`[data-date="2026-10-23"][data-category="${category}"]`).click();
  await expect(page.locator("#reader")).toHaveAttribute("aria-busy", "false");
}
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-24T12:00:00+02:00") });
  await page.route("**/arxiv/list/**", (route) => route.fulfill({ contentType: "text/html", body: listing }));
  await page.route("**/arxiv/abs/**", (route) => route.fulfill({ contentType: "text/html", body: abstract }));
  await page.goto("/");
  await expect(page.locator("[data-day]")).toHaveCount(7);
});
test("daily tree, correct announcement dates, and expandable abstracts", async ({ page }) => {
  await expect(page.getByText("Select a day, then a section.")).toBeVisible();
  await openFriday(page);
  await expect(page.locator(".paper")).toHaveCount(2);
  await expect(page.getByText("Émilie Martin", { exact: false })).toBeVisible();
  await expect(page.getByText("Thursday's Statistical Learning Paper")).toHaveCount(0);
  await expect(page.locator(".abstract").first()).toBeHidden();
  const title = page.getByRole("button", { name: "A Fix for Softmax and Cross-Entropy", exact: true });
  await title.click();
  await expect(page.locator(".abstract").first()).toContainText("numerically stable");
  await expect(title).toHaveAttribute("aria-expanded", "true");
  await title.click();
  await expect(page.locator(".abstract").first()).toBeHidden();
  await title.click();
  await expect(page.locator(".abstract").first()).toContainText("numerically stable");
});
test("search matches titles and authors without case or accent sensitivity", async ({ page }) => {
  await openFriday(page);
  const search = page.getByRole("searchbox");
  await search.fill("SOFTMAX"); await expect(page.locator(".paper")).toHaveCount(1);
  await search.fill("emilie martin"); await expect(page.locator(".paper")).toHaveCount(1);
  await expect(page.locator(".paper-title")).toHaveText("A Fix for Softmax and Cross-Entropy");
  await search.fill("Gupta"); await expect(page.locator(".paper-title")).toHaveText(/Cost-Aware/);
  await search.fill("missing author"); await expect(page.getByText("No matching papers.")).toBeVisible();
  await search.press("Escape"); await expect(page.locator(".paper")).toHaveCount(2);
});
test("bookmarks and abstracts survive reload and remain searchable offline", async ({ page }) => {
  await openFriday(page);
  await page.locator(".paper-title").first().click();
  await expect(page.locator(".abstract").first()).toContainText("numerically stable");
  await page.getByRole("button", { name: "Bookmark paper: A Fix", exact: false }).click();
  await expect.poll(() => page.evaluate(async () => { const { read } = await import("/src/platform.ts"); return (await read<any>("state"))?.bookmarks.length; })).toBe(1);
  await page.reload(); await expect(page.locator("[data-day]")).toHaveCount(7);
  await page.route("**/arxiv/**", (route) => route.abort());
  await page.locator("#saved").click();
  await expect(page.locator(".paper")).toHaveCount(1);
  await page.locator(".paper-title").click();
  await expect(page.locator(".abstract")).toContainText("numerically stable");
  await page.getByRole("searchbox").fill("barron"); await expect(page.locator(".paper")).toHaveCount(1);
  await page.getByRole("searchbox").fill("");
  await page.getByRole("button", { name: "Remove bookmark:", exact: false }).click();
  await expect(page.getByText("No bookmarks yet.")).toBeVisible();
});
test("add and remove sections, reject duplicates, persist light mode", async ({ page }) => {
  await page.getByRole("button", { name: "Add section", exact: true }).click();
  await page.getByLabel("Appearance").selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByLabel("Add an arXiv section").fill("cs.AI");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Add an arXiv section").fill("cs.AI");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("This section is already in your sidebar.")).toBeVisible();
  await page.getByLabel("Add an arXiv section").fill("invalid/code");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.locator("#category-error")).toContainText("Enter a category code");
  await page.getByRole("button", { name: "Remove stat.ML", exact: true }).click();
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await expect.poll(() => page.evaluate(async () => { const { read } = await import("/src/platform.ts"); return (await read<any>("state"))?.categories; })).toEqual(["cs.LG", "cs.AI"]);
  await page.reload(); await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Friday 23 Oct", exact: false }).click();
  await expect(page.locator('[data-date="2026-10-23"][data-category="cs.AI"]')).toBeVisible();
  await expect(page.locator('[data-category="stat.ML"]')).toHaveCount(0);
});
test("weekends and future days display an honest empty state without fetching", async ({ page }) => {
  let requests = 0; page.on("request", (request) => { if (request.url().includes("/arxiv/")) requests++; });
  await page.getByRole("button", { name: "Saturday today", exact: false }).click();
  await page.locator('[data-date="2026-10-24"][data-category="cs.LG"]').click();
  await expect(page.getByText("No daily listing on weekends.")).toBeVisible();
  await page.getByRole("button", { name: "Sunday 25 Oct", exact: false }).click();
  await page.locator('[data-date="2026-10-25"][data-category="stat.ML"]').click();
  await expect(page.getByText("This day hasn’t arrived yet.")).toBeVisible();
  expect(requests).toBe(0);
});
test("offline refresh preserves cached listings and reports the failure", async ({ page }) => {
  await openFriday(page);
  await page.route("**/arxiv/list/**", (route) => route.abort());
  await page.getByRole("button", { name: "Refresh papers", exact: true }).click();
  await expect(page.locator("#feed-notice")).toContainText("Showing cached papers");
  await expect(page.locator(".paper")).toHaveCount(2);
  await page.reload(); await openFriday(page);
  await expect(page.locator(".paper")).toHaveCount(2);
});
test("a delayed category response cannot overwrite the active selection", async ({ page }) => {
  await page.route("**/arxiv/list/cs.LG/**", async (route) => { await new Promise((r) => setTimeout(r, 200)); await route.fulfill({ contentType: "text/html", body: listing }); });
  await page.route("**/arxiv/list/stat.ML/**", (route) => route.fulfill({ contentType: "text/html", body: listing.replace("A Fix for Softmax and Cross-Entropy", "A Statistical Learning Result") }));
  await page.getByRole("button", { name: "Friday 23 Oct", exact: false }).click();
  await page.locator('[data-date="2026-10-23"][data-category="cs.LG"]').click();
  await page.locator('[data-date="2026-10-23"][data-category="stat.ML"]').click();
  await expect(page.locator(".paper-title").first()).toHaveText("A Statistical Learning Result");
  await expect(page.locator("#reader")).toHaveAttribute("aria-busy", "false");
  await page.waitForTimeout(300);
  await expect(page.locator("#breadcrumb")).toHaveText("Friday / stat.ML");
  await expect(page.locator(".paper-title").first()).toHaveText("A Statistical Learning Result");
});
test("pagination does not truncate a daily list", async ({ page }) => {
  const first = listing.slice(0, listing.indexOf('<h3>Thu,')) + '</dl></body></html>';
  const last = listing.slice(0, listing.indexOf('<dl id="articles">')) + '<dl id="articles"><h3>Fri, 23 Oct 2026</h3><dt><a title="Abstract" href="/abs/2610.30002">id</a></dt><dd><div class="list-title">Last paper on next page</div><div class="list-authors"><a>Grace Hopper</a></div></dd></dl>';
  await page.route("**/arxiv/list/cs.LG/**", (route) => route.fulfill({ contentType: "text/html", body: (route.request().url().includes("skip=0") ? first : last).replace("Total of 4 entries", "Total of 3 entries") }));
  await openFriday(page);
  await expect(page.locator(".paper")).toHaveCount(3);
  await expect(page.getByText("Last paper on next page", { exact: true })).toBeVisible();
});
test("malformed source fails clearly and can be retried", async ({ page }) => {
  await page.route("**/arxiv/list/**", (route) => route.fulfill({ body: "<html>Service unavailable</html>" }));
  await openFriday(page);
  await expect(page.locator("#feed-notice")).toContainText("unexpected listing");
  await page.route("**/arxiv/list/**", (route) => route.fulfill({ contentType: "text/html", body: listing }));
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator(".paper")).toHaveCount(2);
});
test("arXiv text is displayed safely and the sidebar can be hidden", async ({ page }) => {
  await page.route("**/arxiv/list/**", (route) => route.fulfill({ contentType: "text/html", body: listing.replace("A Fix for Softmax and Cross-Entropy", "&lt;img src=x onerror=alert(1)&gt; Safe title") }));
  await openFriday(page);
  await expect(page.locator(".paper-title").first()).toHaveText("<img src=x onerror=alert(1)> Safe title");
  await expect(page.locator(".paper img")).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle sidebar", exact: false }).click();
  await expect(page.locator("#sidebar")).toBeHidden();
  await page.getByRole("button", { name: "Toggle sidebar", exact: false }).click();
  await expect(page.locator("#sidebar")).toBeVisible();
});
