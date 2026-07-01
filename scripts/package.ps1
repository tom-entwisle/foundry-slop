$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$dist = Join-Path $root "dist"
$zip = Join-Path $dist "foundry-slop.zip"

New-Item -ItemType Directory -Path $dist -Force | Out-Null
if (Test-Path $zip) {
  Remove-Item $zip -Force
}

$items = @(
  "module.json",
  "README.md",
  "scripts/foundry-slop.js",
  "styles/foundry-slop.css",
  "lang/en.json"
)

$paths = $items | ForEach-Object { Join-Path $root $_ }
Compress-Archive -Path $paths -DestinationPath $zip -Force

Write-Host "Created $zip"
