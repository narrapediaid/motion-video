param(
  [switch]$DeployFunctionOnly
)

$ErrorActionPreference = "Stop"

function Run-Checked {
  param(
    [string]$Label,
    [scriptblock]$Command
  )

  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE"
  }
}

function Require-EnvVar {
  param([string]$Name)

  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Missing required environment variable: $Name"
  }

  if ($value -match "^replace_with" -or $value -match "^your_") {
    throw "Environment variable $Name still contains placeholder value."
  }

  return $value
}

$projectRef = Require-EnvVar "SUPABASE_PROJECT_REF"
$accessToken = Require-EnvVar "SUPABASE_ACCESS_TOKEN"
$dbPassword = Require-EnvVar "SUPABASE_DB_PASSWORD"
$sakurupiahApiId = Require-EnvVar "SAKURUPIAH_API_ID"
$sakurupiahApiKey = Require-EnvVar "SAKURUPIAH_API_KEY"
$sakurupiahCallbackUrl = Require-EnvVar "SAKURUPIAH_CALLBACK_URL"
$sakurupiahIsProduction = [Environment]::GetEnvironmentVariable("SAKURUPIAH_IS_PRODUCTION")
$sakurupiahMerchantFee = [Environment]::GetEnvironmentVariable("SAKURUPIAH_MERCHANT_FEE")
$sakurupiahDefaultExpiredHours = [Environment]::GetEnvironmentVariable("SAKURUPIAH_DEFAULT_EXPIRED_HOURS")
if ([string]::IsNullOrWhiteSpace($sakurupiahIsProduction)) {
  $sakurupiahIsProduction = "false"
}
if ([string]::IsNullOrWhiteSpace($sakurupiahMerchantFee)) {
  $sakurupiahMerchantFee = "1"
}
if ([string]::IsNullOrWhiteSpace($sakurupiahDefaultExpiredHours)) {
  $sakurupiahDefaultExpiredHours = "24"
}

Write-Host "[1/6] Login Supabase CLI with PAT..."
Run-Checked "supabase login" { npx supabase login --token $accessToken }

Write-Host "[2/6] Link project $projectRef ..."
Run-Checked "supabase link" { npx supabase link --project-ref $projectRef --password $dbPassword }

if (-not $DeployFunctionOnly) {
  Write-Host "[3/6] Push database migrations..."
  Run-Checked "supabase db push" { npx supabase db push --linked }
} else {
  Write-Host "[3/6] Skip db push (DeployFunctionOnly enabled)."
}

Write-Host "[4/6] Set function secrets..."
Run-Checked "supabase secrets set" { npx supabase secrets set --project-ref $projectRef SAKURUPIAH_API_ID=$sakurupiahApiId SAKURUPIAH_API_KEY=$sakurupiahApiKey SAKURUPIAH_CALLBACK_URL=$sakurupiahCallbackUrl SAKURUPIAH_IS_PRODUCTION=$sakurupiahIsProduction SAKURUPIAH_MERCHANT_FEE=$sakurupiahMerchantFee SAKURUPIAH_DEFAULT_EXPIRED_HOURS=$sakurupiahDefaultExpiredHours }

Write-Host "[5/6] Skip legacy standalone webhook deploy (subscription-api handles Sakurupiah callback)."

Write-Host "[6/6] Deploy function subscription-api..."
Run-Checked "supabase functions deploy" { npx supabase functions deploy subscription-api --project-ref $projectRef }

Write-Host "Deploy completed successfully."
