terraform {
  required_version = ">= 1.8.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }

  # Configure with -backend-config flags during terraform init.
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
      Repository  = "SillieOrg/head-sup-turbo-extreme-9000"
    }
  }
}

locals {
  name_prefix = "${var.project_name}-${var.environment}"

  dynamodb_tables = {
    users = {
      hash_key  = "userId"
      range_key = null
    }
    lists = {
      hash_key  = "listId"
      range_key = null
    }
    list_versions = {
      hash_key  = "listId"
      range_key = "version"
    }
    favorites = {
      hash_key  = "userId"
      range_key = "listId"
    }
    usage_counters = {
      hash_key  = "scope"
      range_key = null
    }
  }
}

resource "aws_cloudwatch_log_group" "lambda_health" {
  name              = "/aws/lambda/${local.name_prefix}-health"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "lambda_api" {
  name              = "/aws/lambda/${local.name_prefix}-api"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "api_access" {
  name              = "/aws/apigateway/${local.name_prefix}-http-api"
  retention_in_days = var.log_retention_days
}

data "archive_file" "health_lambda_zip" {
  type        = "zip"
  output_path = "${path.module}/health.zip"

  source {
    filename = "index.mjs"
    content  = <<-EOT
      export const handler = async () => {
        return {
          statusCode: 200,
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ status: "ok" })
        };
      };
    EOT
  }
}

data "archive_file" "api_lambda_zip" {
  type        = "zip"
  source_dir  = "${path.module}/lambda_api"
  output_path = "${path.module}/api.zip"
}

resource "aws_iam_role" "lambda_health" {
  name = "${local.name_prefix}-lambda-health-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_health_basic_execution" {
  role       = aws_iam_role.lambda_health.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role" "lambda_api" {
  name = "${local.name_prefix}-lambda-api-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_api_basic_execution" {
  role       = aws_iam_role.lambda_api.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "lambda_api_dynamodb_access" {
  name = "${local.name_prefix}-lambda-api-dynamodb"
  role = aws_iam_role.lambda_api.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Scan",
        "dynamodb:Query"
      ]
      Resource = [
        aws_dynamodb_table.tables["lists"].arn,
        aws_dynamodb_table.tables["list_versions"].arn,
        aws_dynamodb_table.tables["favorites"].arn,
        aws_dynamodb_table.tables["usage_counters"].arn
      ]
    }]
  })
}

resource "aws_lambda_function" "health" {
  function_name = "${local.name_prefix}-health"
  role          = aws_iam_role.lambda_health.arn
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  filename      = data.archive_file.health_lambda_zip.output_path
  source_code_hash = data.archive_file.health_lambda_zip.output_base64sha256
}

resource "aws_lambda_function" "api" {
  function_name = "${local.name_prefix}-api"
  role          = aws_iam_role.lambda_api.arn
  runtime       = "python3.12"
  handler       = "app.handler"
  filename      = data.archive_file.api_lambda_zip.output_path
  source_code_hash = data.archive_file.api_lambda_zip.output_base64sha256
  timeout       = 10

  environment {
    variables = {
      LISTS_TABLE                  = aws_dynamodb_table.tables["lists"].name
      LIST_VERSIONS_TABLE          = aws_dynamodb_table.tables["list_versions"].name
      FAVORITES_TABLE              = aws_dynamodb_table.tables["favorites"].name
      USAGE_TABLE                  = aws_dynamodb_table.tables["usage_counters"].name
      MAX_LISTS_PER_USER           = tostring(var.max_lists_per_user)
      MAX_WORDS_PER_LIST           = tostring(var.max_words_per_list)
      MAX_TOTAL_WORDS_PER_USER     = tostring(var.max_total_words_per_user)
      MAX_UPDATES_PER_LIST_PER_DAY = tostring(var.max_updates_per_list_per_day)
      MAX_WRITE_OPS_PER_USER_PER_DAY = tostring(var.max_write_ops_per_user_per_day)
      MAX_GLOBAL_LISTS             = tostring(var.max_global_lists)
      MAX_GLOBAL_WORDS             = tostring(var.max_global_words)
      MAX_VERSIONS_PER_LIST        = tostring(var.max_versions_per_list)
    }
  }
}

resource "aws_apigatewayv2_api" "http" {
  name          = "${local.name_prefix}-http-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = [var.allowed_origin]
    allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_headers = ["Content-Type", "Authorization"]
    max_age       = 3600
  }
}

resource "aws_apigatewayv2_integration" "health_lambda" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.health.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "api_lambda" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "health" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "GET /health"
  target    = "integrations/${aws_apigatewayv2_integration.health_lambda.id}"
}

resource "aws_apigatewayv2_route" "lists_create" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "POST /lists"
  target    = "integrations/${aws_apigatewayv2_integration.api_lambda.id}"
}

resource "aws_apigatewayv2_route" "lists_get_all" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "GET /lists"
  target    = "integrations/${aws_apigatewayv2_integration.api_lambda.id}"
}

resource "aws_apigatewayv2_route" "lists_get_one" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "GET /lists/{listId}"
  target    = "integrations/${aws_apigatewayv2_integration.api_lambda.id}"
}

resource "aws_apigatewayv2_route" "lists_update" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "PUT /lists/{listId}"
  target    = "integrations/${aws_apigatewayv2_integration.api_lambda.id}"
}

resource "aws_apigatewayv2_route" "lists_delete" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "DELETE /lists/{listId}"
  target    = "integrations/${aws_apigatewayv2_integration.api_lambda.id}"
}

resource "aws_apigatewayv2_route" "favorites_add" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "POST /favorites/{listId}"
  target    = "integrations/${aws_apigatewayv2_integration.api_lambda.id}"
}

resource "aws_apigatewayv2_route" "favorites_remove" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "DELETE /favorites/{listId}"
  target    = "integrations/${aws_apigatewayv2_integration.api_lambda.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      requestTime    = "$context.requestTime"
      httpMethod     = "$context.httpMethod"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      protocol       = "$context.protocol"
      responseLength = "$context.responseLength"
    })
  }
}

resource "aws_lambda_permission" "allow_api_gateway_health" {
  statement_id  = "AllowExecutionFromAPIGatewayHealth"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.health.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_lambda_permission" "allow_api_gateway_api" {
  statement_id  = "AllowExecutionFromAPIGatewayApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_dynamodb_table" "tables" {
  for_each = local.dynamodb_tables

  name         = "${local.name_prefix}-${replace(each.key, "_", "-")}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = each.value.hash_key
  range_key    = each.value.range_key

  attribute {
    name = each.value.hash_key
    type = "S"
  }

  dynamic "attribute" {
    for_each = each.value.range_key == null ? [] : [each.value.range_key]

    content {
      name = attribute.value
      type = "S"
    }
  }
}

resource "aws_budgets_budget" "monthly_cost" {
  name         = "${local.name_prefix}-monthly-cost"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = var.budget_alert_email == "" ? [] : [80, 100]

    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [var.budget_alert_email]
    }
  }
}
