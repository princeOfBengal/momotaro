package dev.momotaro.app;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Headless foreground service whose only job is to hold the app's process
 * in the "foreground" cgroup while a JS-side download is in progress.
 * The Java side performs no download work — see DownloadKeepAlivePlugin
 * for the lifecycle docstring.
 *
 * The notification is required (Android won't let a service stay
 * foreground without one). We tap into MainActivity so opening the
 * notification brings the user back into the running app rather than a
 * blank launcher.
 *
 * Type is `dataSync` because that's the right semantic for "transferring
 * user data over the network" and is permitted without the more
 * restrictive `mediaPlayback` / `location` permissions. We declare the
 * matching permission and `foregroundServiceType` in AndroidManifest.xml.
 */
public class DownloadKeepAliveService extends Service {

    public static final int NOTIFICATION_ID = 0xD107;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // Background download worker. Spawned from `onTaskRemoved` when the
    // user swipes the app away — at that point the WebView is gone but
    // the foreground service keeps the process alive long enough for
    // this thread to drain the queue.
    private Thread workerThread = null;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getStringExtra(DownloadKeepAlivePlugin.EXTRA_ACTION) : null;
        if (DownloadKeepAlivePlugin.ACTION_STOP.equals(action)) {
            stopWorkerIfRunning();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }

        DownloadKeepAlivePlugin.ensureChannel(this);
        String title = intent != null ? intent.getStringExtra(DownloadKeepAlivePlugin.EXTRA_TITLE) : null;
        String text  = intent != null ? intent.getStringExtra(DownloadKeepAlivePlugin.EXTRA_TEXT)  : null;
        if (title == null) title = "Momotaro";
        if (text  == null) text  = "Downloading chapters…";

        Notification n = buildNotification(this, title, text);
        if (Build.VERSION.SDK_INT >= 29) {
            // Android 10+: explicitly declare the service type so the OS
            // allows the foreground promotion under the modern background-
            // execution rules.
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }

