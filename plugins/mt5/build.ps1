# Builds the MetaTrader 5 plugin package: compiles the Expert Advisor with MetaEditor, zips it with the manifest,
# signs the zip with the release key (the catalog's packages must be signed) and prints the catalog entry.
#
#   ./build.ps1 [-MetaEditor "C:\Program Files\MetaTrader 5\MetaEditor64.exe"] [-Key ~/.tauri/opentrader-updater.key]
#
# Out: plugins/mt5/dist/mt5-<version>.zip, .zip.sig and catalog-entry.json. MetaEditor runs on Windows only, so this runs locally, not in CI.
param(
  [string]$MetaEditor = "C:\Program Files\MetaTrader 5\MetaEditor64.exe",
  [string]$Key = "$HOME\.tauri\opentrader-updater.key"
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$manifest = Get-Content "$here\opentrader-plugin.json" -Raw | ConvertFrom-Json
$version = $manifest.version
$dist = "$here\dist"
$stage = "$dist\stage"
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage | Out-Null

# MetaEditor finds <Trade/Trade.mqh> in a terminal's MQL5 folder.
$terminal = Get-ChildItem "$env:APPDATA\MetaQuotes\Terminal" -Directory | Where-Object { Test-Path "$($_.FullName)\MQL5\Include\Trade\Trade.mqh" } | Select-Object -First 1
if (-not $terminal) { throw "No MetaTrader 5 data folder with MQL5\Include found" }
$log = "$dist\compile.log"
& $MetaEditor "/compile:$here\OpenTraderBridge.mq5" "/inc:$($terminal.FullName)\MQL5" "/log:$log" | Out-Null
Start-Sleep -Seconds 1
$result = (Get-Content $log -Encoding Unicode | Select-String "Result:").Line
Write-Host $result
if ($result -notmatch "Result: 0 errors") { throw "The Expert Advisor did not compile (see $log)" }
Move-Item -Force "$here\OpenTraderBridge.ex5" "$stage\OpenTraderBridge.ex5"
Copy-Item "$here\opentrader-plugin.json" "$stage\opentrader-plugin.json"

$zip = "$dist\mt5-$version.zip"
Remove-Item -Force $zip, "$zip.sig" -ErrorAction SilentlyContinue
Compress-Archive -Path "$stage\*" -DestinationPath $zip
Remove-Item -Recurse -Force $stage

# The release key's password comes from the environment, as in the app's release workflow.
if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -and (Test-Path "$Key.password")) {
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content "$Key.password" -Raw).Trim()
}
Push-Location "$here\..\.."
npx tauri signer sign -f $Key $zip | Out-Null
Pop-Location
if (-not (Test-Path "$zip.sig")) { throw "The package was not signed" }

$sha = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
$entry = [ordered]@{
  id = $manifest.id; name = $manifest.name; version = $version; publisher = $manifest.publisher; description = $manifest.description
  provides = $manifest.provides; api = $manifest.api; platforms = $manifest.platforms; homepage = $manifest.homepage
  url = "https://github.com/deepentropy/opentrader/releases/download/plugin-mt5-v$version/mt5-$version.zip"
  sha256 = $sha; signature = (Get-Content "$zip.sig" -Raw).Trim()
}
$entry | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 "$dist\catalog-entry.json"
Write-Host "Package: $zip"
Write-Host "Catalog entry: $dist\catalog-entry.json"
