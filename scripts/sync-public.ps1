$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$public = Join-Path $root "public"
$dist = Join-Path $root "dist"

# Синхронизация public (источник для Vite)
New-Item -ItemType Directory -Force $public | Out-Null

$files = @(
  "manifest.json",
  "background.js",
  "content.js",
  "offscreen.html",
  "offscreen.js"
)

foreach ($file in $files) {
  Copy-Item -LiteralPath (Join-Path $root $file) -Destination (Join-Path $public $file) -Force
}

# Синхронизация dist (готовое расширение) - критичные файлы должны быть актуальны
New-Item -ItemType Directory -Force $dist | Out-Null

foreach ($file in $files) {
  $src = Join-Path $public $file
  $dst = Join-Path $dist $file
  if (Test-Path $src) {
    Copy-Item -LiteralPath $src -Destination $dst -Force
  }
}
