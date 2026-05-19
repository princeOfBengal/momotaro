package dev.momotaro.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Keeps the JS download queue alive when the user backgrounds the app.
 *
 * Without a foreground service, Android will eventually reclaim the
 * WebView process while it's in the background (Doze, low-memory kills),
 * pausing the JS queue mid-chapter. A foreground service tied to a
 * persistent notification tells Android "this work is user-visible, do
 * not kill it."
 *
 * The plugin itself does no download work — the JS layer
 * (`client/src/api/downloader.js`) still owns the queue, fetch loop,
 * filesystem writes, and IDB persistence. Our only job is to keep the
 * process around.
 *
 * Lifecycle:
 *   - JS calls `start({ title, text })` when the first job begins.
 *   - JS calls `update({ text })` as chapter/page progress changes.
 *   - JS calls `stop()` when the queue drains.
 *
 * `start()` may be called repeatedly with updated text — the service is
 * idempotent and only binds once. `stop()` is also idempotent. The plugin
 * silently no-ops on every method when the notification permission is
 * denied (Android 13+) — the queue still works, it just risks being
 * paused if the app goes to background. We don't throw because UX from
 * the JS side would be confusing.
 */
@CapacitorPlugin(
    name = "DownloadKeepAlive",
    permissions = {
        @com.getcapacitor.annotation.Permission(
            alias = "notifications",
            strings = { Manifest.permission.POST_NOTIFICATIONS }
        )
    }
)
public class DownloadKeepAlivePlugin extends Plugin {

    public static final String CHANNEL_ID   = "momotaro-downloads";
    public static final String EXTRA_TITLE  = "title";
    public static final String EXTRA_TEXT   = "text";
    public static final String EXTRA_ACTION = "action";
    public static final String ACTION_START  = "start";
    public static final String ACTION_UPDATE = "update";
    public static final String ACTION_STOP   = "stop";
    public static final String ACTION_TAKEOVER = "takeover";

    // SharedPreferences slot for the handoff plan + the progress report
    // the Java downloader writes back. Both files are tiny (handful of
    // KB) so we keep them in prefs rather than a separate JSON file —
    // simpler to read atomically from the Service.
    public static final String PREFS_NAME      = "momotaro_keepalive";
    public static final String KEY_PLAN_JSON   = "plan_json";
    public static final String KEY_REPORT_JSON = "report_json";
    // Monotonic counter the JS layer increments every time it pushes a
    // fresh plan. The background worker polls it between pages and aborts
    // when it diverges from the value it started with — this is the
    // "JS context is alive again, hand the queue back" handoff signal.
    public static final String KEY_PLAN_EPOCH  = "plan_epoch";

    @Override
    public void load() {
        ensureChannel(getContext());
    }

    @PluginMethod
    public void start(PluginCall call) {
        String title = call.getString("title", "Momotaro");
        String text  = call.getString("text",  "Downloading chapters…");
        try {
            // POST_NOTIFICATIONS is request-only on Android 13+ and ignored
            // pre-13. We don't gate `start()` on permission state: even if
            // the notification can't display, Android still treats the
            // process as foreground-promoted for the duration of the
            // service, which is what we actually care about.
            Intent intent = new Intent(getContext(), DownloadKeepAliveService.class);
            intent.putExtra(EXTRA_TITLE, title);
            intent.putExtra(EXTRA_TEXT,  text);
            intent.putExtra(EXTRA_ACTION, ACTION_START);
            ContextCompat.startForegroundService(getContext(), intent);
            call.resolve();
        } catch (Exception t) {
            // Don't reject — the queue still runs in JS, just without
            // foreground promotion. Surface the error in a debug log.
            call.resolve(new JSObject().put("warning", String.valueOf(t.getMessage())));
        }
    }

