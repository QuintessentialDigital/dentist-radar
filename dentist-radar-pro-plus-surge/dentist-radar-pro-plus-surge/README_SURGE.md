# Surge Mode Notes

This build adds:
- **Deduped fetches**: Practice pages are cached for `PRACTICE_CACHE_TTL_MS` (default 10 minutes). If multiple watches need the same page, it's fetched once and shared.
- **Per-host rate limiting**: Concurrency and delay per host via `MAX_CONCURRENT_FETCHES` and `PER_HOST_DELAY_MS`.
- **Scheduler toggle**: `SCHEDULER_ENABLED=true|false` — run exactly one scheduler (set false on Web, true on Worker if you split services).
- **/health** endpoint: Returns JSON metrics; protect with `HEALTH_TOKEN`.
