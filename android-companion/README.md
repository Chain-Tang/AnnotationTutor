# Tutor Ink (Android preview)

Open-source companion for Tutor's raw-ink recognition. MIT source; Google ML Kit and downloaded models remain under their respective licenses. It binds **127.0.0.1 only**. No cloud recognition endpoint or analytics are included. Model downloads require explicit button presses; after download recognition is local. Pairing tokens are stored in private app storage, excluded from backup, and can be revoked in the app.

Build with JDK 17, Android SDK 35 and Gradle 8.11.1: `gradle :app:assembleDebug`. AGP 8.9.2 and ML Kit 19.0.0 are pinned. The output is `app/build/outputs/apk/debug/app-debug.apk`. Debug signing is for local QA only; production signing must use the release owner's key. No signing keys or SDK license acceptance are included.

1. Install the APK and open Tutor Ink. Explicitly download Chinese and/or English.
2. Start recognition and copy the displayed port and token into Tutor's Android connection dialog.
3. In Tutor select strokes → recognize locally → correct → save/ask.
4. If Android stops the foreground service, restart it. Tutor keeps handwriting and manual transcription available.
5. If Obsidian blocks loopback requests, export a request JSON from Tutor, open Tutor Ink, select that file using Android's file picker, and save the result to Tutor's indicated folder. Return and press read result. The app never assumes direct Vault access.

**Release gate:** Android device, ML Kit download/offline behavior, stylus/palm/touch, foreground/background recovery and PDF regression have not been validated on a physical device. Desktop `isDesktopOnly` stays true. A source build or synthetic test does not satisfy this gate.

Protocol: `tutor-ink-request-v1` → `tutor-ink-result-v1`; request id, SHA-256 ink fingerprint, language and ordered stroke IDs must match. The plugin independently checks that the current ink is unchanged before saving. Payload limit 2 MB, 500 strokes, 100,000 total points, one recognition request at a time. No automatic recognition or automatic model download.
