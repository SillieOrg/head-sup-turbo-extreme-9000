output "api_endpoint" {
  description = "HTTP API invoke URL."
  value       = aws_apigatewayv2_api.http.api_endpoint
}

output "health_lambda_name" {
  description = "Health Lambda function name."
  value       = aws_lambda_function.health.function_name
}

output "dynamodb_table_names" {
  description = "Created DynamoDB table names."
  value       = { for key, table in aws_dynamodb_table.tables : key => table.name }
}

