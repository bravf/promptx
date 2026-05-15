# PromptX Android

一个用于加载线上 PromptX H5 的 Android WebView 壳。

## 运行

如果已安装 Android Studio / Gradle，可直接使用 Gradle 构建：

```bash
cd apps/android
gradle assembleDebug
```

Release 包需要本地签名文件 `signing.properties` 和 keystore。两者不会提交到仓库。

```bash
cd apps/android
gradle assembleRelease
```

当前仓库也提供一个仅依赖 Android SDK Build Tools 的 debug 包构建脚本，适合没有全局 Gradle 时快速打测试包：

```bash
cd apps/android
./scripts/build-debug-apk.sh
```

生成的测试包在：

```text
app/build/outputs/apk/debug/app-debug.apk
```
