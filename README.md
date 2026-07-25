# Head Sup Turbo Extreme 9000

Terraform infrastructure and React frontend for the Heads Up MVP.

## What exists now

- Terraform bootstrap stack for remote state:
  - S3 bucket (state storage)
  - DynamoDB table (state locking)
- Terraform dev environment scaffold (ready for infra resources)
- Core dev infra resources:
  - HTTP API Gateway v2 with CORS
  - Health Lambda (`GET /health`)
  - API Lambda for list/favorite routes with ownership + version conflict checks
  - DynamoDB tables (`users`, `lists`, `list_versions`, `favorites`, `usage_counters`)
  - CloudWatch log groups with 7-day retention
  - AWS monthly budget resource (+ optional email notifications)
- Frontend app (`frontend/`):
  - React + TypeScript + Vite
  - API-connected list UI (create/list/update/delete/favorites)
- GitHub Actions workflows for:
  - Frontend + Terraform linting
  - Terraform plan on PR
  - Manual Terraform apply (OIDC)
  - Frontend deploy to GitHub Pages

## Bootstrap remote Terraform state

Run once from your machine:

```powershell
Set-Location terraform\bootstrap
terraform init
terraform apply -var="aws_region=eu-west-2" -var="state_bucket_name=<globally-unique-bucket>" -var="lock_table_name=headsup-terraform-locks"
```

Then configure the dev backend (replace placeholders):

```powershell
Set-Location ..\envs\dev
terraform init `
  -backend-config="bucket=<globally-unique-bucket>" `
  -backend-config="key=headsup/dev/terraform.tfstate" `
  -backend-config="region=eu-west-2" `
  -backend-config="dynamodb_table=headsup-terraform-locks" `
  -backend-config="encrypt=true"
```

## Local dev commands

```powershell
terraform fmt -recursive
Set-Location terraform\envs\dev
terraform init -backend=false
terraform validate
terraform plan -refresh=false -var="aws_region=eu-west-2" -var="allowed_origin=https://<github-username>.github.io"
```

```powershell
Set-Location frontend
Copy-Item .env.example .env
pnpm install
pnpm dev
```

## Linting

```powershell
Set-Location frontend
pnpm lint
```

```powershell
terraform fmt -check -recursive terraform
Set-Location terraform\bootstrap
terraform init -backend=false
terraform validate
Set-Location ..\envs\dev
terraform init -backend=false
terraform validate
```

## GitHub Actions setup

Set this repository secret before running apply workflow:

- `AWS_ROLE_ARN` (OIDC-assumable role for Terraform apply)

Set this repository variable for better PR plans:

- `ALLOWED_ORIGIN` (for example `https://<github-username>.github.io`)
- `VITE_API_BASE_URL` (API base URL used by frontend deploy workflow)

For frontend publishing, enable GitHub Pages in repository settings and choose **GitHub Actions** as source.
