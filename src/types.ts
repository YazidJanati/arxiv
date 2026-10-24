export interface Paper {
  id: string;
  title: string;
  authors: string[];
  date: string;
  category: string;
  abstract?: string;
}
export type Theme = "system" | "dark" | "light";
export interface State {
  categories: string[];
  theme: Theme;
  bookmarks: Paper[];
}
export interface Feed {
  fetchedAt: number;
  days: Record<string, Paper[]>;
}
export interface Selection { date: string; category: string }
