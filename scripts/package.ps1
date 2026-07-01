$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$dist = Join-Path $root "dist"
$zip = Join-Path $dist "ald-amil-casino.zip"
$repoZip = Join-Path $root "ald-amil-casino.zip"
$stage = Join-Path $dist "package"

New-Item -ItemType Directory -Path $dist -Force | Out-Null
if (Test-Path $zip) {
  Remove-Item $zip -Force
}
if (Test-Path $repoZip) {
  Remove-Item $repoZip -Force
}
if (Test-Path $stage) {
  Remove-Item $stage -Recurse -Force
}
New-Item -ItemType Directory -Path $stage | Out-Null

$items = @(
  "module.json",
  "README.md",
  "assets/ald-amil-table.png",
  "scripts/ald-amil-casino.js",
  "styles/ald-amil-casino.css"
)

foreach ($item in $items) {
  $source = Join-Path $root $item
  $target = Join-Path $stage $item
  $targetDirectory = Split-Path $target -Parent
  New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
  Copy-Item -Path $source -Destination $target
}

Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -Force
Copy-Item -Path $zip -Destination $repoZip
Remove-Item $stage -Recurse -Force

Write-Host "Created $zip"
Write-Host "Updated $repoZip"
