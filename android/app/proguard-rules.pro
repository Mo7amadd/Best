# Xray core (gomobile): Go calls back into these Java classes by name.
-keep class go.** { *; }
-keep class libv2ray.** { *; }
-keep interface libv2ray.** { *; }

# Never keep or print logging calls in release builds (no data in logcat).
-assumenosideeffects class android.util.Log {
    public static int v(...);
    public static int d(...);
    public static int i(...);
}
