# Head Sup Turbo Extreme 9000 — Terraform & Delivery Plan

## 1) Objective
Build and operate a **friends-only Heads Up web app (React PWA)** with an **AWS free-tier-conscious backend** and infrastructure managed in this repository via Terraform.

- Frontend hosting: GitHub Pages (free)
- Backend hosting: AWS (API + persistence)
- IaC source of truth: this repo (`SillieOrg/head-sup-turbo-extreme-9000`)
- Secrets: GitHub Actions repository secrets

## 2) Scope (MVP)
### In-scope
- AWS infrastructure with Terraform for:
  - API layer (HTTP API)
  - Compute (Lambda)
  - Data store (DynamoDB)
  - Minimal observability/log retention
  - Budget alarm(s)
- Auth-lite model:
  - Shared global app password gate
  - Username + device UUID association
- Lists:
  - Create/read/update with ownership checks
  - Favorites
  - Search/filter by title and owner
  - Sort by date
  - Offline-capable client sync model support
- Quotas/guardrails:
  - Per-user and global limits
  - Write throttling patterns
- Admin/management endpoints for moderation/list maintenance

### Out-of-scope (initially)
- Full user account system/social login
- Complex moderation workflows
- Multi-mode gameplay beyond classic
- Native mobile app (React Native)

## 3) High-Level Architecture
- **GitHub Pages** serves React PWA static assets.
- React app calls **AWS API Gateway HTTP API** over HTTPS.
- API routes invoke **Lambda** handlers.
- Persistence in **DynamoDB** (lists, versions, favorites, usage counters).
- Optional telemetry events written to DynamoDB with strict caps.
- CloudWatch logs with short retention (3–7 days).
- AWS Budgets alert for early cost detection.

## 4) Cost & Free-Tier Risk Controls (Critical)
Primary cost risks:
1. CloudWatch log growth
2. Excess DynamoDB writes from autosync
3. API request volume (including CORS preflights)
4. Large item sizes / unbounded version history

Required guardrails:
- Debounced autosync (3–5s)
- Save only on checksum changes
- Hard quotas (user + global)
- Version retention cap (e.g., last 10 versions/list)
- CloudWatch retention set explicitly
- Budget alarm configured
- Conservative telemetry volume

## 5) Proposed Data Model (DynamoDB)
- `users`
  - `userId`, `username`, `deviceIds`, `createdAt`, `lastSeenAt`
- `lists`
  - `listId`, `ownerUserId`, `title`, `createdAt`, `updatedAt`, `currentVersion`, `checksum`, `wordCount`
- `list_versions`
  - `listId`, `version`, `words`, `checksum`, `updatedBy`, `updatedAt`
- `favorites`
  - `userId`, `listId`, `addedAt`
