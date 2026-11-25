# Builds the NinjaTrader 8 plugin package: checks that the add-on compiles against the installed NinjaTrader, zips its
# source with the manifest, signs the zip with the release key (the catalog's packages must be signed) and prints the
# catalog entry. NinjaTrader compiles the add-on on the user's computer, so the package holds its source.
#
#   ./build.ps1 [-NinjaTrader "C:\Program Files\NinjaTrader 8"] [-Key ~/.tauri/opentrader-updater.key]
#
# Out: plugins/ninjatrader/dist/ninjatrader-<version>.zip, .zip.sig and catalog-entry.json. It needs NinjaTrader 8 and the .NET SDK.
param(
  [string]$NinjaTrader = "C:\Program Files\NinjaTrader 8",
  [string]$Key = "$HOME\.tauri\opentrader-updater.key"
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$manifest = Get-Content "$here\opentrader-plugin.json" -Raw | ConvertFrom-Json
$version = $manifest.version
$source = Get-Content "$here\OpenTraderBridge.cs" -Raw
if ($source -notmatch "Version = `"$([regex]::Escape($version))`"") { throw "OpenTraderBridge.cs does not carry version $version" }
$dist = "$here\dist"
$stage = "$dist\stage"
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage | Out-Null

# The compiler of the newest .NET SDK, with the references of NinjaTrader's own script project.
$sdk = (dotnet --list-sdks | Select-Object -Last 1) -replace '^(\S+) \[(.+)\]$', '$2\$1'
$framework = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319"
$refs = @("mscorlib", "System", "System.Core", "System.Xml", "System.Xaml") | ForEach-Object { "/r:$framework\$_.dll" }
$refs += @("WindowsBase", "PresentationCore", "PresentationFramework") | ForEach-Object { "/r:$framework\WPF\$_.dll" }
$refs += "/r:$NinjaTrader\bin\NinjaTrader.Core.dll", "/r:$NinjaTrader\bin\NinjaTrader.Gui.dll"
Remove-Item Env:LIB -ErrorAction SilentlyContinue
dotnet "$sdk\Roslyn\bincore\csc.dll" /nologo /noconfig /nostdlib /langversion:8 /target:library "/out:$dist\check.dll" $refs "$here\OpenTraderBridge.cs"
if ($LASTEXITCODE -ne 0) { throw "The add-on did not compile" }
Remove-Item "$dist\check.dll"

Copy-Item "$here\OpenTraderBridge.cs", "$here\opentrader-plugin.json" $stage
$zip = "$dist\ninjatrader-$version.zip"
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
  url = "https://github.com/deepentropy/opentrader/releases/download/plugin-ninjatrader-v$version/ninjatrader-$version.zip"
  sha256 = $sha; signature = (Get-Content "$zip.sig" -Raw).Trim()
}
$entry | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 "$dist\catalog-entry.json"
Write-Host "Package: $zip"
Write-Host "Catalog entry: $dist\catalog-entry.json"
