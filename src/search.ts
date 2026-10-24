import { today } from "./dates";
import { inWindow } from "./source";
import type { DayFeed, Paper } from "./types";
export interface SearchPaper extends Paper { categories: string[] }
// Search the retained calendar window, independent of the sidebar selection.
// A cross-listed paper appears once, with all of its subscribed categories.
export function windowPapers(feeds: Iterable<DayFeed>, categories: string[], reference = today()): SearchPaper[] {
  const allowed = new Set(categories);
  const papers = new Map<string, SearchPaper>();
  const snapshots = [...feeds].filter((feed) => allowed.has(feed.category) && inWindow(feed.date, reference) && feed.date <= reference)
    .sort((a, b) => b.date.localeCompare(a.date) || categories.indexOf(a.category) - categories.indexOf(b.category));
  for (const feed of snapshots) {
    for (const paper of feed.papers) {
      const existing = papers.get(paper.id);
      if (existing) {
        if (!existing.categories.includes(feed.category)) existing.categories.push(feed.category);
      } else papers.set(paper.id, { ...paper, categories: [feed.category] });
    }
  }
  return [...papers.values()].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}
