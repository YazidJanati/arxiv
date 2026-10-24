import { isWeekend, listingDate, offsetDate, today, weekDays } from "./dates";
import { cacheKeys, read, removeCache, request, write } from "./platform";
import type { DayFeed } from "./types";
const clean = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
export const validCategory = (code: string) => /^[a-z][a-z0-9-]*(?:\.[A-Z]{2})?$/.test(code);
export const validId = (id: string) => /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/.test(id);
export const dayKey = (category: string, date: string) => `day-v2-${category}-${date}`;
export function windowBounds(reference = today()): [string, string] {
  const monday = weekDays(reference)[0];
  return [offsetDate(monday, -7), offsetDate(monday, 7)];
}
export function inWindow(date: string, reference = today()): boolean {
  const [start, end] = windowBounds(reference);
  return date >= start && date < end;
}
export function windowDates(): string[] {
  const [start, end] = windowBounds();
  const result: string[] = [];
  for (let date = start; date < end && date <= today(); date = offsetDate(date, 1)) {
    if (!isWeekend(date)) result.push(date);
  }
  return result.reverse();
}
export function parseCatchup(html: string, category: string, date: string): { papers: DayFeed["papers"]; count: number; total: number } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const container = doc.querySelector("#dlpage");
  const totalMatch = container?.textContent?.match(/Total of\s+([\d,]+)\s+entries/);
  if (!totalMatch || listingDate(container?.querySelector("h1")?.textContent ?? "") !== date) {
    throw new Error("arXiv returned an unexpected daily listing. Please try again later.");
  }
  const total = Number(totalMatch[1].replace(/,/g, ""));
  // arXiv emits a separate dl with the same id for each announcement type.
  const articles = Array.from(container?.querySelectorAll("dl#articles") ?? []);
  if (!articles.length && total !== 0) throw new Error("arXiv returned an incomplete daily listing.");
  const papers: DayFeed["papers"] = [];
  let include = false, knownSection = false, id: string | null = null, count = 0;
  for (const element of articles.flatMap((list) => Array.from(list.children))) {
    if (element.tagName === "H3") {
      const heading = clean(element.textContent);
      include = /^(New submissions|Cross-lists|Cross submissions)/i.test(heading);
      knownSection = include || /^Replacement(?:s| submissions)/i.test(heading);
      if (!knownSection) throw new Error("arXiv's daily listing sections have changed.");
    } else if (element.tagName === "DT") {
      id = (element.querySelector('a[title="Abstract"]')?.getAttribute("href") ?? "").replace(/^\/abs\//, "").replace(/v\d+$/, "");
    } else if (element.tagName === "DD") {
      count++;
      if (!knownSection || !id || !validId(id)) throw new Error("An arXiv listing has an invalid paper ID.");
      if (include) {
        const title = element.querySelector(".list-title")?.cloneNode(true) as HTMLElement | undefined;
        title?.querySelector(".descriptor")?.remove();
        const titleText = clean(title?.textContent);
        const authors = Array.from(element.querySelectorAll(".list-authors a"), (a) => clean(a.textContent));
        const abstract = clean(element.querySelector(".meta > p.mathjax")?.textContent);
        if (!titleText || !authors.length || !abstract) throw new Error("An arXiv listing is missing its title, authors, or abstract. Please refresh later.");
        papers.push({ id, title: titleText, authors, date, category, abstract });
      }
      id = null;
    }
  }
  if (total > 0 && count === 0) throw new Error("arXiv returned an incomplete daily listing.");
  return { papers, count, total };
}
export function parseAbstract(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const abstract = doc.querySelector("blockquote.abstract");
  abstract?.querySelector(".descriptor")?.remove();
  const result = clean(abstract?.textContent);
  if (!result) throw new Error("The abstract could not be loaded from arXiv.");
  return result;
}
let allowedCategories: Set<string> | null = null;
let mutationQueue: Promise<unknown> = Promise.resolve();
function mutate<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation);
  mutationQueue = result.catch(() => {});
  return result;
}
export async function pruneCache(categories: string[]): Promise<void> {
  allowedCategories = new Set(categories);
  await mutate(async () => {
    for (const key of await cacheKeys()) {
      const match = key.match(/^day-v2-(.+)-(\d{4}-\d{2}-\d{2})$/);
      if (!match || !allowedCategories!.has(match[1]) || !inWindow(match[2]) || match[2] > today()) await removeCache(key);
    }
  });
}
export async function cachedDay(category: string, date: string): Promise<DayFeed | null> {
  if (!inWindow(date)) return null;
  const feed = await read<DayFeed>(dayKey(category, date));
  if (!feed || feed.schema !== 2 || feed.category !== category || feed.date !== date || !Array.isArray(feed.papers) || !feed.papers.every((paper) => paper.date === date && paper.category === category && validId(paper.id) && typeof paper.title === "string" && Array.isArray(paper.authors) && paper.authors.every((author) => typeof author === "string") && typeof paper.abstract === "string" && paper.abstract.length > 0)) return null;
  return feed;
}
export function fresh(feed: DayFeed): boolean {
  // A snapshot taken after its announcement day is final. Today's empty or
  // still-changing snapshot must be revisited, including after midnight.
  return feed.fetchedAt >= Date.parse(`${offsetDate(feed.date, 1)}T00:00:00Z`) || Date.now() - feed.fetchedAt < 30 * 60 * 1000;
}
const pendingDays = new Map<string, Promise<DayFeed>>();
export function fetchDay(category: string, date: string): Promise<DayFeed> {
  if (!validCategory(category) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !inWindow(date) || date > today()) return Promise.reject(new Error("This date is outside the two-week window."));
  const key = dayKey(category, date), existing = pendingDays.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const papers = new Map<string, DayFeed["papers"][number]>();
    let pageNumber = 1, received = 0;
    while (true) {
      const page = parseCatchup(await request(`/catchup/${category}/${date}?abs=True&page=${pageNumber}`), category, date);
      for (const paper of page.papers) papers.set(paper.id, paper);
      received += page.count;
      if (received >= page.total) break;
      if (page.count === 0 || pageNumber >= 100) throw new Error("arXiv did not return the complete daily listing. Please refresh later.");
      pageNumber++;
    }
    const feed: DayFeed = { schema: 2, date, category, fetchedAt: Date.now(), papers: [...papers.values()].sort((a, b) => b.id.localeCompare(a.id)) };
    await mutate(async () => {
      // Recheck after the request: the calendar may have rolled over, or the
      // section may have been removed while it was in flight.
      if (inWindow(date) && (!allowedCategories || allowedCategories.has(category))) await write(key, feed);
    });
    return feed;
  })().finally(() => pendingDays.delete(key));
  pendingDays.set(key, promise);
  return promise;
}
const pendingAbstracts = new Map<string, Promise<string>>();
// Only older bookmarks from the original app may lack an abstract. New daily
// snapshots always contain it; fallback results live with the bookmark itself.
export function fetchAbstract(id: string): Promise<string> {
  const existing = pendingAbstracts.get(id);
  if (existing) return existing;
  const promise = (async () => {
    if (!validId(id)) throw new Error("Invalid arXiv paper ID.");
    return parseAbstract(await request(`/abs/${id}`));
  })().finally(() => pendingAbstracts.delete(id));
  pendingAbstracts.set(id, promise);
  return promise;
}
