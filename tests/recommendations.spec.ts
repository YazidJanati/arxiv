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
async function review(page: Page) {
  await page.getByRole("button", { name: "Review day", exact: true }).click();
  await expect(page.locator("#for-you-controls")).toContainText("2/2 abstracts reviewed");
}
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-24T12:00:00+02:00") });
  await page.addInitScript(() => {
    const sorted = (value: any): any => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
    const usage = () => JSON.parse(localStorage.getItem("mock-usage") ?? '{"date":"2026-10-24","batches":0,"inputTokens":0,"outputTokens":0}');
    (window as any).webkit = { messageHandlers: { arxiv: { postMessage: async (message: any) => {
      const key = "native-" + message.key;
      if (message.operation === "read") return sorted(JSON.parse(localStorage.getItem(key) ?? "null"));
      if (message.operation === "write") { localStorage.setItem(key, JSON.stringify(sorted(message.value))); return null; }
      if (message.operation === "cacheKeys") return Object.keys(localStorage).filter((key) => /^native-(day-v2-|recommendations-v1-|feed-|abstract-)/.test(key)).map((key) => key.slice(7));
      if (message.operation === "removeCache") { localStorage.removeItem(key); return null; }
      if (message.operation === "fetch") { const response = await fetch("/arxiv" + message.path); if (!response.ok) throw new Error("Offline"); return response.text(); }
      if (["appearance", "open"].includes(message.operation)) return null;
      if (message.operation === "recommendationCancel") { (window as any).rejectReview?.(new Error("Cancelled")); return null; }
      if (["recommendationStatus", "recommendationLogin"].includes(message.operation)) return { available: true, connected: localStorage.getItem("mock-mode") !== "signed-out", message: "Connected through Codex", models: [{ id: "gpt-6.1-terra", name: "GPT-6.1 Terra" }, { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" }], usage: usage() };
      if (message.operation === "recommend") {
        const daily = usage();
        if (daily.batches >= message.dailyBatchLimit) throw new Error("Daily batch limit reached");
        daily.batches++; daily.inputTokens += 400; daily.outputTokens += 50; localStorage.setItem("mock-usage", JSON.stringify(daily));
        const input = JSON.parse(message.prompt), all = JSON.parse(localStorage.getItem("review-calls") ?? "[]");
        all.push({ ...input, instructions: message.instructions, model: message.model }); localStorage.setItem("review-calls", JSON.stringify(all));
        const mode = localStorage.getItem("mock-mode");
        if (mode === "hold") await new Promise<void>((resolve, reject) => { (window as any).releaseReview = resolve; (window as any).rejectReview = reject; });
        if (mode === "offline") throw new Error("Offline or usage limit reached");
        if (mode === "unknown") return { recommendations: [{ id: "9999.99999", kind: "direct", reason: "Invented paper" }] };
        if (mode === "empty") return { recommendations: [], dailyUsage: daily };
        return { dailyUsage: daily, recommendations: input.papers.map((paper: any, index: number) => ({ id: paper.id, kind: index % 2 ? "adjacent" : "direct", reason: message.instructions.includes("New profile") ? "New profile connection to randomized algorithms." : index % 2 ? "A nearby idea: <img src=x onerror=alert(1)> offers a transferable probabilistic construction." : "Introduces a useful methodological reformulation." })) };
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
});
test("startup, navigation, refresh, profile/model changes and restart never make inference requests", async ({ page }) => {
  expect(await calls(page)).toHaveLength(0);
  await forYou(page); await page.locator("#refresh").click();
  await expect(page.locator("#reader")).toHaveAttribute("aria-busy", "false");
  await page.locator("#edit-profile").click();
  await page.locator("#research-profile").fill("New profile: broad novel methodological ideas.");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await page.locator("#recommendation-model").selectOption("gpt-6.1-sol");
  await page.locator("#close-settings").click();
  await page.reload(); await expect(page.locator("#source-label")).toHaveText("2 weeks cached · abstracts included");
  await forYou(page); expect(await calls(page)).toHaveLength(0);
  await page.locator("#edit-profile").click(); await expect(page.locator("#recommendation-model")).toHaveValue("gpt-6.1-sol");
});
test("explicit Review day uses Terra, complete deduplicated abstracts and grounded adjacent explanations", async ({ page }) => {
  await forYou(page); await review(page);
  const requests = await calls(page); expect(requests).toHaveLength(1);
  expect(requests[0].model).toBe("gpt-6.1-terra"); expect(requests[0].announcementDate).toBe(date);
  expect(requests[0].papers).toHaveLength(2);
  expect(requests[0].papers.every((paper: any) => paper.date === date && paper.categories.includes("cs.LG") && paper.categories.includes("stat.ML") && paper.abstract.length > 50)).toBe(true);
  expect(requests[0].instructions).toContain("UniformRace"); expect(requests[0].instructions).toContain("no fixed quota");
  await expect(page.locator(".paper")).toHaveCount(2); await expect(page.locator(".recommendation-reason img")).toHaveCount(0);
  await expect(page.locator("#review-day")).toBeDisabled();
  await page.locator(".paper-title").first().click(); await expect(page.locator(".abstract").first()).toBeVisible();
  await page.locator(".bookmark").first().click(); await page.locator("#saved").click(); await expect(page.locator(".paper")).toHaveCount(1);
});
test("cached recommendations survive reordered native JSON, restart and offline signed-out access", async ({ page }) => {
  await forYou(page); await review(page);
  await page.evaluate(() => localStorage.setItem("mock-mode", "signed-out"));
  await page.route("**/arxiv/**", (route) => route.abort());
  await page.reload(); await forYou(page);
  await expect(page.locator(".paper")).toHaveCount(2); expect(await calls(page)).toHaveLength(1);
});
test("profile changes cancel in-flight work and require a fresh explicit review", async ({ page }) => {
  await forYou(page); await page.evaluate(() => localStorage.setItem("mock-mode", "hold"));
  await page.locator("#review-day").click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseReview)).toBe("function");
  await page.locator("#edit-profile").click(); await page.locator("#research-profile").fill("New profile: novel randomized algorithms.");
  await page.getByRole("button", { name: "Save profile", exact: true }).click(); await page.locator("#close-settings").click();
  await expect(page.locator("#stop-review")).toHaveCount(0); await expect(page.locator(".paper")).toHaveCount(0);
  expect(await calls(page)).toHaveLength(1);
  await page.evaluate(() => localStorage.removeItem("mock-mode")); await review(page);
  await expect(page.locator(".recommendation-reason").first()).toContainText("New profile connection");
});
test("invalid output is rejected without automatic retries", async ({ page }) => {
  await forYou(page); await page.evaluate(() => localStorage.setItem("mock-mode", "unknown"));
  await page.locator("#review-day").click(); await expect(page.locator("#for-you-controls")).toContainText("unknown paper");
  await expect(page.locator(".paper")).toHaveCount(0); expect(await calls(page)).toHaveLength(1);
  await page.locator("#refresh").click(); await expect(page.locator("#reader")).toHaveAttribute("aria-busy", "false");
  expect(await calls(page)).toHaveLength(1);
});
test("zero matches are cached and weekend/future dates cannot invoke a model", async ({ page }) => {
  await forYou(page); await page.evaluate(() => localStorage.setItem("mock-mode", "empty")); await review(page);
  await expect(page.getByText("No recommendations for this day.", { exact: true })).toBeVisible();
  await page.reload(); await forYou(page); await expect(page.locator("#review-day")).toBeDisabled();
  await forYou(page, "2026-10-24"); await expect(page.getByText("No daily listing on weekends.")).toBeVisible(); await expect(page.locator("#review-day")).toBeDisabled();
  await forYou(page, "2026-10-25"); await expect(page.getByText("This day hasn’t arrived yet.")).toBeVisible(); expect(await calls(page)).toHaveLength(1);
});
test("daily cap stops a large day, checkpoints every batch, and restart resumes only unreviewed abstracts", async ({ page }) => {
  const first = await page.evaluate(async () => {
    const { Recommender } = await import("/src/recommendations.ts");
    const papers = Array.from({ length: 65 }, (_, index) => ({ id: `2610.${String(index).padStart(5, "0")}`, title: `Unexpected idea ${index}`, authors: ["Author"], date: "2026-10-23", category: "cs.LG", abstract: `A complete abstract on a novel construction ${index}. `.repeat(30) }));
    const context = { connected: true, profile: "Novel methodology", model: "gpt-6.1-terra", dailyBatchLimit: 1, categories: ["cs.LG"], feeds: [{ schema: 2, date: "2026-10-23", category: "cs.LG", fetchedAt: Date.now(), papers }] };
    (window as any).testContext = context;
    const engine = new Recommender(() => context, () => {}); engine.review("2026-10-23"); await engine.idle();
    return { reviewed: engine.coverage("2026-10-23").reviewed, error: engine.errors.get("2026-10-23") };
  });
  expect(first.reviewed).toBe(30); expect(first.error).toContain("Daily batch limit"); expect(await calls(page)).toHaveLength(1);
  const second = await page.evaluate(async () => {
    const { Recommender } = await import("/src/recommendations.ts");
    const context = { ...(window as any).testContext, dailyBatchLimit: 3 };
    const engine = new Recommender(() => context, () => {}); engine.review("2026-10-23"); await engine.idle();
    return { reviewed: engine.coverage("2026-10-23").reviewed, items: engine.current("2026-10-23")?.items.length };
  });
  expect(second).toEqual({ reviewed: 65, items: 65 });
  const requests = await calls(page); expect(requests).toHaveLength(3);
  const ids = requests.flatMap((request: any) => request.papers).map((paper: any) => paper.id);
  expect(ids).toHaveLength(65); expect(new Set(ids).size).toBe(65);
});
test("Stop review immediately cancels the worker and never queues another day", async ({ page }) => {
  await forYou(page); await page.evaluate(() => localStorage.setItem("mock-mode", "hold")); await page.locator("#review-day").click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).rejectReview)).toBe("function");
  await page.locator("#stop-review").click(); await expect(page.locator("#stop-review")).toHaveCount(0);
  expect(await calls(page)).toHaveLength(1);
  await forYou(page, "2026-10-22"); expect(await calls(page)).toHaveLength(1);
});
test("legacy paid results and rejected papers are preserved without spending on a new model", async ({ page }) => {
  await page.evaluate(async () => {
    const { defaultProfile } = await import("/src/recommendations.ts"); const { cachedDay } = await import("/src/source.ts");
    const feed = await cachedDay("cs.LG", "2026-10-23");
    const items = [{ id: feed.papers[0].id, kind: "direct", reason: "Previously paid recommendation." }];
    localStorage.setItem("native-recommendations-v1-2026-10-23", JSON.stringify({ schema: 1, date: "2026-10-23", generatedAt: Date.now(), input: JSON.stringify({ profile: defaultProfile, papers: feed.papers }), items }));
  });
  await page.reload(); await forYou(page); await expect(page.locator(".paper")).toHaveCount(1); await expect(page.locator("#review-day")).toBeDisabled();
  await page.locator("#edit-profile").click(); await page.locator("#recommendation-model").selectOption("gpt-6.1-sol"); await page.locator("#close-settings").click();
  await expect(page.locator(".paper")).toHaveCount(1); expect(await calls(page)).toHaveLength(0);
});
test("week rollover cannot recreate expired in-flight results and cleanup preserves preferences", async ({ page }) => {
  await forYou(page); await page.evaluate(() => localStorage.setItem("mock-mode", "hold")); await page.locator("#review-day").click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseReview)).toBe("function");
  await page.clock.setFixedTime(new Date("2026-11-09T12:00:00+01:00"));
  const result = await page.evaluate(async () => {
    const { pruneCache } = await import("/src/source.ts"); await pruneCache(["cs.LG", "stat.ML"]);
    (window as any).releaseReview();
    return localStorage.getItem("native-state");
  });
  await expect(page.locator("#stop-review")).toHaveCount(0);
  expect(JSON.parse(result!).recommendations.model).toBe("gpt-6.1-terra");
  expect(await page.evaluate(() => localStorage.getItem("native-recommendations-v1-2026-10-23"))).toBeNull();
});
