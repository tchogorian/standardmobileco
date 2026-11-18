# Publishes one Standard Mobile Company insights article, then pushes main.
$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\user\standardmobileco'
Set-Location $repo

$logDir = Join-Path $repo 'scripts\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$today = Get-Date -Format 'yyyy-MM-dd'
$displayDate = (Get-Date).ToString('MMMM d, yyyy')
$log = Join-Path $logDir "publish-$today.log"
$stamp = Join-Path $logDir 'last-success.txt'
$lock = Join-Path $logDir 'publish.lock'

function Write-Log([string]$Message) {
  $line = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $Message
  Add-Content -LiteralPath $log -Value $line -Encoding utf8
  Write-Output $line
}

$snapshotDir = Join-Path $logDir 'snapshot'

function Save-SiteSnapshot {
  New-Item -ItemType Directory -Force -Path $snapshotDir | Out-Null
  foreach ($name in @('insights.html', 'sitemap.xml', 'index.html')) {
    Copy-Item -LiteralPath (Join-Path $repo $name) -Destination (Join-Path $snapshotDir $name) -Force
  }
}

function Restore-SiteFiles {
  foreach ($name in @('insights.html', 'sitemap.xml', 'index.html')) {
    $saved = Join-Path $snapshotDir $name
    if (Test-Path -LiteralPath $saved) {
      Copy-Item -LiteralPath $saved -Destination (Join-Path $repo $name) -Force
    }
  }
}

if ((Test-Path -LiteralPath $stamp) -and ((Get-Content -LiteralPath $stamp -Raw).Trim() -eq $today)) {
  Write-Log "Already published $today."
  exit 0
}

if (Test-Path -LiteralPath $lock) {
  $age = (Get-Date) - (Get-Item -LiteralPath $lock).LastWriteTime
  if ($age.TotalHours -lt 3) {
    Write-Log 'A publish is already running.'
    exit 0
  }
  Remove-Item -LiteralPath $lock -Force
}
Set-Content -LiteralPath $lock -Value $PID -Encoding ascii

