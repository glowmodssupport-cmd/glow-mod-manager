param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][ValidatePattern('^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')][string]$Version,
    [Parameter(Mandatory)][string]$Publisher,
    [Parameter(Mandatory)][string]$Output
)
$ErrorActionPreference = 'Stop'
$file = Get-Item -LiteralPath $Installer
if ($file.Name -cne "GlowModManager-Setup-$Version.exe") { throw 'The installer filename does not match the release version.' }
$signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -cne $Publisher) {
    throw 'The installer must have a trusted signature from the configured publisher.'
}
$info = $file.VersionInfo
if ($info.ProductName -cne 'Glow Mod Manager') { throw 'The installer product name does not match Glow Mod Manager.' }
$embeddedVersion = "$($info.ProductMajorPart).$($info.ProductMinorPart).$($info.ProductBuildPart)"
if ($embeddedVersion -ne $Version) { throw "The installer reports version $embeddedVersion instead of $Version." }

$null = New-Item -ItemType Directory -Path $Output -Force
$target = Join-Path $Output $file.Name
$metadata = Join-Path $Output 'latest.yml'
if ((Test-Path -LiteralPath $target) -or (Test-Path -LiteralPath $metadata)) { throw 'Use an empty release output directory.' }
Copy-Item -LiteralPath $file.FullName -Destination $target
# JSON is valid YAML. Hash the signed installer after copying it.
$hex = (Get-FileHash -LiteralPath $target -Algorithm SHA512).Hash
$hash = [Convert]::ToBase64String([Convert]::FromHexString($hex))
@{
    version = $Version
    files = @(@{ url = $file.Name; sha512 = $hash; size = $file.Length })
    path = $file.Name
    sha512 = $hash
    releaseDate = [DateTime]::UtcNow.ToString('o')
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $metadata -Encoding utf8NoBOM
