// Single source of truth for the app's version on the client side.
// Must be kept in sync with `versionName` in [client/android/app/build.gradle]
// when releasing a new APK — mismatched versions show the update banner to
// users who are already on the latest. The release checklist in
// BUILD_ANDROID.md calls this out explicitly.
export const APP_VERSION = '1.15.0';
