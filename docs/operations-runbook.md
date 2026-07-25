# Operations Runbook

## 1) Bootstrap remote Terraform state

```powershell
Set-Location terraform\bootstrap
terraform init
terraform apply -var="aws_region=eu-west-2" -var="state_bucket_name=<globally-unique-bucket>" -var="lock_table_name=headsup-terraform-locks"
```

## 2) Initialize dev environment with backend

```powershell
Set-Location ..\envs\dev
terraform init `
  -backend-config="bucket=<globally-unique-bucket>" `
  -backend-config="key=headsup/dev/terraform.tfstate" `
  -backend-config="region=eu-west-2" `
  -backend-config="dynamodb_table=headsup-terraform-locks" `
  -backend-config="encrypt=true"
```

## 3) Local checks

```powershell
terraform fmt -recursive
terraform validate
terraform plan -var-file="terraform.tfvars"
```

## 4) CI/CD workflows

- `terraform-validate.yml`: fmt + validate
- `terraform-plan.yml`: PR plan (no backend)
- `terraform-apply.yml`: manual apply using OIDC role (`AWS_ROLE_ARN`)

## 5) Post-deploy smoke test

Call:

`GET <api_endpoint>/health`

Expected:

```json
{"status":"ok"}
```

