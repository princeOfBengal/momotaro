package dev.momotaro.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * In-tree Capacitor plugin that lets the reader turn pages with the
 * hardware volume keys. The actual KeyEvent interception lives in
 * {@link MainActivity} — only the foreground Activity receives volume
 * key callbacks, so that is the only place the OS will hand them to us.
 * This plugin is the bridge: it holds the enabled flag and forwards a
 * direction event ("up" / "down") to the JS reader, which maps it to
 * next/previous page (honouring the user's reverse-mapping setting).
 *
 * No Android permission is required — observing and consuming volume
 * keys while our own Activity is foreground is unprivileged input. We
 * never touch the audio stream, so MODIFY_AUDIO_SETTINGS is not needed.
 *
 * Lifecycle / safety: interception is inherently foreground-only. When
 * the app is backgrounded the Activity stops receiving key events, so a
 * lingering `active` flag can never hijack volume in another app. The
 * flag is cleared the moment the reader unmounts (the JS side calls
 * disable() from its effect cleanup), which is the path that actually
 * matters for "volume returns to normal outside the reader".
 */
@CapacitorPlugin(name = "VolumeButtons")
public class VolumeButtonsPlugin extends Plugin {

    // Single live instance, set when Capacitor loads the plugin, so the
    // Activity's key handler can reach the flag + event emitter without
    // threading a reference through the bridge on every keypress.
    private static VolumeButtonsPlugin instance;

    // Whether the reader currently wants volume keys intercepted.
    private volatile boolean active = false;

    @Override
    public void load() {
        instance = this;
    }

    @PluginMethod
    public void enable(PluginCall call) {
        active = true;
        call.resolve();
    }

    @PluginMethod
    public void disable(PluginCall call) {
        active = false;
        call.resolve();
    }

    /** True when a key event should be consumed and forwarded to JS. */
    static boolean isActive() {
        return instance != null && instance.active;
    }

    /** Emit a "volumeButton" event with direction "up" or "down" to JS. */
    static void dispatch(String direction) {
        if (instance == null) return;
        JSObject data = new JSObject();
        data.put("direction", direction);
        instance.notifyListeners("volumeButton", data);
    }
}
