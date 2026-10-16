terraform {
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare" }
  }
}
resource "cloudflare_r2_bucket" "synthetic_assets" {
  name = "synthetic-bucket-value-never-export"
}
