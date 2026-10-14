plugins { id("com.android.application") }
android {
    namespace = "org.tutor.ink"
    compileSdk = 35
    defaultConfig { applicationId = "org.tutor.ink"; minSdk = 23; targetSdk = 35; versionCode = 1; versionName = "0.1.0-preview" }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
}
dependencies { implementation("com.google.mlkit:digital-ink-recognition:19.0.0") }
