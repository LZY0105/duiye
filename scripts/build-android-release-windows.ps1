param(
    [Parameter(Mandatory = $true)]
    [string]$KeystorePath,

    [string]$KeyAlias = 'duiye',

    [switch]$SkipWebSync
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$baseBuildScript = Join-Path $PSScriptRoot 'build-android-windows.ps1'
$legacyProperties = Join-Path $repoRoot 'android\app\keystore.properties'

if (-not (Test-Path -LiteralPath $KeystorePath -PathType Leaf)) {
    throw "Keystore file not found: $KeystorePath"
}

if (-not (Test-Path -LiteralPath $baseBuildScript -PathType Leaf)) {
    throw "Base Android build script not found: $baseBuildScript"
}

$resolvedKeystorePath = (Resolve-Path -LiteralPath $KeystorePath).Path
$securePassword = Read-Host 'Enter the release keystore password' -AsSecureString
$credential = [System.Management.Automation.PSCredential]::new(
    'release-signing',
    $securePassword
)
$plainPassword = $credential.GetNetworkCredential().Password

if ([string]::IsNullOrEmpty($plainPassword)) {
    throw 'The release keystore password cannot be empty.'
}

$signingVariableNames = @(
    'KEYSTORE_FILE',
    'KEYSTORE_PASSWORD',
    'KEY_ALIAS',
    'KEY_PASSWORD'
)

$previousSigningValues = @{}
foreach ($name in $signingVariableNames) {
    $previousSigningValues[$name] =
        [Environment]::GetEnvironmentVariable($name, 'Process')
}

if (Test-Path -LiteralPath $legacyProperties) {
    Write-Warning (
        'Legacy keystore.properties still exists. ' +
        'Environment variables will take priority during this migration build.'
    )
}

try {
    [Environment]::SetEnvironmentVariable(
        'KEYSTORE_FILE',
        $resolvedKeystorePath,
        'Process'
    )
    [Environment]::SetEnvironmentVariable(
        'KEYSTORE_PASSWORD',
        $plainPassword,
        'Process'
    )
    [Environment]::SetEnvironmentVariable(
        'KEY_ALIAS',
        $KeyAlias,
        'Process'
    )
    [Environment]::SetEnvironmentVariable(
        'KEY_PASSWORD',
        $plainPassword,
        'Process'
    )

    $arguments = @(
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        $baseBuildScript,
        '-Tasks',
        ':app:assembleRelease'
    )

    if ($SkipWebSync) {
        $arguments += '-SkipWebSync'
    }

    $windowsPowerShell = Get-Command powershell.exe -ErrorAction Stop
    & $windowsPowerShell.Source @arguments
    $buildExitCode = $LASTEXITCODE

    if ($buildExitCode -ne 0) {
        throw "Release build failed with exit code $buildExitCode."
    }

    Write-Host 'Secure release build completed successfully.'
} finally {
    foreach ($name in $signingVariableNames) {
        [Environment]::SetEnvironmentVariable(
            $name,
            $previousSigningValues[$name],
            'Process'
        )
    }

    $plainPassword = $null
    $credential = $null

    if ($null -ne $securePassword) {
        $securePassword.Dispose()
    }
}