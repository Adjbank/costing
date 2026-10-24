<#
  Build the GitHub Pages site for the fragrance-oil costing system.

  Usage
    Windows (PowerShell 5.1):  powershell -ExecutionPolicy Bypass -File .\build.ps1
    PowerShell 7 / CI:         pwsh ./build.ps1

  Input   apps-script/Index.html   (the same page used inside Apps Script)
          site.config.json         (apiUrl, googleClientId)
          env COSTING_API_URL / GOOGLE_CLIENT_ID override the JSON (GitHub Actions variables)
  Output  dist/index.html, dist/.nojekyll

  The page carries no price data. Prices are loaded from the Apps Script API only after
  the server has verified the visitor's Google ID token. The build aborts if price rows
  ever end up in the output.
#>
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$src = Join-Path $root 'apps-script/Index.html'
$cfgPath = Join-Path $root 'site.config.json'
$dist = Join-Path $root 'dist'

if (-not (Test-Path $src)) { throw "Not found: $src" }
if (-not (Test-Path $cfgPath)) { throw "Not found: $cfgPath" }

$cfg = [IO.File]::ReadAllText($cfgPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
$apiUrl = [string]$cfg.apiUrl
$clientId = [string]$cfg.googleClientId
if ($env:COSTING_API_URL) { $apiUrl = $env:COSTING_API_URL }
if ($env:GOOGLE_CLIENT_ID) { $clientId = $env:GOOGLE_CLIENT_ID }

if (-not $apiUrl -or $apiUrl -match 'REPLACE_ME') { throw "site.config.json: set 'apiUrl' to the Apps Script API URL (ends with /exec). See GITHUB-PAGES.md" }
if (-not $clientId -or $clientId -match 'REPLACE_ME') { throw "site.config.json: set 'googleClientId'. See GITHUB-PAGES.md" }
if ($apiUrl -notmatch '^https://script\.google\.com/(a/macros/[^/]+/|macros/)s/[^/]+/exec$' -and $apiUrl -notmatch '^https://[a-z0-9]{20}\.supabase\.co/functions/v1/api$') { throw "apiUrl must be an Apps Script web app URL or a Supabase Edge Function URL: $apiUrl" }
if ($clientId -notmatch '^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$') { throw "googleClientId does not look like a Google OAuth client ID: $clientId" }

$html = [IO.File]::ReadAllText($src, [Text.Encoding]::UTF8)
$html = $html.Replace('<base target="_top">', '')   # only needed inside Apps Script

$config = [ordered]@{ apiUrl = $apiUrl; googleClientId = $clientId } | ConvertTo-Json -Compress
$inject = "`n<script>window.COSTING_CONFIG = $config;</script>`n<script src=`"https://accounts.google.com/gsi/client`" async defer></script>`n"
$i = $html.IndexOf('<body>')
if ($i -lt 0) { throw '<body> not found in Index.html' }
$html = $html.Insert($i + 6, $inject)

if ($html -match 'RM-[0-9A-Z]+-\d{3}-\d{1,4}\|') { throw 'Price data found in the page output. Aborting so it is never published.' }

New-Item -ItemType Directory -Force $dist | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $dist 'index.html'), $html, $utf8)
[IO.File]::WriteAllText((Join-Path $dist '.nojekyll'), '', $utf8)

$kb = [math]::Round((Get-Item (Join-Path $dist 'index.html')).Length / 1KB)
Write-Host "Built dist/index.html ($kb KB)"
Write-Host "  API:       $apiUrl"
Write-Host "  Client ID: $clientId"
