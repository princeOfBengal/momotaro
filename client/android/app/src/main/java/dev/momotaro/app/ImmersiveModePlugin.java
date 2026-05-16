package dev.momotaro.app;

import android.view.View;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * In-tree Capacitor plugin that toggles Android's "sticky immersive" mode.
 * Hides both the status bar (top) and the navigation bar (bottom) for a
 * truly full-screen experience, then restores them on demand. Used by the
 * reader so manga pages aren't fighting the system clock / battery / back
 * indicators for screen real estate.
 *
 * Uses WindowInsetsControllerCompat from androidx.core so the same call
 * compiles down to the API-30+ WindowInsetsController on modern devices
 * and the legacy setSystemUiVisibility flag set on Android 11 and below —
 * we don't need a separate branch.
 *
 * BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE: the bars are hidden by default
 * but a swipe from the screen edge briefly reveals them and they auto-hide
 * again. This matches the Plex / VLC / Netflix reader+player UX and is
 * what users expect from "immersive" — the bars aren't *gone*, they're
 * available on demand without breaking flow.
 *
 * Both methods marshal to the UI thread because anything touching
 * Window / Decor must run there; rejecting silently on the JS side if
 * the Activity is gone is fine — the reader unmount path may fire
 * after the activity is already torn down on configuration changes.
 */
@CapacitorPlugin(name = "ImmersiveMode")
public class ImmersiveModePlugin extends Plugin {

    @PluginMethod
    public void enable(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                View decor = getActivity().getWindow().getDecorView();
                WindowInsetsControllerCompat ctrl =
                    WindowCompat.getInsetsController(getActivity().getWindow(), decor);
                ctrl.setSystemBarsBehavior(
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                ctrl.hide(WindowInsetsCompat.Type.systemBars());
                call.resolve();
            } catch (Exception t) {
                call.reject("Failed to enter immersive mode: " + t.getMessage(), t);
            }
        });
    }

    @PluginMethod
    public void disable(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                View decor = getActivity().getWindow().getDecorView();
                WindowInsetsControllerCompat ctrl =
                    WindowCompat.getInsetsController(getActivity().getWindow(), decor);
                ctrl.show(WindowInsetsCompat.Type.systemBars());
                call.resolve();
            } catch (Exception t) {
                call.reject("Failed to exit immersive mode: " + t.getMessage(), t);
            }
        });
    }
}
