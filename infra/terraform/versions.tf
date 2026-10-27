terraform {
  required_version = ">= 1.6.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.0"
    }
  }

  # State LOCAL, fora do repositório (e do OneDrive). O caminho é injetado pelo bootstrap
  # com -backend-config="path=..." (padrão: ~/.roboflow-infra/terraform.tfstate).
  backend "local" {}
}

provider "google" {
  project = var.project_id
  region  = var.region

  # Budgets e algumas APIs exigem projeto de cota explícito com credencial de usuário (ADC).
  user_project_override = true
  billing_project       = var.project_id
}

provider "google-beta" {
  project = var.project_id
  region  = var.region

  user_project_override = true
  billing_project       = var.project_id
}