        // If we were started by the takeover signal (`onTaskRemoved` flow)
        // and there's a plan, start the background worker. Otherwise the
        // service is just here to hold the process foreground while the
        // JS-side queue runs.
        if (DownloadKeepAlivePlugin.ACTION_TAKEOVER.equals(action)) {
            startWorkerIfNeeded();
        }
        // START_NOT_STICKY: if the OS kills us under extreme memory
        // pressure, don't auto-restart — the JS layer rehydrates the
        // queue from IndexedDB on the next app launch and decides
        // whether to bring the service back.
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // User swiped the app away from recents. The Activity (and its
        // WebView, and our JS context) is being destroyed — but the
        // foreground service is allowed to keep running, so we kick off
        // a Java-side download worker to finish whatever was queued.
        super.onTaskRemoved(rootIntent);
        Intent takeover = new Intent(this, DownloadKeepAliveService.class);
        takeover.putExtra(DownloadKeepAlivePlugin.EXTRA_ACTION,
                          DownloadKeepAlivePlugin.ACTION_TAKEOVER);
        // Re-issue startForeground in the takeover path so the service
        // promotes itself again — onTaskRemoved on some OEM builds can
        // demote us if we don't.
        startService(takeover);
    }

    @Override
    public void onDestroy() {
        stopWorkerIfRunning();
        super.onDestroy();
    }

    private void startWorkerIfNeeded() {
        if (workerThread != null && workerThread.isAlive()) return;
        workerThread = new Thread(this::runWorker, "momotaro-download-worker");
        workerThread.setDaemon(true);
        workerThread.start();
    }

    private void stopWorkerIfRunning() {
        Thread t = workerThread;
        workerThread = null;
        if (t != null) t.interrupt();
    }

    // ── Background worker ──────────────────────────────────────────────
    //
    // Reads the plan written by the JS layer via setPlanState, then for
    // each job fetches the chapter's page list and downloads any pages
    // that aren't already on disk. Writes progress reports back to
    // SharedPreferences so the JS layer can reconcile when it relaunches.
    //
    // Encryption: when the plan has `encryptionActive: true` we refuse
    // to do anything — we don't ship the in-memory AES key off-process
    // (see offlineCrypto.js docstring), so the bytes we'd write would be
    // plaintext in an otherwise-encrypted store. The JS pump picks up
    // those jobs again on the next foreground launch.
    private void runWorker() {
        SharedPreferences prefs = getSharedPreferences(
            DownloadKeepAlivePlugin.PREFS_NAME, Context.MODE_PRIVATE);
        String planRaw = prefs.getString(DownloadKeepAlivePlugin.KEY_PLAN_JSON, null);
        if (planRaw == null) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return;
        }
        // Snapshot the plan epoch at start. If the JS layer comes back
        // alive and pushes a new plan, this value diverges from the live
        // SharedPreferences value and we abort cleanly so JS pump can
        // take over without a write-race on the same files.
        final long startEpoch = prefs.getLong(DownloadKeepAlivePlugin.KEY_PLAN_EPOCH, 0L);

        JSONObject plan;
        try { plan = new JSONObject(planRaw); }
        catch (JSONException e) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return;
        }

        if (plan.optBoolean("encryptionActive", false)) {
            // Refuse — see method docstring above.
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return;
        }

        String  serverUrl   = plan.optString("serverUrl", "");
        String  clientToken = plan.isNull("clientToken") ? null : plan.optString("clientToken", null);
        JSONArray jobs      = plan.optJSONArray("jobs");
        if (serverUrl.isEmpty() || jobs == null || jobs.length() == 0) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return;
        }

        // External-files dir: the same root the JS layer's
        // `Directory.External` resolves to. We don't have to recompute the
        // subdir — extDirSubpath is the full relative path JS encoded.
        File baseDir = getExternalFilesDir(null);
        if (baseDir == null) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return;
        }

        List<JSONObject> reports = new ArrayList<>();
        for (int i = 0; i < jobs.length(); i++) {
            if (Thread.currentThread().isInterrupted()) break;
            // Bail the moment JS publishes a new plan — that's our signal
            // that the WebView is alive again and the JS pump is about to
            // start picking up jobs. Aborting here gets every still-queued
            // job back to JS without a write-race.
            if (planEpochChanged(prefs, startEpoch)) break;
            JSONObject job = jobs.optJSONObject(i);
            if (job == null) continue;
            long jobId    = job.optLong("jobId", -1);
            long chapterId = job.optLong("chapterId", -1);
            String dirSub = job.optString("extDirSubpath", "");
            if (jobId < 0 || chapterId < 0 || dirSub.isEmpty()) continue;

            updateNotification("Downloading chapter " + chapterId + "…");

            try {
                int wrote = runOneJob(serverUrl, clientToken, baseDir, dirSub, chapterId,
                                      prefs, startEpoch);
                reports.add(buildReport(jobId, "done", null,
                    new int[]{wrote, wrote}));
            } catch (HandoffAbortException ha) {
                // JS bumped the epoch mid-chapter. Report 'partial' so the
                // job goes back to 'queued' and the JS pump's
                // page-existence check picks up where we left off.
                reports.add(buildReport(jobId, "partial",
                    "handoff to JS pump", null));
                break;
            } catch (InterruptedException ie) {
                // Service shut down mid-job. Persist partial state so the
                // JS reconcile leaves the job 'queued' and the next pump
                // resumes (the page-existence check skips already-written
                // bytes).
                reports.add(buildReport(jobId, "partial",
                    "service interrupted", null));
                Thread.currentThread().interrupt();
                break;
            } catch (Exception e) {
                reports.add(buildReport(jobId, "failed",
                    String.valueOf(e.getMessage()), null));
            }
        }

        // Merge with any pre-existing report (e.g. previous swipe-away
        // session that never got reconciled) so we don't drop history.
        String existingRaw = prefs.getString(DownloadKeepAlivePlugin.KEY_REPORT_JSON, null);
        JSONArray merged = new JSONArray();
        if (existingRaw != null) {
            try {
                JSONArray prev = new JSONArray(existingRaw);
                for (int i = 0; i < prev.length(); i++) merged.put(prev.getJSONObject(i));
            } catch (JSONException ignored) {}
        }
        for (JSONObject r : reports) merged.put(r);
        prefs.edit().putString(
            DownloadKeepAlivePlugin.KEY_REPORT_JSON, merged.toString()).apply();

        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private JSONObject buildReport(long jobId, String status, String error, int[] progress) {
        JSONObject r = new JSONObject();
        try {
            r.put("jobId", jobId);
            r.put("status", status);
            if (error != null) r.put("error", error);
            if (progress != null && progress.length >= 2) {
                JSONObject p = new JSONObject();
                p.put("current", progress[0]);
                p.put("total",   progress[1]);
                r.put("progress", p);
            }
        } catch (JSONException ignored) {}
        return r;
    }

    /**
     * Download a single chapter: GET /api/chapters/:id/pages to enumerate
     * pages, then GET /api/pages/:id/image for each one that isn't already
     * on disk. Returns the number of pages handled.
     *
     * Polls the plan-epoch counter between pages — when JS pushes a new
     * plan we abort mid-chapter via HandoffAbortException so the next
     * page write doesn't race with the JS pump that's about to start.
     */
    private int runOneJob(String serverUrl, String clientToken,
                          File baseDir, String dirSub, long chapterId,
                          SharedPreferences prefs, long startEpoch)
            throws Exception {
        File chDir = new File(baseDir, dirSub);
        if (!chDir.exists() && !chDir.mkdirs()) {
            throw new RuntimeException("could not create " + chDir.getAbsolutePath());
        }

        // List pages — the response is `{ data: [{ id, page_index, filename, ... }, ...] }`
        JSONObject pagesResp = httpGetJson(
            serverUrl + "/api/chapters/" + chapterId + "/pages",
            clientToken);
        JSONArray pages = pagesResp.optJSONArray("data");
        if (pages == null) throw new RuntimeException("no pages array in response");

        int total = pages.length();
        for (int i = 0; i < total; i++) {
            if (Thread.currentThread().isInterrupted()) {
                throw new InterruptedException("worker interrupted");
            }
            if (planEpochChanged(prefs, startEpoch)) {
                throw new HandoffAbortException();
            }
            JSONObject p = pages.getJSONObject(i);
            long pageId   = p.optLong("id", -1);
            int  index    = p.optInt("page_index", i);
            String fname  = p.optString("filename", index + ".jpg");
            String ext    = extensionFor(fname);
            String pad    = String.format("%04d", index);
            File out      = new File(chDir, pad + "." + ext);
            if (out.exists() && out.length() > 0) continue; // already downloaded

            String url = serverUrl + "/api/pages/" + pageId + "/image"
                + (clientToken != null ? "?t=" + clientToken : "");
            httpGetToFile(url, clientToken, out);

            if (i % 4 == 0) {
                updateNotification("Chapter " + chapterId + ": page " + (i + 1) + "/" + total);
            }
        }
        return total;
    }

    /** True when the JS layer has pushed a new plan since this worker started. */
    private static boolean planEpochChanged(SharedPreferences prefs, long startEpoch) {
        return prefs.getLong(DownloadKeepAlivePlugin.KEY_PLAN_EPOCH, startEpoch) != startEpoch;
    }

    /** Thrown when the worker detects the JS pump wants to take over. */
    private static class HandoffAbortException extends Exception {
        HandoffAbortException() { super("handoff to JS pump"); }
    }

    private static String extensionFor(String filename) {
        if (filename == null) return "jpg";
        int dot = filename.lastIndexOf('.');
        if (dot < 0 || dot == filename.length() - 1) return "jpg";
        String ext = filename.substring(dot + 1).toLowerCase();
        switch (ext) {
            case "jpg": case "jpeg": case "png": case "webp":
            case "gif": case "avif":
                return ext;
            default:
                return "jpg";
        }
    }

    private static JSONObject httpGetJson(String url, String token) throws Exception {
        HttpURLConnection conn = openConnection(url, token);
        try {
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) throw new RuntimeException("HTTP " + code + " for " + url);
            StringBuilder sb = new StringBuilder();
            try (InputStream is = conn.getInputStream()) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = is.read(buf)) > 0) sb.append(new String(buf, 0, n, "UTF-8"));
            }
            return new JSONObject(sb.toString());
        } finally {
            conn.disconnect();
        }
    }

    private static void httpGetToFile(String url, String token, File out) throws Exception {
        HttpURLConnection conn = openConnection(url, token);
        try {
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) throw new RuntimeException("HTTP " + code + " for " + url);
            File tmp = new File(out.getAbsolutePath() + ".part");
            try (InputStream is = conn.getInputStream();
                 FileOutputStream fos = new FileOutputStream(tmp)) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = is.read(buf)) > 0) {
                    if (Thread.currentThread().isInterrupted()) {
                        throw new InterruptedException("worker interrupted");
                    }
                    fos.write(buf, 0, n);
                }
            }
            // Atomic-ish swap. If rename fails (different filesystem),
            // fall back to a copy by re-trying writeAll directly — but
            // realistically every Android device puts the cache and the
            // target on the same external-files volume.
            if (!tmp.renameTo(out)) {
                // Best-effort: delete tmp, rethrow.
                tmp.delete();
                throw new RuntimeException("rename failed: " + tmp.getName() + " → " + out.getName());
            }
        } finally {
            conn.disconnect();
        }
    }

    private static HttpURLConnection openConnection(String url, String token) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(15_000);
        conn.setReadTimeout(30_000);
        conn.setRequestMethod("GET");
        if (token != null) conn.setRequestProperty("Authorization", "Bearer " + token);
        conn.setRequestProperty("Accept", "*/*");
        return conn;
    }

    private void updateNotification(String text) {
        try {
            Notification n = buildNotification(this, "Momotaro", text);
            ((android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE))
                .notify(NOTIFICATION_ID, n);
        } catch (Exception ignored) {}
    }

    private static Notification buildNotification(Context ctx, String title, String text) {
        Intent contentIntent = new Intent(ctx, MainActivity.class);
        contentIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, contentIntent, flags);

        return new NotificationCompat.Builder(ctx, DownloadKeepAlivePlugin.CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setContentIntent(pi)
            .build();
    }
}
