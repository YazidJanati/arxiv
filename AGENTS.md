# Working on arxiv

- Source repository: `/Applications/arxiv`. Installed app: `/Applications/arxiv.app`.
- Match the minimal visual style of `/Applications/text`: monospace, narrow sidebar, quiet colors, plain paper rows.
- Keep one permanent installed copy. Build to `build/arxiv.app` only as staging, install in place, verify its signature, and remove staging after installation. Never launch staging.
- Preserve bookmarks and preferences under `~/Library/Application Support/arxiv-reader/`. Quit the installed app normally before replacing it; never force-quit or discard pending saves.
- Daily lists must use arXiv's actual announcement dates. Do not approximate dates from submission timestamps or invent papers for unavailable days.
- Cache complete abstracts with their exact daily listings. Keep only current and previous calendar weeks of disposable day snapshots; preserve bookmarks separately. Cleanup may delete only managed cache files.
- Search titles and authors across every subscribed section in the retained two-week window, regardless of the selected day. Deduplicate cross-lists and exclude older bookmarks from search results.
- Escape remote metadata, keep networking restricted to arXiv, preserve pagination, cache fallback, and serialized request spacing.
- Run `npm run build` and `npm test` after behavioral changes. For native changes run `npm run bundle`, install, and inspect the installed app.
- Do not commit generated builds, local data, caches, or test output.
