#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/app"
SDK_DIR="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
BUILD_TOOLS_DIR="$SDK_DIR/build-tools/36.0.0"
PLATFORM_JAR="$SDK_DIR/platforms/android-36/android.jar"
OUT_DIR="$APP_DIR/build/manual-debug"
GEN_DIR="$OUT_DIR/gen"
CLASS_DIR="$OUT_DIR/classes"
DEX_DIR="$OUT_DIR/dex"
RES_ZIP="$OUT_DIR/compiled-res.zip"
PACKAGED_MANIFEST="$OUT_DIR/AndroidManifest.xml"
UNSIGNED_APK="$OUT_DIR/app-debug-unsigned.apk"
ALIGNED_APK="$OUT_DIR/app-debug-aligned.apk"
FINAL_APK="$APP_DIR/build/outputs/apk/debug/app-debug.apk"
DEBUG_KEYSTORE="$HOME/.android/debug.keystore"

for tool in aapt2 d8 zipalign apksigner; do
  if [[ ! -x "$BUILD_TOOLS_DIR/$tool" ]]; then
    echo "Missing Android build tool: $BUILD_TOOLS_DIR/$tool" >&2
    exit 1
  fi
done

if [[ ! -f "$PLATFORM_JAR" ]]; then
  echo "Missing Android platform jar: $PLATFORM_JAR" >&2
  exit 1
fi

rm -rf "$OUT_DIR"
mkdir -p "$GEN_DIR" "$CLASS_DIR" "$DEX_DIR" "$(dirname "$FINAL_APK")" "$HOME/.android"

sed 's/<manifest /<manifest package="com.promptx.app" /' \
  "$APP_DIR/src/main/AndroidManifest.xml" > "$PACKAGED_MANIFEST"

"$BUILD_TOOLS_DIR/aapt2" compile \
  --dir "$APP_DIR/src/main/res" \
  -o "$RES_ZIP"

"$BUILD_TOOLS_DIR/aapt2" link \
  -I "$PLATFORM_JAR" \
  --manifest "$PACKAGED_MANIFEST" \
  --custom-package com.promptx.app \
  --java "$GEN_DIR" \
  --min-sdk-version 26 \
  --target-sdk-version 36 \
  --version-code 1 \
  --version-name 0.1.0 \
  --auto-add-overlay \
  -R "$RES_ZIP" \
  -o "$UNSIGNED_APK"

javac \
  --release 8 \
  -encoding UTF-8 \
  -classpath "$PLATFORM_JAR" \
  -d "$CLASS_DIR" \
  $(find "$APP_DIR/src/main/java" "$GEN_DIR" -name '*.java')

"$BUILD_TOOLS_DIR/d8" \
  --min-api 26 \
  --classpath "$PLATFORM_JAR" \
  --output "$DEX_DIR" \
  $(find "$CLASS_DIR" -name '*.class')

(cd "$DEX_DIR" && zip -q "$UNSIGNED_APK" classes.dex)

if [[ ! -f "$DEBUG_KEYSTORE" ]]; then
  keytool -genkeypair \
    -keystore "$DEBUG_KEYSTORE" \
    -storepass android \
    -keypass android \
    -alias androiddebugkey \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US" >/dev/null
fi

"$BUILD_TOOLS_DIR/zipalign" -f -p 4 "$UNSIGNED_APK" "$ALIGNED_APK"
"$BUILD_TOOLS_DIR/apksigner" sign \
  --ks "$DEBUG_KEYSTORE" \
  --ks-pass pass:android \
  --key-pass pass:android \
  --out "$FINAL_APK" \
  "$ALIGNED_APK"

"$BUILD_TOOLS_DIR/apksigner" verify "$FINAL_APK"
echo "$FINAL_APK"
