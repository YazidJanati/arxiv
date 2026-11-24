import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
const fixture = readFileSync(new URL("./fixtures/catchup.html", import.meta.url), "utf8");
const date = "2026-10-23";
async function forYou(page: Page, day = date) {
  const row = page.locator(`[data-day="${day}"]`);
  if (await row.getAttribute("aria-expanded") !== "true") await row.click();
  await page.locator(`[data-date="${day}"][data-category="for-you"]`).click();
  await expect(page.locator("#reader")).toHaveAttribute("aria-busy", "false");
}
async function calls(page: Page) { return page.evaluate(() => JSON.parse(localStorage.getItem("review-calls") ?? "[]")); }
async function reviewed(page: Page) {
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("native-recommendations-v1-")).length)).toBe(10);
}
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-24T12:00:00+02:00") });
  await page.addInitScript(() => {
    (window as any).webkit = { messageHandlers: { arxiv: { postMessage: async (message: any) => {
      const key = "native-" + message.key;
      if (message.operation === "read") return JSON.parse(localStorage.getItem(key) ?? "null");
      if (message.operation === "write") { localStorage.setItem(key, JSON.stringify(message.value)); return null; }
      if (message.operation === "cacheKeys") return Object.keys(localStorage).filter((key) => /^native-(day-v2-|recommendations-v1-|feed-|abstract-)/.test(key)).map((key) => key.slice(7));
      if (message.operation === "removeCache") { localStorage.removeItem(key); return null; }
      if (message.operation === "fetch") { const response = await fetch("/arxiv" + message.path); if (!response.ok) throw new Error("Offline"); return response.text(); }
      if (["appearance", "open"].includes(message.operation)) return null;
      if (["recommendationStatus", "recommendationLogin"].includes(message.operation)) return { available: true, connected: localStorage.getItem("mock-mode") !== "signed-out", message: "Connected through Codex" };
      if (message.operation === "recommend") {
        const input = JSON.parse(message.prompt), all = JSON.parse(localStorage.getItem("review-calls") ?? "[]");
        all.push({ ...input, instructions: message.instructions }); localStorage.setItem("review-calls", JSON.stringify(all));
        const mode = localStorage.getItem("mock-mode");
        if (mode === "hold") await new Promise<void>((resolve) => { (window as any).releaseReview = resolve; });
        if (mode === "offline") throw new Error("Offline or usage limit reached");
        if (mode === "unknown") return { recommendations: [{ id: "9999.99999", kind: "direct", reason: "Invented paper" }] };
        if (mode === "empty") return { recommendations: [] };
        return { recommendations: input.papers.map((paper: any, index: number) => ({ id: paper.id, kind: index % 2 ? "adjacent" : "direct", reason: message.instructions.includes("New profile") ? "New profile connection to randomized algorithms." : index % 2 ? "A nearby idea: <img src=x onerror=alert(1)> offers a transferable probabilistic construction." : "Introduces a useful methodological reformulation." })) };
      }
      throw new Error("Unexpected operation: " + message.operation);
    } } } };
  });
  await page.route("**/arxiv/catchup/**", (route) => {
    const day = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const label = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
    return route.fulfill({ contentType: "text/html", body: fixture.replaceAll("{{DATE}}", label) });
  });
  await page.goto("/");
  await expect(page.locator("#source-label")).toHaveText("2 weeks cached · abstracts included");
  await reviewed(page);
});
test("automatically reviews each exact day across sections, deduplicates and explains nearby ideas", async ({ page }) => {
  const requests = await calls(page);
  expect(requests).toHaveLength(10);
  expect(new Set(requests.map((request: any) => request.announcementDate)).size).toBe(10);
  for (const request of requests) {
    expect(request.papers).toHaveLength(2);
    expect(request.papers.every((paper: any) => paper.date === request.announcementDate && paper.categories.includes("cs.LG") && paper.categories.includes("stat.ML") && paper.abstract.length > 50)).toBe(true);
    expect(request.instructions).toContain("UniformRace");
    expect(request.instructions).toContain("no fixed quota");
  }
  await forYou(page);
  await expect(page.locator("#breadcrumb")).toHaveText("Friday / For you");
  await expect(page.locator(".paper")).toHaveCount(2);
  await expect(page.locator(".recommendation-reason").filter({ hasText: "Nearby idea" })).toBeVisible();
  await expect(page.locator(".recommendation-reason img")).toHaveCount(0);
  await page.locator(".paper-title").first().click();
  await expect(page.locator(".abstract").first()).toBeVisible();
  await page.locator(".bookmark").first().click();
  await page.locator("#saved").click();
  await expect(page.locator(".paper")).toHaveCount(1);
  expect(await calls(page)).toHaveLength(10);
});
test("saved recommendations survive restart and signed-out/offline access without another review", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("mock-mode", "signed-out"));
  await page.route("**/arxiv/**", (route) => route.abort());
  await page.reload(); await reviewed(page); await forYou(page);
  await expect(page.locator(".paper")).toHaveCount(2);
  await expect(page.locator(".recommendation-reason")).toHaveCount(2);
  expect(await calls(page)).toHaveLength(10);
});
test("profile edits invalidate an in-flight old review, persist and regenerate automatically", async ({ page }) => {
  await forYou(page);
  await page.evaluate(() => localStorage.setItem("mock-mode", "hold"));
  await page.locator("#refresh").click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseReview)).toBe("function");
  await page.locator("#edit-profile").click();
  await page.locator("#research-profile").fill("New profile: broad novel randomized algorithms, including surprising nearby ideas.");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await page.locator("#close-settings").click();
  await expect(page.locator(".paper")).toHaveCount(0);
  await page.evaluate(() => { localStorage.removeItem("mock-mode"); (window as any).releaseReview(); });
  await expect(page.locator(".recommendation-reason").first()).toContainText("New profile connection");
  await expect.poll(() => page.evaluate(() => {
    const records = Object.keys(localStorage).filter((key) => key.startsWith("native-recommendations-v1-"));
    return records.every((key) => JSON.parse(localStorage.getItem(key)!).input.includes("New profile"));
  })).toBe(true);
  await page.reload(); await forYou(page); await page.locator("#edit-profile").click();
  await expect(page.locator("#research-profile")).toHaveValue(/New profile/);
});
test("failed refresh preserves saved recommendations; invented IDs cannot enter a new profile", async ({ page }) => {
  await forYou(page);
  await page.evaluate(() => localStorage.setItem("mock-mode", "offline"));
  await page.locator("#refresh").click();
  await expect(page.locator("#for-you-controls")).toContainText("Offline or usage limit");
  await expect(page.locator(".paper")).toHaveCount(2);
  await page.evaluate(() => localStorage.setItem("mock-mode", "unknown"));
  await page.locator("#edit-profile").click();
  await page.locator("#research-profile").fill("New profile with broader interests.");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await page.locator("#close-settings").click();
  await expect(page.locator("#for-you-controls")).toContainText("unknown paper");
  await expect(page.locator(".paper")).toHaveCount(0);
});
test("zero matches are valid and weekend/future dates never invoke the recommender", async ({ page }) => {
  await forYou(page);
  await page.evaluate(() => localStorage.setItem("mock-mode", "empty"));
  await page.locator("#refresh").click();
  await expect(page.getByText("No recommendations for this day.", { exact: true })).toBeVisible();
  const count = (await calls(page)).length;
  await forYou(page, "2026-10-24");
  await expect(page.getByText("No daily listing on weekends.")).toBeVisible();
  await forYou(page, "2026-10-25");
  await expect(page.getByText("This day hasn’t arrived yet.")).toBeVisible();
  expect(await calls(page)).toHaveLength(count);
});
test("every complete abstract in a large day is reviewed; no prefilter or recommendation quota", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { Recommender } = await import("/src/recommendations.ts");
    const papers = Array.from({ length: 65 }, (_, index) => ({ id: `2610.${String(index).padStart(5, "0")}`, title: `Unexpected idea ${index}`, authors: ["Author"], date: "2026-10-23", category: "cs.LG", abstract: `A complete abstract on a novel construction ${index}. `.repeat(30) }));
    const engine = new Recommender(() => ({ enabled: true, connected: true, profile: "Broad novel methodological ideas", categories: ["cs.LG"], feeds: [{ schema: 2, date: "2026-10-23", category: "cs.LG", fetchedAt: Date.now(), papers }] }), () => {});
    engine.ensure("2026-10-23"); await engine.idle();
    return { items: engine.current("2026-10-23")?.items, error: engine.errors.get("2026-10-23") };
  });
  expect(result.error).toBeUndefined();
  expect(result.items).toHaveLength(65);
  const requests = (await calls(page)).slice(10);
  expect(requests).toHaveLength(3);
  expect(requests.flatMap((request: any) => request.papers).map((paper: any) => paper.id)).toHaveLength(65);
  expect(requests.every((request: any) => request.papers.every((paper: any) => paper.abstract.length > 1000))).toBe(true);
});
test("recommendation cleanup expires only managed day results and preserves profile and bookmarks", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { read, write } = await import("/src/platform.ts");
    const { pruneCache } = await import("/src/source.ts");
    const state = { categories: ["cs.LG", "stat.ML"], bookmarks: [{ id: "2001.00001", title: "Saved forever", abstract: "Complete saved abstract", authors: ["Author"], date: "2020-01-02", category: "removed" }], recommendations: { enabled: true, profile: "My profile" } };
    await write("state", state); await write("recommendations-v1-2026-09-01", { items: [] }); await write("unmanaged-record", { keep: true });
    await pruneCache(state.categories);
    return { expired: await read("recommendations-v1-2026-09-01"), current: await read("recommendations-v1-2026-10-23"), state: await read("state"), unmanaged: await read("unmanaged-record") };
  });
  expect(result.expired).toBeNull(); expect(result.current).not.toBeNull();
  expect((result.state as any).recommendations.profile).toBe("My profile");
  expect((result.state as any).bookmarks[0].abstract).toBe("Complete saved abstract");
  expect(result.unmanaged).toEqual({ keep: true });
});

