package dev.momotaro.app;

import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "Momotaro";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register in-tree native plugins before super.onCreate so the
        // Capacitor bridge picks them up during its initial plugin scan.
        registerPlugin(ImmersiveModePlugin.class);
        registerPlugin(DownloadKeepAlivePlugin.class);
        registerPlugin(OfflineFolderPlugin.class);
        registerPlugin(VolumeButtonsPlugin.class);
        super.onCreate(savedInstanceState);

        // Recover from a killed WebView renderer process. Android reclaims the
        // renderer of a backgrounded WebView under memory pressure (most likely
        // when the foregrounded page held a live, GPU-promoted compositing layer
        // — e.g. the Home art-gallery ribbon's infinite animation). The stock
        // BridgeActivity does nothing on that event, so returning to the app
        // shows a dead grey surface and the user must force-close. We detect the
        // event and rebuild the Activity (fresh Bridge + WebView) instead.
        //
        // Returning true from the listener tells Android we've handled the loss
        // and it must NOT tear the whole app process down. Capacitor fans the
        // WebViewClient callback out to registered WebViewListeners and ORs
        // their results (see BridgeWebViewClient.onRenderProcessGone).
        this.bridge.addWebViewListener(new WebViewListener() {
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                boolean didCrash = detail != null && detail.didCrash();
                Log.w(TAG, "WebView renderer gone (didCrash=" + didCrash
                        + "); recreating activity to recover from grey screen.");
                runOnUiThread(() -> {
                    // The dead WebView must be detached and destroyed before we
                    // recreate, otherwise the orphaned view can crash the new
                    // Activity instance when the framework tears it down.
                    try {
                        ViewParent parent = view.getParent();
                        if (parent instanceof ViewGroup) {
                            ((ViewGroup) parent).removeView(view);
                        }
                        view.destroy();
                    } catch (Exception e) {
                        Log.w(TAG, "Failed to tear down dead WebView", e);
                    }
                    recreate();
                });
                return true;
            }
        });
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
