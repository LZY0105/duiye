param(
    [string[]]$Tasks = @(':app:assembleDebug'),
    [switch]$SkipWebSync
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$androidRoot = Join-Path $repoRoot 'android'
$localPropertiesPath = Join-Path $androidRoot 'local.properties'
$sdkRoot = if ($env:ANDROID_SDK_ROOT) {
    $env:ANDROID_SDK_ROOT
} elseif ($env:ANDROID_HOME) {
    $env:ANDROID_HOME
} else {
    Join-Path $env:LOCALAPPDATA 'Android\Sdk'
}
$sdkRoot = [System.IO.Path]::GetFullPath($sdkRoot)

$repoDriveName = 'R'
$sdkDriveName = 'S'
$repoDrive = "${repoDriveName}:"
$sdkDrive = "${sdkDriveName}:"

if (Get-PSDrive -Name $repoDriveName -ErrorAction SilentlyContinue) {
    throw "$repoDrive is already in use"
}
if (Get-PSDrive -Name $sdkDriveName -ErrorAction SilentlyContinue) {
    throw "$sdkDrive is already in use"
}
if (-not (Test-Path -LiteralPath (Join-Path $sdkRoot 'cmake\3.31.6\bin\cmake.exe'))) {
    throw "Android CMake 3.31.6 is not installed under $sdkRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $sdkRoot 'ndk\29.0.13113456'))) {
    throw "Android NDK 29.0.13113456 is not installed under $sdkRoot"
}

$knownJdk21 = Join-Path $env:USERPROFILE '.jdks\jbr-21.0.11'
$javaRoot = if (Test-Path -LiteralPath (Join-Path $knownJdk21 'bin\java.exe')) {
    $knownJdk21
} else {
    $env:JAVA_HOME
}
if (-not (Test-Path -LiteralPath (Join-Path $javaRoot 'bin\java.exe'))) {
    throw 'JDK 21 is required. Set JAVA_HOME to a JDK 21 installation.'
}

$hadLocalProperties = Test-Path -LiteralPath $localPropertiesPath
$originalLocalProperties = if ($hadLocalProperties) {
    [System.IO.File]::ReadAllBytes($localPropertiesPath)
} else {
    $null
}
$exitCode = 1
$repoMapped = $false
$sdkMapped = $false

# Rebuild the web bundle and copy it into the native project BEFORE Gradle runs.
# android/app/src/main/assets/public is generated, not tracked, so without this
# step Gradle happily packages whatever bundle happened to be left there last —
# which is how an APK shipped the previous UI while dist/ held the current one.
# Skip only with -SkipWebSync, and only when you know the assets are current.
if (-not $SkipWebSync) {
    Write-Host 'Building web assets and syncing them into the Android project...'
    Push-Location -LiteralPath $repoRoot
    try {
        & npm.cmd run build:android
        if ($LASTEXITCODE -ne 0) { throw "Web build or Capacitor sync failed (exit $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
}

try {
    & subst.exe $repoDrive $repoRoot
    if ($LASTEXITCODE -ne 0) { throw "Failed to map $repoDrive" }
    $repoMapped = $true

    & subst.exe $sdkDrive $sdkRoot
    if ($LASTEXITCODE -ne 0) { throw "Failed to map $sdkDrive" }
    $sdkMapped = $true

    [System.IO.File]::WriteAllText(
        $localPropertiesPath,
        "sdk.dir=S\:/`r`n",
        [System.Text.UTF8Encoding]::new($false)
    )

    $buildTemp = Join-Path $repoDrive '.build-temp'
    $gradleCache = Join-Path $repoDrive '.gradle-hybrid-j21'
    New-Item -ItemType Directory -Force -Path $buildTemp, $gradleCache | Out-Null

    $env:JAVA_HOME = $javaRoot
    $env:GRADLE_USER_HOME = $gradleCache
    $env:ANDROID_USER_HOME = Join-Path $repoDrive '.android-local'
    $env:TEMP = $buildTemp
    $env:TMP = $buildTemp
    $env:GRADLE_OPTS = "-Djava.io.tmpdir=$buildTemp -Dorg.gradle.vfs.watch=false"

    Set-Location -LiteralPath (Join-Path $repoDrive 'android')
    & '.\gradlew.bat' @Tasks '--no-daemon' '--max-workers=1'
    $exitCode = $LASTEXITCODE
} finally {
    Set-Location -LiteralPath 'C:\'
    if ($hadLocalProperties) {
        [System.IO.File]::WriteAllBytes($localPropertiesPath, $originalLocalProperties)
    } elseif (Test-Path -LiteralPath $localPropertiesPath) {
        Remove-Item -LiteralPath $localPropertiesPath
    }
    if ($repoMapped) { & subst.exe $repoDrive /D }
    if ($sdkMapped) { & subst.exe $sdkDrive /D }
}

exit $exitCode