- `usage_counters`
  - `scope` (USER#/GLOBAL), `listsCount`, `wordsCount`, `bytesEstimate`, daily write counters

## 6) Quota Policy (Initial)
### Per-user
- Max owned lists: 30
- Max words per list: 1000
- Max total words owned: 12000
- Max list updates per day: 40 per list
- Max write ops/day: 200

### Global
- Max total lists: 500
- Max total words: 150000
- Max stored list-version bytes estimate: 150 MB
- Max new versions/day: 400

> These are intentionally conservative for free-tier protection and can be tuned after usage observations.

## 7) Milestones

## Milestone 0 — Repository & Terraform Foundation
**Goal:** Prepare repo structure, state strategy, and CI basics.

Deliverables:
- Terraform folder layout (`envs/`, `modules/`)
- Terraform version/provider constraints
- Remote state strategy documented (or local for bootstrap with migration plan)
- GitHub Actions workflow skeleton for `fmt`, `validate`, `plan`
- README setup instructions

Exit criteria:
- `terraform fmt` and `terraform validate` pass in CI
- Basic plan runs with placeholder variables

## Milestone 1 — Core AWS Infrastructure (Minimal)
**Goal:** Deploy minimal free-tier-conscious backend skeleton.

Deliverables:
- HTTP API (API Gateway v2)
- Lambda execution role + one health Lambda
- DynamoDB tables (users, lists, list_versions, favorites, usage_counters)
- CloudWatch log groups with short retention
- CORS configuration allowing GitHub Pages origin

Exit criteria:
- `GET /health` works from deployed API URL
- CORS preflight succeeds from GitHub Pages origin

## Milestone 2 — Security, Secrets, and Budget Guardrails
**Goal:** Add baseline safety and secrets wiring.

Deliverables:
- GitHub secrets contract documented (`AWS_ROLE_ARN` or keys, app password secret, etc.)
- OIDC-based deploy auth preferred (avoid long-lived AWS keys)
- AWS Budget alert (e.g., $1 and $5 thresholds)
- IAM least-privilege pass for Lambda/API/Terraform deploy role

Exit criteria:
- Deploy workflow can assume role and apply
- Budget alerts active

## Milestone 3 — List APIs + Ownership + Quotas
**Goal:** Implement core CRUD with hard limits.

Deliverables:
- Endpoints: create/get/update/list/favorite
- Ownership enforcement (only owner updates)
- Conditional writes for version/checksum sync
- Quota enforcement logic (per-user + global)
- Consistent error contract (`QUOTA_*`, `CONFLICT_*`, `AUTH_*`)

Exit criteria:
- API integration tests for create/update/conflict/quota pass

## Milestone 4 — Versioning & Conflict Handling
**Goal:** Add safe sync behavior with minimal UX complexity.

Deliverables:
- `baseVersion` update contract
- Conflict response with latest server metadata
- Version retention cap (last N)
- Optional daily snapshot thinning job

Exit criteria:
- Concurrent edit simulation behaves predictably
- No unbounded version growth

## Milestone 5 — Admin Management API
**Goal:** Provide lightweight moderation/control tools.

Deliverables:
- Admin-authenticated endpoints (shared admin secret)
- List hide/unhide or soft-delete
- Optional owner transfer endpoint
- Audit fields for admin actions

Exit criteria:
- Admin actions logged and access-controlled

## Milestone 6 — Observability & Cost Controls Hardening
**Goal:** Ensure operational visibility without runaway cost.

Deliverables:
- Structured error logging only
- Log retention + sampling strategy
- Basic dashboard/alarm(s): 4xx/5xx, Lambda errors, throttle counts
- Daily quota/cost posture report (optional scheduled Lambda)

Exit criteria:
- Alerts fire in test
- Costs remain within free-tier expectations in soak test

## Milestone 7 — Frontend Integration Readiness
**Goal:** Make backend ready for React PWA consumption.

Deliverables:
- OpenAPI or endpoint contract doc
- CORS verified end-to-end
- Example client env vars and request flows
- Offline sync behavior contract (checksum/version)

Exit criteria:
- Frontend can integrate without backend changes

## 8) Repository Structure (Target)
```text
.
├─ README.md
├─ docs/
│  ├─ architecture.md
│  ├─ api-contract.md
│  ├─ quotas-and-limits.md
│  └─ operations-runbook.md
├─ terraform/
│  ├─ modules/
│  │  ├─ api/
│  │  ├─ lambda/
│  │  ├─ dynamodb/
│  │  ├─ monitoring/
│  │  └─ budget/
│  └─ envs/
│     ├─ dev/
│     └─ prod/
└─ .github/
   └─ workflows/
      ├─ terraform-validate.yml
      └─ terraform-plan-apply.yml
```

## 9) GitHub Secrets Plan
Minimum expected secrets/variables:
- `AWS_ROLE_ARN` (preferred with OIDC)
- `AWS_REGION`
- `TF_VAR_project_name`
- `TF_VAR_environment`
- `TF_VAR_allowed_origin` (GitHub Pages origin)
- `TF_VAR_app_shared_password_hash`
- `TF_VAR_admin_shared_secret_hash`

Notes:
- Prefer hashed secrets for app/admin shared values.
- Avoid storing plaintext secrets in Terraform state.

## 10) Open Decisions
1. Single AWS account vs separate dev/prod accounts?
2. Remote Terraform state backend (S3 + DynamoDB lock) bootstrap sequence.
3. Whether to include telemetry table from day 1 or defer.
4. Final admin API capabilities for moderation.

## 11) Definition of Done (MVP Infra)
- Reproducible Terraform apply from CI
- Free-tier guardrails active (budgets, quotas, retention)
- Core data plane and auth-lite controls deployed
- API contract documented for frontend team

## 12) Immediate Next Steps
1. Create Terraform baseline folders and provider config.
2. Add CI workflow for fmt/validate/plan.
3. Stand up Milestone 1 minimal stack in a dev environment.
4. Validate CORS from GitHub Pages origin.
5. Implement list CRUD with ownership + quotas.
