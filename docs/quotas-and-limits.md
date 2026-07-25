# Quotas and Limits (MVP)

Conservative defaults to protect free tier usage.

## Per-user

- Max owned lists: `30`
- Max words per list: `1000`
- Max total words across owned lists: `12000`
- Max updates per list per day: `40`
- Max total write ops/day: `200`

## Global

- Max total lists: `500`
- Max total words: `150000`
- Max list-version bytes estimate: `150 MB`
- Max new versions/day: `400`

## Enforcement plan

- Store counters in `usage_counters`
- Reject over-limit writes with `QUOTA_*` codes
- Use conditional/transactional writes for race-safe increments

