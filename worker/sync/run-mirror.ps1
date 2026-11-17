$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force -Path logs | Out-Null
$log = Join-Path $PSScriptRoot 'logs\mirror.log'
"=== $(Get-Date -Format s) ===" | Add-Content $log
& node mirror.mjs *>> $log
"exit $LASTEXITCODE" | Add-Content $log
if ((Get-Item $log).Length -gt 2MB) { Get-Content $log -Tail 2000 | Set-Content $log }
