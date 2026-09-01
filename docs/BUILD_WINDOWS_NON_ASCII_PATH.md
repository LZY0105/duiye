# Building from the Gradle CLI on a Windows path containing non-ASCII characters

Android Studio builds this project fine from a path containing non-ASCII
characters (for example a Chinese Windows username). The **Gradle command line**
does not, and the failures are misleading: each one reports a path with `?`
where the non-ASCII characters were, because the JVM launcher hands the path to
the OS in the ANSI code page.

Four separate paths must all be ASCII, and each one fails at a different stage:

| Path | Symptom if left non-ASCII |
|---|---|
| project dir | `Unable to access jarfile ...\gradle\wrapper\gradle-wrapper.jar` |
| `JAVA_HOME` | `could not find java.dll` / `Could not find Java SE Runtime Environment` |
| `GRADLE_USER_HOME` | `Error opening zip file or JAR manifest missing: ...gradle-instrumentation-agent-*.jar` |
| Android SDK (`sdk.dir`) | `Failed to transform core-for-system-modules.jar` / `JdkImageTransform` failure |

## Recipe

Map each one to a drive letter with `subst`, then build from the mapped paths.
`subst` is per-logon-session, so this must be repeated after a reboot.

```powershell
subst R: "<path to this repository>"        # project
subst J: "$env:USERPROFILE\.jdks"           # JDK parent
subst G: "$env:USERPROFILE"                 # user home (Gradle cache)
subst S: "$env:LOCALAPPDATA\Android\Sdk"    # Android SDK
```

`sdk.dir` in `android/local.properties` takes precedence over `ANDROID_HOME`, so
it must be repointed too. That file is git-ignored, so this is a local-only
change — set it to `sdk.dir=S\:\\` for the CLI build and put it back afterwards
(or keep a second copy).

Mapping `G:` to the existing user home reuses the populated Gradle cache rather
than re-downloading dependencies.

```powershell
$env:JAVA_HOME        = "J:\<jdk-directory-name>"
$env:ANDROID_HOME     = "S:\"
$env:GRADLE_USER_HOME = "G:\.gradle"
Set-Location "R:\android"
.\gradlew.bat :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

Release the mappings with `subst R: /D` (and likewise `J:`, `G:`, `S:`).

## Toolchain versions verified

- JDK 21. The Android Studio bundled JBR is currently Java 25, which Gradle
  8.14.3 does not support.
- Gradle 8.14.3, Android Gradle Plugin 8.13.0, `compileSdk` 36.

APKs land in `android/app/build/outputs/apk/debug/` — one per ABI
(`arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`).
