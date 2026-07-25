# Architecture (MVP)

## Hosting split

- Frontend: GitHub Pages (React PWA)
- Backend: AWS HTTP API + Lambda + DynamoDB

## Deployed in Terraform `envs/dev`

- API Gateway HTTP API (`$default` stage, CORS enabled)
- Lambda health function (`GET /health`)
- DynamoDB tables:
  - `users`
  - `lists`
  - `list_versions`
  - `favorites`
  - `usage_counters`
- CloudWatch log groups with 7-day retention
- Monthly AWS budget resource with optional email alerts

## Notes

- Admin API and telemetry are intentionally deferred.
- Terraform state is intended to run from S3 + DynamoDB lock after bootstrap.

