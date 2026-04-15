@echo off
REM Deploy Supabase Edge Functions (midtrans-webhook dan subscription-api) beserta secrets

REM === REQUIRED ENVIRONMENT VARIABLES (set these in shell before running) ===
REM SUPABASE_PROJECT_REF
REM SUPABASE_ACCESS_TOKEN
REM SUPABASE_DB_PASSWORD
REM MIDTRANS_SERVER_KEY
REM Optional:
REM MIDTRANS_CLIENT_KEY
REM MIDTRANS_IS_PRODUCTION (default false)

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
if "%MIDTRANS_SERVER_KEY%"=="" (
  echo Missing MIDTRANS_SERVER_KEY
  goto :fail
)
if "%MIDTRANS_IS_PRODUCTION%"=="" (
  set MIDTRANS_IS_PRODUCTION=false
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
