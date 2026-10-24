import { listingDate, today, weekDays } from "./dates";
import { read, request, write } from "./platform";
import type { Feed, Paper } from "./types";
const clean = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
export const validCategory = (code: string) => /^[a-z][a-z0-9-]*(?:\.[A-Z]{2})?$/.test(code);
export const validId = (id: string) => /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/.test(id);
const keyFor = (id: string) => `abstract-${id.replace(/\//g, "_")}`;
export function parseListing(html: string, category: string): { days: Record<string, Paper[]>; count: number; total: number } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const articles = doc.querySelector("#articles");
  const totalMatch = doc.querySelector(".paging")?.textContent?.match(/Total of\s+([\d,]+)\s+entries/);
  if (!articles || !totalMatch) throw new Error("arXiv returned an unexpected listing. Please try again later.");
  const total = Number(totalMatch[1].replace(/,/g, ""));
  const days: Record<string, Paper[]> = {};
  let date: string | null = null, id: string | null = null, count = 0;
  for (const element of articles.children) {
    if (element.tagName === "H3") {
      date = listingDate(element.textContent ?? "");
      if (date) days[date] ??= [];
    } else if (element.tagName === "DT") {
      const href = element.querySelector('a[title="Abstract"]')?.getAttribute("href") ?? "";
      id = href.replace(/^\/abs\//, "").replace(/v\d+$/, "");
    } else if (element.tagName === "DD" && date && id && validId(id)) {
      const title = element.querySelector(".list-title")?.cloneNode(true) as HTMLElement | undefined;
      title?.querySelector(".descriptor")?.remove();
      const authors = Array.from(element.querySelectorAll(".list-authors a"), (a) => clean(a.textContent));
      const titleText = clean(title?.textContent);
      if (!titleText || !authors.length) throw new Error("An arXiv listing is missing its title or authors. Please refresh later.");
      days[date].push({ id, title: titleText, authors, date, category });
      count++;
      id = null;
    }
  }
  if (total > 0 && count === 0) throw new Error("arXiv's daily listing format has changed. Please try again later.");
  return { days, count, total };
}
export function parseAbstract(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const abstract = doc.querySelector("blockquote.abstract");
  abstract?.querySelector(".descriptor")?.remove();
  const result = clean(abstract?.textContent);
  if (!result) throw new Error("The abstract could not be loaded from arXiv.");
  return result;
}
const pendingFeeds = new Map<string, Promise<Feed>>();
export async function cachedFeed(category: string): Promise<Feed | null> {
  return read<Feed>(`feed-${category}`);
}
export function fresh(feed: Feed): boolean {
  return Date.now() - feed.fetchedAt < 30 * 60 * 1000;
}
export function fetchFeed(category: string): Promise<Feed> {
  if (!validCategory(category)) return Promise.reject(new Error("Invalid arXiv category code."));
  const existing = pendingFeeds.get(category);
  if (existing) return existing;
  const promise = (async () => {
    const days: Record<string, Paper[]> = {};
    const monday = weekDays()[0];
    let skip = 0;
    while (true) {
      const page = parseListing(await request(`/list/${category}/recent?skip=${skip}&show=2000`), category);
      for (const [date, papers] of Object.entries(page.days)) {
        const merged = new Map((days[date] ?? []).map((paper) => [paper.id, paper]));
        for (const paper of papers) merged.set(paper.id, paper);
        days[date] = [...merged.values()];
      }
      skip += page.count;
      // Continue through a partially displayed day; never truncate large categories.
      const oldest = Object.keys(page.days).sort()[0];
      if (skip >= page.total || (oldest && oldest < monday)) break;
      if (page.count === 0) throw new Error("arXiv did not return the next page. Please refresh later.");
      if (skip > 50000) throw new Error("This archive is too large. Add a more specific category in Settings.");
    }
    let previous: Feed | null = null;
    try { previous = await cachedFeed(category); } catch { /* Network results remain usable. */ }
    const feed = { fetchedAt: Date.now(), days: { ...previous?.days, ...days } };
    // Keep up to six weeks of daily metadata; bookmarks are stored separately.
    const cutoff = new Date(`${today()}T00:00:00Z`).getTime() - 42 * 86400000;
    for (const date of Object.keys(feed.days)) if (Date.parse(date) < cutoff) delete feed.days[date];
    try { await write(`feed-${category}`, feed); } catch { /* Reading works even if the optional cache is full. */ }
    return feed;
  })().finally(() => pendingFeeds.delete(category));
  pendingFeeds.set(category, promise);
  return promise;
}
const pendingAbstracts = new Map<string, Promise<string>>();
export function fetchAbstract(id: string): Promise<string> {
  const existing = pendingAbstracts.get(id);
  if (existing) return existing;
  const promise = (async () => {
    if (!validId(id)) throw new Error("Invalid arXiv paper ID.");
    let cached: string | null = null;
    try { cached = await read<string>(keyFor(id)); } catch { /* Fetch online. */ }
    if (cached) return cached;
    const abstract = parseAbstract(await request(`/abs/${id}`));
    try { await write(keyFor(id), abstract); } catch { /* Optional cache. */ }
    return abstract;
  })().finally(() => pendingAbstracts.delete(id));
  pendingAbstracts.set(id, promise);
  return promise;
}
