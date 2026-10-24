export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export const dateObject = (iso: string) => new Date(`${iso}T12:00:00Z`);
export function offsetDate(iso: string, amount: number): string {
  const d = dateObject(iso);
  d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}
export function weekDays(iso = today()): string[] {
  const monday = offsetDate(iso, -((dateObject(iso).getUTCDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => offsetDate(monday, i));
}
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
export function formatDate(iso: string, options: Intl.DateTimeFormatOptions): string {
  const key = JSON.stringify(options);
  let formatter = dateFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" });
    dateFormatters.set(key, formatter);
  }
  return formatter.format(dateObject(iso));
}
export const isWeekend = (iso: string) => [0, 6].includes(dateObject(iso).getUTCDay());
export function listingDate(text: string): string | null {
  const match = text.match(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\b/);
  if (!match) return null;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(match[2]) + 1;
  return `${match[3]}-${String(month).padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}
