# arxiv

A minimal macOS reader for daily arXiv papers, styled after [text](https://github.com/YazidJanati/text): a narrow sidebar, monospace type, quiet colors, and a plain reading pane.

## Reading

- Open a weekday in the left sidebar, then select **cs.LG** or **stat.ML**.
- Read paper titles and authors. Click a title to expand or collapse its abstract.
- Use the bookmark beside a paper to save it. **Bookmarks** collects saved papers across days and sections.
- Search the current section or your bookmarks by title and author name. Search ignores case and accents.
- Use **+** or **Settings** to add more arXiv category codes, such as `cs.AI`, `cs.CL`, `cs.CV`, `math.OC`, or `quant-ph`. Remove sections in Settings; at least one section remains.
- Choose **Dark**, **Light**, or **System** appearance in Settings.
- The arXiv and PDF controls beneath an abstract open the original paper in your default browser.

The sidebar shows Monday through Sunday of the current local calendar week. Daily lists use **arXiv's announcement/listing dates**, not the paper's initial submission timestamp. Weekends, future dates, and days without announcements display an empty state. The week rolls over automatically. Historical week browsing and global arXiv search are outside this version's scope.

Lists come directly from arXiv's public category `recent` pages, including cross-listed papers. All pages needed for the current week are loaded, including categories with more than 2,000 entries. Abstracts load from each paper's arXiv abstract page when expanded. Data never passes through a third-party proxy.

The native app serializes arXiv requests with at least three seconds between request starts, caches listings for 30 minutes, and offers manual refresh. Cached listings remain available when arXiv or the connection fails. Cached abstracts are readable offline after you have opened them. Bookmarked titles and authors persist even if their original listing is no longer current; abstracts that have been opened are saved with the bookmark.

arXiv's HTML is parsed as text in an inert document. Paper metadata is escaped before display. The native bridge restricts network requests to category listings and paper abstracts on `https://arxiv.org`. A changed arXiv page format produces a visible error instead of a silently empty paper list.

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
  feed-cs.LG.json             # dated category metadata
  feed-stat.ML.json
  abstract-<arxiv-id>.json    # abstracts opened while reading
```

Writes are atomic. Failed preference/bookmark saves show a retry notice. Quit waits for the save queue and offers to keep the app open if saving failed. Cache failures do not prevent online reading. Category caches retain up to six weeks of metadata; saved papers are stored separately. Removing a sidebar section does not remove its bookmarks. There are no accounts, telemetry, or cloud synchronization.

## Development and checks

```sh
npm run dev            # browser preview at http://127.0.0.1:1421
npm run build          # strict TypeScript check + production build
npx playwright install chromium webkit
npm test               # Chromium + WebKit integration tests
```

The browser preview uses Vite's local arXiv proxy and IndexedDB storage; native networking, request spacing, native menus, and disk storage belong to the installed app. Browser and native preferences are separate.

Tests use deterministic arXiv-shaped fixtures and cover daily date grouping, title/author search, abstract toggles, persistent offline bookmarks, appearance and category settings, weekends/future days, pagination, stale-request races, offline cache fallback, malformed responses, and escaping imported text. Normal tests do not call arXiv.

For a live installed-app smoke test, quit the app, then run:

```sh
open /Applications/arxiv.app --args --smoke-test
```

This selects the latest eligible weekday in the current week, loads live cs.LG papers, and opens the first abstract. It reads but does not modify bookmarks or preferences. The result is written to the system temporary directory as `arxiv-smoke-test.txt`. The smoke test needs network access and a published listing in the current week.

Keyboard shortcuts: `⌘F` search, `⌘B` sidebar, `⌘R` refresh, `⌘,` settings, `F1` help, and `Esc` to clear search or close a dialog. Standard Tab, Shift+Tab, Enter, and Space navigation is available.

## Source layout

- `src/main.ts` — reader interface and state
- `src/source.ts` — dated listing parser, pagination, and abstract loading
- `src/platform.ts` — native messaging and browser fallback
- `src/dates.ts` — calendar-week and announcement-date handling
- `src/style.css` — minimal dark/light styles
- `native/App.swift` — AppKit window, WebKit, restricted networking, atomic storage, and native menus
- `scripts/` — macOS build, icon, and installation
- `tests/` — integration tests and fixtures

This is an independent personal reader and is not affiliated with arXiv. Paper titles, authors, and abstracts belong to their respective authors. See the official [arXiv RSS help](https://info.arxiv.org/help/rss.html) and [API documentation](https://info.arxiv.org/help/api/user-manual.html) for arXiv's access guidance.