    @PluginMethod
    public void update(PluginCall call) {
        String text = call.getString("text", "Downloading chapters…");
        try {
            Intent intent = new Intent(getContext(), DownloadKeepAliveService.class);
            intent.putExtra(EXTRA_TEXT,  text);
            intent.putExtra(EXTRA_ACTION, ACTION_UPDATE);
            ContextCompat.startForegroundService(getContext(), intent);
            call.resolve();
        } catch (Exception t) {
            call.resolve();
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            Intent intent = new Intent(getContext(), DownloadKeepAliveService.class);
            intent.putExtra(EXTRA_ACTION, ACTION_STOP);
            getContext().startService(intent);
        } catch (Exception ignored) {}
        call.resolve();
    }

    /**
     * Hand a fresh queue plan to the background service. The plan is a
     * compact JSON: server URL, auth token, offline-root subdirectory,
     * encryption flag, and the list of jobs (manga_id, chapter_id,
     * destination dir). Called by the JS downloader on every queue
     * change so the service always has up-to-date state ready for
     * `onTaskRemoved`.
     *
     * Stored in SharedPreferences as a single JSON blob so the service
     * — which may start fresh after a process kill — can read it
     * synchronously on startup.
     */
    @PluginMethod
    public void setPlanState(PluginCall call) {
        try {
            JSObject planData = call.getData();
            // Persist verbatim. Keys we read from the Java service:
            //   - serverUrl (string)
            //   - clientToken (string|null)
            //   - offlineRootSubdir (string)
            //   - encryptionActive (bool)
            //   - jobs: array of { jobId, mangaId, chapterId, extDirSubpath }
            //
            // The epoch counter is bumped on every set so the background
            // worker can tell whether the JS layer has come back online
            // and start releasing its grip on the queue. The worker reads
            // the epoch at start, then polls between pages — when it sees
            // a newer value, it aborts cleanly and writes a 'partial'
            // report so JS resumes from the next page.
            SharedPreferences prefs = getContext()
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            long epoch = prefs.getLong(KEY_PLAN_EPOCH, 0L) + 1L;
            prefs.edit()
                .putString(KEY_PLAN_JSON, planData.toString())
                .putLong(KEY_PLAN_EPOCH, epoch)
                .apply();
            call.resolve();
        } catch (Exception t) {
            call.reject("Failed to store plan: " + t.getMessage(), t);
        }
    }

    /**
     * Drain everything the Java service completed (or failed) while the
     * JS process was gone. Returns the report verbatim and clears it,
     * so a second call returns an empty array.
     *
     * Report shape:
     *   { reports: [{ jobId, status: 'done'|'failed'|'partial',
     *                 error?, progress? }, ...] }
     */
    @PluginMethod
    public void consumeProgressReport(PluginCall call) {
        try {
            SharedPreferences prefs = getContext()
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String raw = prefs.getString(KEY_REPORT_JSON, null);
            JSArray arr = new JSArray();
            if (raw != null && raw.length() > 0) {
                try {
                    JSONArray parsed = new JSONArray(raw);
                    for (int i = 0; i < parsed.length(); i++) {
                        arr.put(parsed.getJSONObject(i));
                    }
                } catch (JSONException ignored) { /* corrupt — drop */ }
                prefs.edit().remove(KEY_REPORT_JSON).apply();
            }
            JSObject ret = new JSObject();
            ret.put("reports", arr);
            call.resolve(ret);
        } catch (Exception t) {
            JSObject ret = new JSObject();
            ret.put("reports", new JSArray());
            call.resolve(ret);
        }
    }

    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("supported", true);
        ret.put("notificationsGranted",
            Build.VERSION.SDK_INT < 33
                ? true
                : ContextCompat.checkSelfPermission(
                      getContext(), Manifest.permission.POST_NOTIFICATIONS
                  ) == PackageManager.PERMISSION_GRANTED);
        call.resolve(ret);
    }

    /** Creates the notification channel on Android 8+; no-op otherwise. */
    public static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel ch = nm.getNotificationChannel(CHANNEL_ID);
        if (ch != null) return;
        ch = new NotificationChannel(
            CHANNEL_ID,
            "Downloads",
            NotificationManager.IMPORTANCE_LOW
        );
        ch.setDescription("Shown while Momotaro is downloading chapters in the background.");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }
}
