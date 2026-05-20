package dev.momotaro.app;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Bridges the JS offline-storage layer to Android's Storage Access Framework.
 *
 * The user picks a tree-URI folder via the system document picker
 * ({@link Intent#ACTION_OPEN_DOCUMENT_TREE}); the resulting URI is
 * persisted via {@link ContentResolver#takePersistableUriPermission} so
 * the grant survives reboots. Every read/write op below resolves the
 * stored URI lazily — if the user revokes the grant (rare; only happens
 * via "Clear data" or by manually removing it from Settings → Apps →
 * Permissions), the next call returns an error JS surfaces as "folder
 * configured but no longer accessible — please re-pick."
 *
 * The {@code <img src>} hot path goes through
 * {@link #prepareFileForWebView}, which copies a single file from the
 * SAF tree into the app's private cache directory and returns a plain
 * {@code file://} URL Capacitor's {@code convertFileSrc} can rewrite into
 * the WebView's loopback shim. Without this, {@code content://} URIs
 * can't be loaded by the WebView at all in Capacitor 8.
 *
 * Threading: SAF I/O is dispatched on the Capacitor bridge's executor
 * (default plugin behavior). DocumentFile operations talk to the
 * ContentResolver which can be slow for deeply-nested paths, so we
 * resolve relative paths segment-by-segment rather than via
 * {@link DocumentFile#findFile(String)} on every operation.
 */
@CapacitorPlugin(name = "OfflineFolder")
public class OfflineFolderPlugin extends Plugin {

    public static final String PREFS_NAME    = "momotaro_offline_folder";
    public static final String KEY_TREE_URI  = "tree_uri";

    @PluginMethod
    public void getStatus(PluginCall call) {
        Uri tree = readSavedTreeUri();
        JSObject ret = new JSObject();
        if (tree == null || !hasPersistedPermission(tree)) {
            ret.put("configured", false);
            ret.put("treeUri",    null);
            ret.put("displayName", null);
            call.resolve(ret);
            return;
        }
        DocumentFile root = DocumentFile.fromTreeUri(getContext(), tree);
        ret.put("configured",  true);
        ret.put("treeUri",     tree.toString());
        ret.put("displayName", deriveDisplayPath(tree, root));
        call.resolve(ret);
    }

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION
            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        );
        startActivityForResult(call, intent, "onFolderPicked");
    }

    /**
     * Result handler bound by name in {@link #pickFolder}. Called when the
     * user finishes (or cancels) the SAF document-tree picker.
     */
    @ActivityCallback
    private void onFolderPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != android.app.Activity.RESULT_OK
            || result.getData() == null
            || result.getData().getData() == null) {
            JSObject ret = new JSObject();
            ret.put("configured", false);
            ret.put("cancelled",  true);
            call.resolve(ret);
            return;
        }
        Uri tree = result.getData().getData();
        // Persist the grant. takePersistableUriPermission throws
        // SecurityException if the URI didn't come from a SAF intent
        // with FLAG_GRANT_PERSISTABLE — we asked for the flag above so
        // this should never throw, but catch defensively.
        try {
            getContext().getContentResolver().takePersistableUriPermission(
                tree,
                Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            );
        } catch (SecurityException se) {
            call.reject("Could not persist folder permission: " + se.getMessage(), se);
            return;
        }
        SharedPreferences prefs = getContext()
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putString(KEY_TREE_URI, tree.toString()).apply();

        DocumentFile root = DocumentFile.fromTreeUri(getContext(), tree);
        JSObject ret = new JSObject();
        ret.put("configured",  true);
        ret.put("treeUri",     tree.toString());
        ret.put("displayName", deriveDisplayPath(tree, root));
        call.resolve(ret);
    }

    @PluginMethod
    public void clearFolder(PluginCall call) {
        Uri tree = readSavedTreeUri();
        if (tree != null) {
            try {
                getContext().getContentResolver()
                    .releasePersistableUriPermission(
                        tree,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    );
            } catch (Exception ignored) { /* best-effort */ }
        }
        SharedPreferences prefs = getContext()
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().remove(KEY_TREE_URI).apply();
        call.resolve();
    }

    /** Idempotent mkdir-p for a relative `a/b/c` path under the tree URI. */
    @PluginMethod
    public void ensureDir(PluginCall call) {
        String relPath = call.getString("path", "");
        try {
            DocumentFile dir = resolveOrCreateDir(relPath);
            JSObject ret = new JSObject();
            ret.put("uri", dir.getUri().toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("ensureDir failed: " + e.getMessage(), e);
        }
    }

    /**
     * Write `data` (base64) to `path` under the tree URI. Parent dirs are
     * created as needed. If a file already exists at the path it's
     * overwritten in place — DocumentFile doesn't expose atomic rename,
     * so this is the best we can do; partial writes leave a truncated
     * file on disk which the page-existence check skips on retry.
     */
    @PluginMethod
    public void writeFile(PluginCall call) {
        String relPath = call.getString("path", "");
        String b64     = call.getString("data", "");
        if (relPath == null || relPath.isEmpty()) {
            call.reject("path required");
            return;
        }
        try {
            byte[] bytes = Base64.decode(b64, Base64.NO_WRAP);
            DocumentFile parent = resolveOrCreateDir(parentOf(relPath));
            String fname = basename(relPath);
            DocumentFile file = parent.findFile(fname);
            if (file != null) file.delete();
            // mimeType is irrelevant for raw byte storage; we use the
            // extension's MIME hint where possible so other apps that
            // browse the folder show the right thumbnails.
            file = parent.createFile(mimeFor(fname), fname);
            if (file == null) throw new Exception("createFile returned null for " + fname);
            try (OutputStream os = getContext().getContentResolver().openOutputStream(file.getUri(), "w")) {
                if (os == null) throw new Exception("openOutputStream returned null");
                os.write(bytes);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("writeFile failed: " + e.getMessage(), e);
        }
    }

    /** Read `path` and return its contents as base64. Small files only. */
    @PluginMethod
    public void readFile(PluginCall call) {
        String relPath = call.getString("path", "");
        try {
            DocumentFile file = resolveFile(relPath);
            if (file == null) { call.reject("file not found: " + relPath); return; }
            byte[] bytes;
            try (InputStream is = getContext().getContentResolver().openInputStream(file.getUri())) {
                if (is == null) throw new Exception("openInputStream returned null");
                java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
                byte[] chunk = new byte[16384];
                int n;
                while ((n = is.read(chunk)) > 0) buf.write(chunk, 0, n);
                bytes = buf.toByteArray();
            }
            JSObject ret = new JSObject();
            ret.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("readFile failed: " + e.getMessage(), e);
        }
    }

    /**
     * Enumerate the immediate children of a directory under the tree
     * URI. Returns an array of `{ name, isDirectory }` entries. Powers
     * the filesystem-as-source-of-truth chapter scanner — without this,
     * IDB is the only way to know what's downloaded, and a "Clear data"
     * wipes the app's awareness of bytes that are still on disk.
     *
     * Resolves to `{ entries: [] }` when the directory doesn't exist
     * (callers treat absence + empty identically). Errors only when the
     * tree URI itself is no longer accessible — in which case the user
     * needs to re-pick the folder.
     */
    @PluginMethod
    public void listFiles(PluginCall call) {
        String relPath = call.getString("path", "");
        try {
            DocumentFile dir = resolveFile(relPath);
            JSArray entries = new JSArray();
            if (dir != null && dir.isDirectory()) {
                for (DocumentFile child : dir.listFiles()) {
                    JSObject entry = new JSObject();
                    entry.put("name",        child.getName());
                    entry.put("isDirectory", child.isDirectory());
                    entries.put(entry);
                }
            }
            JSObject ret = new JSObject();
            ret.put("entries", entries);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("listFiles failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void exists(PluginCall call) {
        String relPath = call.getString("path", "");
        DocumentFile file = resolveFile(relPath);
        JSObject ret = new JSObject();
        ret.put("exists", file != null && file.exists());
        call.resolve(ret);
    }

    /**
     * Delete a file or directory tree. SAF doesn't expose `rm -rf` so we
     * walk children recursively. Best-effort: a missing path resolves
     * silently because callers retry-delete on stale state.
     */
    @PluginMethod
    public void deletePath(PluginCall call) {
        String relPath = call.getString("path", "");
        boolean recursive = call.getBoolean("recursive", false);
        try {
            DocumentFile node = resolveFile(relPath);
            if (node == null) { call.resolve(); return; }
            if (node.isDirectory() && recursive) {
                deleteTree(node);
            } else {
                node.delete();
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("deletePath failed: " + e.getMessage(), e);
        }
    }

    /**
     * Copy the file at `path` (relative to the tree URI) into the app's
     * private cache directory and return a Capacitor-friendly URL the
     * WebView can render. Used by `<img src>` in the reader and library
     * tiles — content:// can't be loaded directly, file:// from
     * Directory.Cache can. The copy is cached: subsequent calls for the
     * same path reuse the already-written cache file when it exists and
     * its size matches the source.
     */
    @PluginMethod
    public void prepareFileForWebView(PluginCall call) {
        String relPath = call.getString("path", "");
        try {
            DocumentFile file = resolveFile(relPath);
            if (file == null) { call.reject("file not found: " + relPath); return; }

            // Mirror the relative path under our private cache dir so the
            // mapping is deterministic and a stale cached copy is just
            // overwritten next time.
            File cacheRoot = new File(getContext().getCacheDir(), "offline-mirror");
            File outFile   = new File(cacheRoot, relPath);
            File parent    = outFile.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) {
                throw new Exception("could not create cache dir: " + parent.getAbsolutePath());
            }

            long srcSize = file.length();
            if (!outFile.exists() || outFile.length() != srcSize) {
                try (InputStream  is = getContext().getContentResolver().openInputStream(file.getUri());
                     FileOutputStream fos = new FileOutputStream(outFile)) {
                    if (is == null) throw new Exception("openInputStream returned null");
                    byte[] chunk = new byte[16384];
                    int n;
                    while ((n = is.read(chunk)) > 0) fos.write(chunk, 0, n);
                }
            }
            JSObject ret = new JSObject();
            ret.put("fileUrl", Uri.fromFile(outFile).toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("prepareFileForWebView failed: " + e.getMessage(), e);
        }
    }

    /**
     * Wipe the entire offline-mirror cache. Called when the user picks a
     * new folder or clears the offline store — otherwise stale cached
     * pages from the previous folder would still resolve.
     */
    @PluginMethod
    public void clearCache(PluginCall call) {
        File cacheRoot = new File(getContext().getCacheDir(), "offline-mirror");
        if (cacheRoot.exists()) deleteJavaFile(cacheRoot);
        call.resolve();
    }

    // ── Internals ──────────────────────────────────────────────────────────

    private Uri readSavedTreeUri() {
        SharedPreferences prefs = getContext()
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String s = prefs.getString(KEY_TREE_URI, null);
        return (s == null || s.isEmpty()) ? null : Uri.parse(s);
    }

    private boolean hasPersistedPermission(Uri uri) {
        for (UriPermission p : getContext().getContentResolver().getPersistedUriPermissions()) {
            if (uri.equals(p.getUri()) && (p.isReadPermission() || p.isWritePermission())) return true;
        }
        return false;
    }

    /** Best-effort human path. Falls back to the URI string when SAF doesn't expose docId. */
    private String deriveDisplayPath(Uri tree, DocumentFile root) {
        try {
            String docId = DocumentsContract.getTreeDocumentId(tree);
            if (docId != null && docId.contains(":")) {
                String[] parts = docId.split(":", 2);
                String storage = "primary".equals(parts[0]) ? "Internal storage" : parts[0];
                return storage + (parts.length > 1 && !parts[1].isEmpty()
                    ? "/" + parts[1]
                    : "");
            }
        } catch (Exception ignored) {}
        return root != null && root.getName() != null ? root.getName() : tree.toString();
    }

    private static String parentOf(String relPath) {
        int i = relPath.lastIndexOf('/');
        return i < 0 ? "" : relPath.substring(0, i);
    }

    private static String basename(String relPath) {
        int i = relPath.lastIndexOf('/');
        return i < 0 ? relPath : relPath.substring(i + 1);
    }

    /** Resolve `a/b/c` to a DocumentFile, creating each missing segment as a dir. */
    private DocumentFile resolveOrCreateDir(String relPath) throws Exception {
        Uri tree = readSavedTreeUri();
        if (tree == null) throw new Exception("no folder configured");
        DocumentFile node = DocumentFile.fromTreeUri(getContext(), tree);
        if (node == null) throw new Exception("tree URI not accessible — re-pick folder");
        if (relPath == null || relPath.isEmpty()) return node;
        for (String seg : relPath.split("/")) {
            if (seg.isEmpty()) continue;
            DocumentFile next = node.findFile(seg);
            if (next == null || !next.isDirectory()) {
                if (next != null) next.delete(); // collision with a file of the same name
                next = node.createDirectory(seg);
                if (next == null) throw new Exception("could not createDirectory: " + seg);
            }
            node = next;
        }
        return node;
    }

    /** Resolve `a/b/c.jpg` to a DocumentFile, or null if any segment is missing. */
    private DocumentFile resolveFile(String relPath) {
        try {
            Uri tree = readSavedTreeUri();
            if (tree == null) return null;
            DocumentFile node = DocumentFile.fromTreeUri(getContext(), tree);
            if (node == null) return null;
            if (relPath == null || relPath.isEmpty()) return node;
            for (String seg : relPath.split("/")) {
                if (seg.isEmpty()) continue;
                node = node.findFile(seg);
                if (node == null) return null;
            }
            return node;
        } catch (Exception e) {
            return null;
        }
    }

    private static void deleteTree(DocumentFile node) {
        if (node == null) return;
        if (node.isDirectory()) {
            for (DocumentFile child : node.listFiles()) deleteTree(child);
        }
        node.delete();
    }

    private static void deleteJavaFile(File f) {
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteJavaFile(k);
        }
        f.delete();
    }

    /** Lightweight MIME guess for createFile. Falls back to octet-stream. */
    private static String mimeFor(String name) {
        String lower = name == null ? "" : name.toLowerCase();
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".png"))  return "image/png";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".gif"))  return "image/gif";
        if (lower.endsWith(".avif")) return "image/avif";
        if (lower.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }
}