try {
  $agentCmd = Join-Path $env:LOCALAPPDATA 'cursor-agent\cursor-agent.cmd'
  if (-not (Test-Path -LiteralPath $agentCmd)) {
    throw "Cursor CLI is not installed at $agentCmd"
  }

  # The CLI swaps its own launcher when it self-updates; a call during the swap fails once, so retry.
  $status = ''
  for ($try = 1; $try -le 4; $try++) {
    $ErrorActionPreference = 'Continue'
    $status = & $agentCmd status 2>&1 | Out-String
    $ErrorActionPreference = 'Stop'
    if ($status -match 'Logged in' -or $status -match 'Not logged in') { break }
    Write-Log "CLI status attempt $try failed: $($status.Trim())"
    Start-Sleep -Seconds 30
  }
  Write-Log ($status.Trim())
  if ($status -match 'Not logged in') {
    throw 'Cursor CLI is not logged in. Run cursor-agent login once in this Windows account.'
  }
  if ($status -notmatch 'Logged in') {
    throw 'Cursor CLI did not respond.'
  }

  Write-Log 'Updating main'
  git pull --ff-only origin main
  if ($LASTEXITCODE -ne 0) { throw "git pull failed ($LASTEXITCODE)" }

  $unpushed = @(git log --format='%s' 'origin/main..HEAD')
  if ($unpushed.Count -gt 0) {
    $foreign = @($unpushed | Where-Object { $_ -notlike 'Publish insights article:*' })
    if ($foreign.Count -gt 0) {
      throw "Unpushed commits are not daily articles: $($foreign -join ' | ')"
    }
    Write-Log "Pushing $($unpushed.Count) unpublished article commit(s)."
    git push origin main
    if ($LASTEXITCODE -ne 0) { throw "git push failed ($LASTEXITCODE)" }
    Set-Content -LiteralPath $stamp -Value $today -Encoding ascii
    Write-Log 'Push completed.'
    exit 0
  }

  $allowedBefore = @(
    'feed.xml', 'robots.txt', 'llms.txt', '.gitignore',
    'scripts/publish-daily.ps1', 'scripts/daily-article-prompt.md',
    'insights.html', 'index.html', 'sitemap.xml'
  )
  $dirty = @(git status --porcelain | ForEach-Object { $_.Substring(3).Trim() })
  $unexpected = @($dirty | Where-Object {
    $_ -and
    ($_ -notin $allowedBefore) -and
    ($_ -ne 'scripts/') -and
    ($_ -notlike 'scripts/*')
  })
  if ($unexpected.Count -gt 0) {
    throw "Working tree has unrelated changes: $($unexpected -join ', ')"
  }

  Save-SiteSnapshot
  $before = @(Get-ChildItem -LiteralPath (Join-Path $repo 'articles') -Filter '*.html' | Select-Object -ExpandProperty Name)
  $template = Get-Content -LiteralPath (Join-Path $repo 'scripts\daily-article-prompt.md') -Raw
  $resolved = $template.Replace('{{DATE}}', $today).Replace('{{DISPLAY_DATE}}', $displayDate)
  $resolvedPath = Join-Path $logDir 'today-prompt.md'
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($resolvedPath, $resolved, $utf8)
  $prompt = "Read and follow scripts/logs/today-prompt.md exactly. Publish exactly one article for $displayDate. Do not run git."

  Write-Log 'Writing the article'
  $ErrorActionPreference = 'Continue'
  & $agentCmd -p --trust --workspace $repo --output-format text $prompt 2>&1 |
    ForEach-Object { Write-Log ([string]$_) }
  $agentExit = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($null -ne $agentExit -and $agentExit -ne 0) {
    throw "Article agent exited $agentExit"
  }

  $after = @(Get-ChildItem -LiteralPath (Join-Path $repo 'articles') -Filter '*.html' | Select-Object -ExpandProperty Name)
  $newFiles = @($after | Where-Object { $_ -notin $before })
  if ($newFiles.Count -ne 1) {
    Restore-SiteFiles
    foreach ($extra in $newFiles) {
      Remove-Item -LiteralPath (Join-Path $repo "articles\$extra") -Force -ErrorAction SilentlyContinue
    }
    throw "Expected exactly 1 new article, found $($newFiles.Count): $($newFiles -join ', ')"
  }

  $newName = $newFiles[0]
  if ($newName -notmatch '^[a-z0-9]+(-[a-z0-9]+)*\.html$') {
    Restore-SiteFiles
    Remove-Item -LiteralPath (Join-Path $repo "articles\$newName") -Force
    throw "Refusing article filename: $newName"
  }

  $articlePath = Join-Path $repo "articles\$newName"
  $html = Get-Content -LiteralPath $articlePath -Raw
  $insights = Get-Content -LiteralPath (Join-Path $repo 'insights.html') -Raw
  $sitemap = Get-Content -LiteralPath (Join-Path $repo 'sitemap.xml') -Raw
  $problems = @()
  if ($html -notmatch 'FAQPage') { $problems += 'missing FAQPage schema' }
  if ($html -notmatch [regex]::Escape($today)) { $problems += 'missing today''s date' }
  if ($insights -notlike "*articles/$newName*") { $problems += 'insights.html has no card' }
  if ($sitemap -notlike "*articles/$newName*") { $problems += 'sitemap.xml has no url' }
  if ($problems.Count -gt 0) {
    Restore-SiteFiles
    Remove-Item -LiteralPath $articlePath -Force
    throw "Article failed checks: $($problems -join '; ')"
  }

  $title = $newName
  if ($html -match '<title>([^<]+)</title>') {
    $title = ($Matches[1] -replace '\s*\|\s*Standard Mobile Company\s*$', '').Trim()
  }
  $description = ''
  if ($html -match 'name="description"\s+content="([^"]*)"') { $description = $Matches[1] }
  function Escape-Xml([string]$Value) {
    if (-not $Value) { return '' }
    return (($Value -replace '&', '&amp;') -replace '<', '&lt;') -replace '>', '&gt;' -replace '"', '&quot;'
  }
  $link = "https://standardmobileco.com/articles/$newName"
  $pubDate = (Get-Date).ToString('r')
  $item = @"
    <item>
      <title>$(Escape-Xml $title)</title>
      <link>$link</link>
      <guid>$link</guid>
      <pubDate>$pubDate</pubDate>
      <description>$(Escape-Xml $description)</description>
    </item>
"@
  $feedPath = Join-Path $repo 'feed.xml'
  $feed = Get-Content -LiteralPath $feedPath -Raw
  if ($feed -notlike "*${link}*") {
    $feed = $feed -replace '<lastBuildDate>.*?</lastBuildDate>', "<lastBuildDate>$pubDate</lastBuildDate>"
    $feed = $feed.Replace('    <!-- items -->', ("    <!-- items -->" + [Environment]::NewLine + $item))
    $utf8Feed = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($feedPath, $feed, $utf8Feed)
  }

  $slug = [System.IO.Path]::GetFileNameWithoutExtension($newName)
  git add -- "articles/$newName" insights.html sitemap.xml feed.xml robots.txt llms.txt .gitignore index.html scripts/publish-daily.ps1 scripts/daily-article-prompt.md
  $cached = @(git diff --cached --name-only)
  $allowedCommit = @(
    "articles/$newName", 'insights.html', 'sitemap.xml', 'feed.xml',
    'robots.txt', 'llms.txt', '.gitignore', 'index.html',
    'scripts/publish-daily.ps1', 'scripts/daily-article-prompt.md'
  )
  $extraCached = @($cached | Where-Object { $_ -notin $allowedCommit })
  if ($extraCached.Count -gt 0) {
    git reset --quiet
    throw "Refusing to commit unexpected files: $($extraCached -join ', ')"
  }
  if ($cached.Count -eq 0) { throw 'Nothing staged to publish' }

  git commit -m "Publish insights article: $slug"
  if ($LASTEXITCODE -ne 0) { throw "git commit failed ($LASTEXITCODE)" }
  git push origin main
  if ($LASTEXITCODE -ne 0) { throw "git push failed ($LASTEXITCODE)" }

  Set-Content -LiteralPath $stamp -Value $today -Encoding ascii
  Write-Log "Published $newName"
}
catch {
  Write-Log ("FAILED: " + $_.Exception.Message)
  exit 1
}
finally {
  if (Test-Path -LiteralPath $lock) { Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue }
}
