variable "aws_region" {
  description = "AWS region for deployment."
  type        = string
}

variable "project_name" {
  description = "Project name used for resource naming."
  type        = string
  default     = "headsup"
}

variable "environment" {
  description = "Environment name."
  type        = string
  default     = "dev"
}

variable "allowed_origin" {
  description = "Allowed CORS origin (GitHub Pages origin)."
  type        = string
}

variable "log_retention_days" {
  description = "CloudWatch log retention period in days."
  type        = number
  default     = 7
}

variable "monthly_budget_usd" {
  description = "Monthly AWS cost budget in USD."
  type        = number
  default     = 5
}

variable "budget_alert_email" {
  description = "Email to receive budget notifications. Leave empty to disable notifications."
  type        = string
  default     = ""
}

variable "max_lists_per_user" {
  description = "Maximum number of lists a user can own."
  type        = number
  default     = 30
}

variable "max_words_per_list" {
  description = "Maximum words allowed per list."
  type        = number
  default     = 1000
}

variable "max_total_words_per_user" {
  description = "Maximum total words a user can own across all lists."
  type        = number
  default     = 12000
}

variable "max_updates_per_list_per_day" {
  description = "Maximum updates per list per day."
  type        = number
  default     = 40
}

variable "max_write_ops_per_user_per_day" {
  description = "Maximum write operations per user per day."
  type        = number
  default     = 200
}

variable "max_global_lists" {
  description = "Maximum total lists across all users."
  type        = number
  default     = 500
}

variable "max_global_words" {
  description = "Maximum total words across all lists."
  type        = number
  default     = 150000
}

variable "max_versions_per_list" {
  description = "Maximum number of stored versions per list."
  type        = number
  default     = 10
}
