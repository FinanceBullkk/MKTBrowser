$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# The packaged verifier uses Chrome for Testing as a licence-free browser engine. Pin the archive
# here so a self-hosted runner does not depend on whatever interactive Chrome happens to be installed.
$chromeVersion = "152.0.7977.64"
$chromeUrl = "https://storage.googleapis.com/chrome-for-testing-public/$chromeVersion/win64/chrome-win64.zip"
$chromeSha256 = "b0db25dea445822429d8ebd36d53344cadcd63127308759456964029bbe18004"
$chromeExecutableSha256 = "79832d1e60cbad9323c07339f9608bc0ce93cb9242b9b5481c04a0c536720980"

if (-not $env:RUNNER_TEMP -or -not $env:GITHUB_ENV) {
  throw "RUNNER_TEMP and GITHUB_ENV are required to prepare the packaged verifier engine."
}

$cacheBase = if ($env:MKT_BROWSER_CFT_CACHE_DIR) {
  $env:MKT_BROWSER_CFT_CACHE_DIR
} elseif ($env:RUNNER_TOOL_CACHE) {
  Join-Path $env:RUNNER_TOOL_CACHE "mktbrowser-chrome-for-testing"
} else {
  Join-Path $env:RUNNER_TEMP "mktbrowser-chrome-for-testing"
}
$root = Join-Path $cacheBase $chromeVersion
$archive = Join-Path $root "chrome-win64.zip"
$partialArchive = "$archive.download"
$extracted = Join-Path $env:RUNNER_TEMP "mktbrowser-chrome-for-testing-$chromeVersion"
$executable = Join-Path $extracted "chrome-win64\chrome.exe"
New-Item -ItemType Directory -Force -Path $root | Out-Null

if (Test-Path -LiteralPath $archive -PathType Leaf) {
  $existingSha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($existingSha256 -ne $chromeSha256) {
    Remove-Item -LiteralPath $archive -Force
  }
}
if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
  Remove-Item -LiteralPath $partialArchive -Force -ErrorAction SilentlyContinue
  & curl.exe --fail --location --retry 3 --retry-delay 2 --output $partialArchive $chromeUrl
  if ($LASTEXITCODE -ne 0) {
    throw "Chrome for Testing download failed with exit code $LASTEXITCODE."
  }
  $downloadSha256 = (Get-FileHash -LiteralPath $partialArchive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($downloadSha256 -ne $chromeSha256) {
    Remove-Item -LiteralPath $partialArchive -Force
    throw "Chrome for Testing archive SHA-256 mismatch."
  }
  Move-Item -LiteralPath $partialArchive -Destination $archive -Force
}

# The archive may be cached, but executable state is job-scoped. Never trust a previous job's
# extracted directory on a persistent self-hosted runner.
Remove-Item -LiteralPath $extracted -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -LiteralPath $archive -DestinationPath $extracted -Force
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
  throw "Chrome for Testing archive did not contain chrome-win64\chrome.exe."
}

$actualVersion = (Get-Item -LiteralPath $executable).VersionInfo.ProductVersion
if ($actualVersion -ne $chromeVersion) {
  throw "Chrome for Testing version mismatch: expected $chromeVersion, got $actualVersion."
}
$actualExecutableSha256 = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualExecutableSha256 -ne $chromeExecutableSha256) {
  throw "Chrome for Testing executable SHA-256 mismatch."
}

Add-Content -LiteralPath $env:GITHUB_ENV -Value "MKT_BROWSER_SYSTEM_CHROME=$executable"
Write-Host "Prepared pinned Chrome for Testing $chromeVersion ($chromeSha256)."
