package dev.momotaro.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register in-tree native plugins before super.onCreate so the
        // Capacitor bridge picks them up during its initial plugin scan.
        registerPlugin(ImmersiveModePlugin.class);
        registerPlugin(DownloadKeepAlivePlugin.class);
        registerPlugin(OfflineFolderPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
