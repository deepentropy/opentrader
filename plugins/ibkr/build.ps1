# Builds the Interactive Brokers plugin package: compiles the plugin program, zips it with the manifest, signs the zip
# with the release key (the catalog's packages must be signed) and prints the catalog entry.
#
#   ./build.ps1 [-Key ~/.tauri/opentrader-updater.key]
#
# Out: plugins/ibkr/dist/ibkr-<version>.zip, .zip.sig and catalog-entry.json. Windows only for now.
param(
  [string]$Key = "$HOME\.tauri\opentrader-updater.key"
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$manifest = Get-Content "$here\opentrader-plugin.json" -Raw | ConvertFrom-Json
$version = $manifest.version
$cargoVersion = (Select-String -Path "$here\Cargo.toml" -Pattern '^version = "(.+)"' | Select-Object -First 1).Matches[0].Groups[1].Value
if ($cargoVersion -ne $version) { throw "Cargo.toml says $cargoVersion, opentrader-plugin.json says $version" }
$dist = "$here\dist"
$stage = "$dist\stage"
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage | Out-Null

Push-Location $here
cargo build --release
$built = $LASTEXITCODE
Pop-Location
if ($built -ne 0) { throw "The plugin did not build" }
Copy-Item "$here\target\release\opentrader-ibkr.exe" "$stage\opentrader-ibkr.exe"
Copy-Item "$here\opentrader-plugin.json" "$stage\opentrader-plugin.json"

$zip = "$dist\ibkr-$version.zip"
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
  url = "https://github.com/deepentropy/opentrader/releases/download/plugin-ibkr-v$version/ibkr-$version.zip"
  sha256 = $sha; signature = (Get-Content "$zip.sig" -Raw).Trim()
}
$entry | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 "$dist\catalog-entry.json"
Write-Host "Package: $zip"
Write-Host "Catalog entry: $dist\catalog-entry.json"
