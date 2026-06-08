package dev.momotaro.app;

import android.os.Bundle;
import android.view.KeyEvent;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register in-tree native plugins before super.onCreate so the
        // Capacitor bridge picks them up during its initial plugin scan.
        registerPlugin(ImmersiveModePlugin.class);
        registerPlugin(DownloadKeepAlivePlugin.class);
        registerPlugin(OfflineFolderPlugin.class);
        registerPlugin(VolumeButtonsPlugin.class);
        super.onCreate(savedInstanceState);
    }

    // Hardware volume keys: when the reader has opted in (VolumeButtonsPlugin
    // is active) we consume the key and forward a direction to JS so it can
    // turn the page. Returning true suppresses the system volume HUD and the
    // actual volume change. When the plugin is inactive we defer to super so
    // volume behaves normally everywhere outside the reader.
    //
    // getRepeatCount() == 0 means one page turn per physical press — holding
    // the button won't machine-gun through pages. onKeyUp is also consumed for
    // the same keycodes so the system HUD never flashes on key release.
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (VolumeButtonsPlugin.isActive()
                && (keyCode == KeyEvent.KEYCODE_VOLUME_UP
                    || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN)) {
            if (event.getRepeatCount() == 0) {
                VolumeButtonsPlugin.dispatch(
                    keyCode == KeyEvent.KEYCODE_VOLUME_UP ? "up" : "down");
            }
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (VolumeButtonsPlugin.isActive()
                && (keyCode == KeyEvent.KEYCODE_VOLUME_UP
                    || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN)) {
            return true;
        }
        return super.onKeyUp(keyCode, event);
    }
}
