# arxiv

A minimal macOS reader for daily arXiv papers, styled after [text](https://github.com/YazidJanati/text): a narrow sidebar, monospace type, quiet colors, and a plain reading pane.

## Reading

- Open a weekday in the left sidebar, then select **cs.LG** or **stat.ML**.
- Click the week label above the days to choose **This week** or **Previous week**. Each launch starts on the current week.
- Read paper titles and authors. Click a title to expand or collapse its abstract.
- Use the bookmark beside a paper to save it. **Bookmarks** collects saved papers across days and sections.
- Search all subscribed sections across both retained weeks by title and author name, from any view. Cross-listed papers appear once, with their categories and announcement date. Clearing search restores the current view. Search ignores case and accents.
- Use **+** or **Settings** to add more arXiv category codes, such as `cs.AI`, `cs.CL`, `cs.CV`, `math.OC`, or `quant-ph`. Remove sections in Settings; at least one section remains.
- Choose **Dark**, **Light**, or **System** appearance in Settings.
- The arXiv and PDF controls beneath an abstract open the original paper in your default browser.

The app keeps exactly two local calendar weeks: the current Monday–Sunday week and the preceding Monday–Sunday week. Daily lists use **arXiv's actual announcement dates**, not the paper's submission timestamp. Weekends, future dates, and days without announcements display an empty state. Global arXiv search and browsing older weeks are outside this version's scope.

Listings and **complete abstracts arrive together** from arXiv's dated [catch-up pages](https://arxiv.org/catchup). The app includes new submissions and cross-lists, excludes replacements, and follows all required pages. It verifies each response's announcement date and rejects incomplete records rather than caching partial abstracts. No third-party proxy is used.

On launch the app automatically downloads available weekdays in both weeks for every subscribed section. It prioritizes newer days, shows progress in the footer, and lets you open a day immediately while the rest downloads. The native app serializes requests with at least three seconds between starts. Once a daily snapshot is cached, opening a title uses the abstract already included in that snapshot—there is no separate network request or disk lookup on expansion. Bookmarks created from these snapshots include the abstract even if you never expand the paper.

Final snapshots of completed announcement days are reused. Snapshots taken during their announcement day are checked again after 30 minutes or on a subsequent day, so an early empty listing does not stay empty forever. Manual refresh is also available. Offline failures preserve readable snapshots and show an incomplete-cache status; the app retries automatically during later cache checks.

Expired snapshots are deleted on launch, on the first calendar check after Monday rollover, and when a section is removed. Calendar checks run every minute while the app is open and when its window receives focus. If the app stays closed across a rollover, cleanup occurs at its next launch. Both titles and abstracts live in each daily snapshot and expire together. In-flight requests cannot recreate a snapshot that has fallen outside the window or belongs to a removed section. No PDFs or remote HTML pages are saved. Native HTTP response caching is disabled.

**Bookmarks are your saved collection, separate from the rolling cache.** They remain until you remove them, including older saved papers and their abstracts. During the first launch of this update, previously cached bookmark abstracts are copied into the bookmark collection before legacy cache files are deleted.

arXiv's HTML is parsed as text in an inert document. Paper metadata is escaped before display. The native bridge restricts networking to arXiv's daily catch-up pages, category listings, and paper abstracts. Cleanup can remove only managed paper-cache files; it cannot delete preferences or bookmarks.

## Build and install

Requires macOS 12 or later, Node.js 22 or later, and Xcode Command Line Tools (`xcode-select --install`). No Rust toolchain or Electron runtime is needed. The native shell uses AppKit and WebKit; the interface uses TypeScript and Vite.

```sh
npm ci
npm run install:macos
```

This compiles the frontend and native executable, draws a minimal icon, signs the bundle locally, installs `/Applications/arxiv.app`, and opens it. The build targets the Mac's current CPU architecture. Local ad-hoc signing is for use on your own Mac; distribution to other Macs would require appropriate signing and notarization.

The source lives at `/Applications/arxiv`. The installed app is `/Applications/arxiv.app`. Installation replaces the app in place, verifies the signature, and removes the staging app. Rebuilding preserves all user data. The install script asks the running app to quit normally and waits for pending saves; it does not force-quit it.

To build a staging bundle without installing:

```sh
npm run bundle
```

The resulting bundle is `build/arxiv.app`. Launch only the installed copy when working on this project.

## Local data

The installed app stores data under:

```text
~/Library/Application Support/arxiv-reader/
  state.json                 # categories, theme, and bookmarks
  day-v2-cs.LG-YYYY-MM-DD.json    # titles, authors, and full abstracts
  day-v2-stat.ML-YYYY-MM-DD.json
```

Writes are atomic. Failed preference/bookmark saves show a retry notice. Quit waits for the save queue and offers to keep the app open if saving failed. Daily cache writes must succeed before their snapshots count as cached. The two default sections need at most 20 weekday snapshot files across the rolling window. The legacy `feed-*` and `abstract-*` files are removed during migration. There are no accounts, telemetry, or cloud synchronization.

## Development and checks

```sh
npm run dev            # browser preview at http://127.0.0.1:1421
npm run build          # strict TypeScript check + production build
npx playwright install chromium webkit
npm test               # Chromium + WebKit integration tests
```

The browser preview uses Vite's local arXiv proxy and IndexedDB storage; native networking, request spacing, native menus, and disk storage belong to the installed app. Browser and native preferences are separate.

Tests use deterministic arXiv-shaped fixtures and cover complete abstract preloading, current/previous week selection, offline expansion without extra requests, bookmarks saved before expansion, migration, exact two-week eviction, year boundaries, Monday rollover, in-flight request races, pagination, missing abstracts, malformed dates, search, settings, and escaping imported text. Normal tests do not call arXiv.

For a live installed-app smoke test, quit the app, then run:

```sh
open /Applications/arxiv.app --args --smoke-test
```

This selects the latest eligible weekday in the current week, loads live cs.LG papers, and opens the first abstract. It reads but does not modify bookmarks or preferences. The result is written to the system temporary directory as `arxiv-smoke-test.txt`. The smoke test needs network access and a published listing in the current week.

Keyboard shortcuts: `⌘F` search, `⌘B` sidebar, `⌘R` refresh, `⌘,` settings, `F1` help, and `Esc` to clear search or close a dialog. Standard Tab, Shift+Tab, Enter, and Space navigation is available.

## Source layout

- `src/main.ts` — reader interface and state
- `src/source.ts` — complete daily snapshots, two-week retention, pagination, and bookmark fallback
- `src/platform.ts` — native messaging and browser fallback
- `src/dates.ts` — calendar-week and announcement-date handling
- `src/style.css` — minimal dark/light styles
- `native/App.swift` — AppKit window, WebKit, restricted networking, atomic storage, and native menus
- `scripts/` — macOS build, icon, and installation
- `tests/` — integration tests and fixtures

This is an independent personal reader and is not affiliated with arXiv. Paper titles, authors, and abstracts belong to their respective authors. See the official [arXiv RSS help](https://info.arxiv.org/help/rss.html) and [API documentation](https://info.arxiv.org/help/api/user-manual.html) for arXiv's access guidance.
