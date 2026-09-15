\# Android 开发与构建



\## 环境要求



\- JDK 21

\- Android SDK Platform 36

\- Android SDK Build-Tools 36

\- Android NDK 27.0.12077973

\- CMake 3.31.6

\- Node.js 与 npm：以 `package-lock.json` 为准



项目 Android 模块包含 C++ 原生代码。Windows 下建议将用于 Android 构建的工作副本放在纯英文路径中，例如 `D:\\duiye-android`；中文路径可能导致 CMake/NDK 配置失败。



\## 配置本地 SDK



在 `android/local.properties` 中配置 SDK 路径：



```properties

sdk.dir=D:/Android/Sdk
```


## 使用 JDK 21

Gradle 构建要求 JDK 21。执行 Gradle 前，先确认当前终端使用的是 JDK 21：

```powershell
java -version
```

如果不是 JDK 21，将 `JAVA_HOME` 设置为本机实际的 JDK 21 安装目录后，再重新打开终端或更新当前会话。

## 构建 Debug APK

> 重要：不要在包含中文字符的项目路径中执行 Gradle 或 CMake 构建。
> Windows 下请使用纯英文路径的工作副本，例如 `D:\duiye-android`。
> 原始开发仓库用于编辑、提交和创建 PR；Android 构建在纯英文工作副本中完成。

在纯英文工作副本的项目根目录执行：

```powershell
npm.cmd ci
npm.cmd run build:android
Set-Location .\android
.\gradlew.bat assembleDebug
```

构建成功的标志是 Gradle 输出：

```text
BUILD SUCCESSFUL
```

生成的 Debug APK 位于：

```text
android\app\build\outputs\apk\debug\app-debug.apk
```