test("a cached day opens immediately while a different day is still being reviewed", async ({ page }) => {
  await page.evaluate(async () => {
    const { Recommender, defaultProfile } = await import("/src/recommendations.ts");
    const { cachedDay } = await import("/src/source.ts");
    const feeds = (await Promise.all(["2026-10-22", "2026-10-23"].flatMap((date) => ["cs.LG", "stat.ML"].map((category) => cachedDay(category, date))))).filter(Boolean);
    localStorage.removeItem("native-recommendations-v1-2026-10-23"); localStorage.setItem("mock-mode", "hold");
    const engine = new Recommender(() => ({ enabled: true, connected: true, profile: defaultProfile, categories: ["cs.LG", "stat.ML"], feeds }), () => {});
    (window as any).testEngine = engine;
    engine.ensure("2026-10-23"); engine.ensure("2026-10-22");
  });
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseReview)).toBe("function");
  await expect.poll(() => page.evaluate(() => (window as any).testEngine.current("2026-10-22")?.items.length)).toBe(2);
  await page.evaluate(async () => { localStorage.removeItem("mock-mode"); (window as any).releaseReview(); await (window as any).testEngine.idle(); });
});
test("a review crossing week rollover cannot recreate an expired recommendation snapshot", async ({ page }) => {
  await page.evaluate(async () => {
    const { Recommender, defaultProfile } = await import("/src/recommendations.ts");
    const { cachedDay } = await import("/src/source.ts");
    const feeds = (await Promise.all(["cs.LG", "stat.ML"].map((category) => cachedDay(category, "2026-10-12")))).filter(Boolean);
    localStorage.removeItem("native-recommendations-v1-2026-10-12"); localStorage.setItem("mock-mode", "hold");
    const engine = new Recommender(() => ({ enabled: true, connected: true, profile: defaultProfile, categories: ["cs.LG", "stat.ML"], feeds }), () => {});
    (window as any).testEngine = engine; engine.ensure("2026-10-12");
  });
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseReview)).toBe("function");
  await page.clock.setFixedTime(new Date("2026-11-02T12:00:00+01:00"));
  const expired = await page.evaluate(async () => {
    const { pruneCache } = await import("/src/source.ts");
    await pruneCache(["cs.LG", "stat.ML"]);
    localStorage.removeItem("mock-mode"); (window as any).releaseReview(); await (window as any).testEngine.idle();
    return localStorage.getItem("native-recommendations-v1-2026-10-12");
  });
  expect(expired).toBeNull();
});
