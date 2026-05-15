plugins {
  id("com.android.application")
}

import java.util.Properties

val signingPropertiesFile = rootProject.file("signing.properties")
val signingProperties = Properties()
if (signingPropertiesFile.isFile) {
  signingPropertiesFile.inputStream().use(signingProperties::load)
}

android {
  namespace = "com.promptx.app"
  compileSdk = 36

  defaultConfig {
    applicationId = "com.promptx.app"
    minSdk = 26
    targetSdk = 36
    versionCode = 1
    versionName = "0.1.0"
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  signingConfigs {
    create("release") {
      val storeFilePath = signingProperties.getProperty("storeFile", "")
      if (storeFilePath.isNotBlank()) {
        storeFile = rootProject.file(storeFilePath)
        storePassword = signingProperties.getProperty("storePassword")
        keyAlias = signingProperties.getProperty("keyAlias")
        keyPassword = signingProperties.getProperty("keyPassword")
      }
    }
  }

  buildTypes {
    release {
      if (signingPropertiesFile.isFile) {
        signingConfig = signingConfigs.getByName("release")
      }
      isMinifyEnabled = false
    }
  }
}
