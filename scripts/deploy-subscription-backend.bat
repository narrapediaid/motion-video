@echo off
REM Deploy Supabase Edge Function subscription-api beserta secrets

REM === REQUIRED ENVIRONMENT VARIABLES (set these in shell before running) ===
REM SUPABASE_PROJECT_REF
REM SUPABASE_ACCESS_TOKEN
REM SUPABASE_DB_PASSWORD
REM SAKURUPIAH_API_ID
REM SAKURUPIAH_API_KEY
REM SAKURUPIAH_CALLBACK_URL
REM Optional:
REM SAKURUPIAH_IS_PRODUCTION (default false)
REM SAKURUPIAH_MERCHANT_FEE (default 1)
REM SAKURUPIAH_DEFAULT_EXPIRED_HOURS (default 24)

if "%SUPABASE_PROJECT_REF%"=="" (
  echo Missing SUPABASE_PROJECT_REF
  goto :fail
)
if "%SUPABASE_ACCESS_TOKEN%"=="" (
  echo Missing SUPABASE_ACCESS_TOKEN
  goto :fail
)
if "%SUPABASE_DB_PASSWORD%"=="" (
  echo Missing SUPABASE_DB_PASSWORD
  goto :fail
)
if "%SAKURUPIAH_API_ID%"=="" (
  echo Missing SAKURUPIAH_API_ID
  goto :fail
)
if "%SAKURUPIAH_API_KEY%"=="" (
  echo Missing SAKURUPIAH_API_KEY
  goto :fail
)
if "%SAKURUPIAH_CALLBACK_URL%"=="" (
  echo Missing SAKURUPIAH_CALLBACK_URL
  goto :fail
)
if "%SAKURUPIAH_IS_PRODUCTION%"=="" (
  set SAKURUPIAH_IS_PRODUCTION=false
)

REM === RUN DEPLOY SCRIPT ===
powershell -ExecutionPolicy Bypass -File .\scripts\supabase-deploy.ps1
if errorlevel 1 goto :fail

echo Deploy completed successfully.
goto :eof

REM Pause to show result
:fail
echo Deploy failed.
pause
