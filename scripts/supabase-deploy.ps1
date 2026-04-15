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
$midtransClientKey = [Environment]::GetEnvironmentVariable("MIDTRANS_CLIENT_KEY")
$midtransServerKey = Require-EnvVar "MIDTRANS_SERVER_KEY"
$midtransIsProduction = [Environment]::GetEnvironmentVariable("MIDTRANS_IS_PRODUCTION")
if ([string]::IsNullOrWhiteSpace($midtransIsProduction)) {
  $midtransIsProduction = "false"
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
if ([string]::IsNullOrWhiteSpace($midtransClientKey)) {
  Run-Checked "supabase secrets set" { npx supabase secrets set --project-ref $projectRef MIDTRANS_SERVER_KEY=$midtransServerKey MIDTRANS_IS_PRODUCTION=$midtransIsProduction }
} else {
  Run-Checked "supabase secrets set" { npx supabase secrets set --project-ref $projectRef MIDTRANS_CLIENT_KEY=$midtransClientKey MIDTRANS_SERVER_KEY=$midtransServerKey MIDTRANS_IS_PRODUCTION=$midtransIsProduction }
}

Write-Host "[5/6] Deploy function midtrans-webhook..."
Run-Checked "supabase functions deploy" { npx supabase functions deploy midtrans-webhook --project-ref $projectRef }

Write-Host "[6/6] Deploy function subscription-api..."
Run-Checked "supabase functions deploy" { npx supabase functions deploy subscription-api --project-ref $projectRef }

Write-Host "Deploy completed successfully."
