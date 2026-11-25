package buzz.armada.app;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.util.Size;
import android.webkit.MimeTypeMap;

import androidx.annotation.RequiresApi;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The composer's recent-media grid: lists the device's newest photos and videos
 * and renders their thumbnails, so the attach sheet can show a camera roll the
 * way Signal and Discord do instead of bouncing through the system picker for
 * every photo.
 *
 * <p>Only METADATA and thumbnails cross the bridge. A thumbnail is written to
 * the app cache and handed back as a path the WebView loads through
 * Capacitor's file server, and a picked item's bytes are fetched by the
 * WebView straight from its content:// URI (Capacitor's
 * {@code _capacitor_content_} route) — never base64 through a plugin result,
 * which would re-serialize every byte of a video.
 *
 * <p>Access is whatever the user granted: all media, or on Android 14+ only
 * the items they selected ({@code READ_MEDIA_VISUAL_USER_SELECTED}), in which
 * case MediaStore simply returns those. Re-requesting in the limited state is
 * how the user changes the selection.
 *
 * <p>It also writes the other way: {@link #beginSave} puts a saved photo or
 * video into the gallery's own collections, which needs no grant at all.
 */
@CapacitorPlugin(
    name = "MediaGallery",
    permissions = {
        @Permission(alias = "legacy", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }),
        @Permission(alias = "media", strings = { "android.permission.READ_MEDIA_IMAGES", "android.permission.READ_MEDIA_VIDEO" }),
        @Permission(alias = "selected", strings = { "android.permission.READ_MEDIA_VISUAL_USER_SELECTED" }),
    }
)
public class MediaGalleryPlugin extends Plugin {
    private static final int THUMB_PX = 320;
    private static final int MAX_CACHED_THUMBS = 600;

    /**
     * Thumbnail work runs here, not on Capacitor's plugin thread: that thread is
     * shared by every plugin — ArmadaDb included — and a screenful of decodes
     * queued on it would stall the store behind them.
     */
    private final ExecutorService io = Executors.newFixedThreadPool(3);

    private SaveStaging saves;

    @Override
    public void load() {
        saves = new SaveStaging(new File(getContext().getCacheDir(), "pending-saves"));
        io.execute(this::trimThumbCache);
        io.execute(saves::clearStale);
    }

    @Override
    protected void handleOnDestroy() {
        io.shutdownNow();
    }

    @PluginMethod
    public void checkAccess(PluginCall call) {
        call.resolve(accessResult());
    }

    @PluginMethod
    public void requestAccess(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 34) {
            // Both together: asking for READ_MEDIA_* alone on 14+ skips the
            // "Select photos" option and offers only all-or-nothing.
            requestPermissionForAliases(new String[] { "media", "selected" }, call, "accessCallback");
        } else if (Build.VERSION.SDK_INT >= 33) {
            requestPermissionForAlias("media", call, "accessCallback");
        } else {
            requestPermissionForAlias("legacy", call, "accessCallback");
        }
    }

    @PermissionCallback
    private void accessCallback(PluginCall call) {
        call.resolve(accessResult());
    }

    /** The app's system settings page, for a user who denied access for good. */
    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    /** Newest-first photos and videos: `{ items: [{ id, uri, mime, name, size, video, width, height, duration, modified }] }`. */
    @PluginMethod
    public void list(PluginCall call) {
        int limit = Math.max(1, Math.min(call.getInt("limit", 60), 500));
        int offset = Math.max(0, call.getInt("offset", 0));
        if (!"full".equals(access()) && !"limited".equals(access())) {
            call.reject("Media access not granted", "denied");
            return;
        }
        io.execute(() -> {
            try {
                JSObject result = query(limit, offset);
                answer(() -> call.resolve(result));
            } catch (Exception e) {
                answer(() -> call.reject("Could not list media", e));
            }
        });
    }

    /**
     * A cached JPEG thumbnail for one item: `{ path }`.
     *
     * <p>The item's URI is rebuilt here from its MediaStore id rather than taken
     * from the caller, so this reads only gallery items — never whatever other
     * content:// URI the app itself can open — and only under the same grant
     * {@link #list} requires. The cache key names the collection as well as the
     * id, so one item's thumbnail can never be stored under another's name.
     */
    @PluginMethod
    public void thumbnail(PluginCall call) {
        Long id = longArg(call, "id");
        boolean video = Boolean.TRUE.equals(call.getBoolean("video", false));
        Long modifiedArg = longArg(call, "modified");
        long modified = modifiedArg != null ? modifiedArg : 0L;
        if (id == null || id < 0) {
            call.reject("id is required");
            return;
        }
        if (!"full".equals(access()) && !"limited".equals(access())) {
            call.reject("Media access not granted", "denied");
            return;
        }
        Uri uri = ContentUris.withAppendedId(
            video ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI : MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id);
        io.execute(() -> {
            try {
                File out = new File(thumbDir(), (video ? "v" : "i") + id + "-" + modified + ".jpg");
                if (!out.exists()) writeThumbnail(uri, id, video, out);
                JSObject result = new JSObject();
                result.put("path", out.getAbsolutePath());
                answer(() -> call.resolve(result));
            } catch (Exception e) {
                answer(() -> call.reject("Could not load thumbnail", e));
            }
        });
    }

    /**
     * Save bytes where the user looks for them: an image into Pictures/Armada,
     * a video into Movies/Armada, audio into Music/Armada (the gallery and
     * music apps' own collections), anything else into Download/Armada.
     *
     * <p>The bytes arrive in pieces — {@code beginSave} → {@code { id }},
     * {@code appendSave({ id, data })} (base64) per piece, {@code finishSave({ id })}
     * → {@code { location }}, a folder name for the confirmation message — and
     * are staged in the cache, so no call ever holds a whole video in the heap.
     * The staging file is named by an id minted here, never a caller's path.
     *
     * <p>API 29+ goes through MediaStore, which needs no storage permission
     * and renames on collision. Older devices write to the app's external
     * files dir (also permission-free) and ask the scanner to index it.
     */
    @PluginMethod
    public void beginSave(PluginCall call) {
        String filename = call.getString("filename");
        if (filename == null || filename.isEmpty()) {
            call.reject("filename is required");
            return;
        }
        // The caller sanitizes too; MediaStore would reject a separator anyway.
        String name = filename.replaceAll("[/\\\\]", "_");
        String id;
        try {
            id = saves.begin(name, mediaMime(call.getString("mime")));
        } catch (Exception e) {
            call.reject("Could not save the file", e);
            return;
        }
        JSObject result = new JSObject();
        result.put("id", id);
        call.resolve(result);
    }

    @PluginMethod
    public void appendSave(PluginCall call) {
        SaveStaging.Pending save = saves.get(call.getString("id"));
        String data = call.getString("data");
        if (save == null || data == null) {
            call.reject("Unknown save or missing data");
            return;
        }
        io.execute(() -> {
            // Pieces are appended in order: the caller awaits each before the next.
            try (OutputStream os = new FileOutputStream(save.staged, true)) {
                os.write(Base64.decode(data, Base64.DEFAULT));
                answer(call::resolve);
            } catch (Exception e) {
                saves.discard(call.getString("id"));
                answer(() -> call.reject("Could not save the file", e));
            }
        });
    }

    @PluginMethod
    public void finishSave(PluginCall call) {
        SaveStaging.Pending save = saves.take(call.getString("id"));
        if (save == null) {
            call.reject("Unknown save");
            return;
        }
        io.execute(() -> {
            try {
                String location = Build.VERSION.SDK_INT >= 29
                    ? saveMediaStore(save.name, save.mime, save.staged)
                    : saveLegacy(save.name, save.mime, save.staged);
                JSObject result = new JSObject();
                result.put("location", location);
                answer(() -> call.resolve(result));
            } catch (Exception e) {
                answer(() -> call.reject("Could not save the file", e));
            } finally {
                save.staged.delete();
            }
        });
    }

    @PluginMethod
    public void cancelSave(PluginCall call) {
        saves.discard(call.getString("id"));
        call.resolve();
    }

    private static void copy(File src, OutputStream os) throws Exception {
        try (InputStream in = new FileInputStream(src)) {
            byte[] buf = new byte[64 * 1024];
            for (int n; (n = in.read(buf)) > 0; ) os.write(buf, 0, n);
        }
    }

    /** Only image/video/audio pick a media collection; anything else is a plain download. */
    private static String mediaMime(String mime) {
        if (mime == null) return null;
        String m = mime.split(";")[0].trim().toLowerCase(Locale.ROOT);
        return m.startsWith("image/") || m.startsWith("video/") || m.startsWith("audio/") ? m : null;
    }

    private static String folderFor(String mime) {
        if (mime == null) return Environment.DIRECTORY_DOWNLOADS;
        if (mime.startsWith("image/")) return Environment.DIRECTORY_PICTURES;
        if (mime.startsWith("video/")) return Environment.DIRECTORY_MOVIES;
        return Environment.DIRECTORY_MUSIC;
    }

    /** A download's type comes from its extension, never the sender's claim. */
    private static String downloadMime(String name) {
        int dot = name.lastIndexOf('.');
        String ext = dot >= 0 ? name.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
        String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return mime != null ? mime : "application/octet-stream";
    }

    @RequiresApi(29)
    private String saveMediaStore(String name, String mime, File src) throws Exception {
        try {
            if (mime != null) return insert(name, mime, src);
        } catch (Exception e) {
            // MediaStore refuses a type its collection doesn't take (e.g. an
            // image/* it can't index); the file still belongs in Downloads.
        }
        return insert(name, null, src);
    }

    @RequiresApi(29)
    private String insert(String name, String mime, File src) throws Exception {
        String folder = folderFor(mime);
        Uri collection;
        if (mime == null) collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        else if (mime.startsWith("image/")) collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        else if (mime.startsWith("video/")) collection = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        else collection = MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);

        ContentResolver resolver = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mime != null ? mime : downloadMime(name));
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, folder + "/Armada");
        // Hidden from other apps until the bytes are all there.
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri item = resolver.insert(collection, values);
        if (item == null) throw new IllegalStateException("MediaStore refused the file");
        try {
            try (OutputStream os = resolver.openOutputStream(item)) {
                if (os == null) throw new IllegalStateException("No output stream");
                copy(src, os);
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(item, done, null, null);
        } catch (Exception e) {
            resolver.delete(item, null, null);
            throw e;
        }
        return folder + "/Armada";
    }

    private String saveLegacy(String name, String mime, File src) throws Exception {
        File dir = new File(getContext().getExternalFilesDir(folderFor(mime)), "Armada");
        if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("Could not create " + dir);
        File file = new File(dir, name);
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int n = 1; file.exists(); n++) file = new File(dir, stem + " (" + n + ")" + ext);
        try (OutputStream os = new FileOutputStream(file)) {
            copy(src, os);
        }
        MediaScannerConnection.scanFile(
            getContext(), new String[] { file.getAbsolutePath() }, null, null);
        return dir.getAbsolutePath();
    }

    /**
     * Settle a call from the pool on Capacitor's own plugin thread, where every
     * other plugin settles. The reply goes out through the WebView's message
     * channel, which is not built to be written from several threads at once —
     * three pool threads resolving together is not a case it promises to keep.
     */
    private void answer(Runnable settle) {
        getBridge().execute(settle);
    }

    /**
     * A numeric argument as a long. NOT {@code call.getLong}: that answers only
     * for a boxed Long, and JSON hands a small number back as an Integer — so
     * every media id parsed as "missing" and no thumbnail ever rendered.
     */
    private static Long longArg(PluginCall call, String key) {
        Object value = call.getData().opt(key);
        return value instanceof Number ? ((Number) value).longValue() : null;
    }

    private JSObject accessResult() {
        JSObject result = new JSObject();
        result.put("access", access());
        return result;
    }

    /** `full`, `limited` (Android 14+ user-selected), `denied`, or `prompt`. */
    private String access() {
        if (Build.VERSION.SDK_INT >= 33) {
            if (granted("android.permission.READ_MEDIA_IMAGES") && granted("android.permission.READ_MEDIA_VIDEO")) return "full";
            if (Build.VERSION.SDK_INT >= 34 && granted("android.permission.READ_MEDIA_VISUAL_USER_SELECTED")) return "limited";
        } else if (granted(Manifest.permission.READ_EXTERNAL_STORAGE)) {
            return "full";
        }
        PermissionState state = getPermissionState(Build.VERSION.SDK_INT >= 33 ? "media" : "legacy");
        return state == PermissionState.DENIED ? "denied" : "prompt";
    }

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission) == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Images and videos queried from their OWN collections and merged newest
     * first, rather than through the unified Files collection: the Images and
     * Video collections are the ones Android documents as honouring partial
     * access ("Select photos"), so they are what a limited grant is read from.
     */
    private JSObject query(int limit, int offset) {
        JSArray items = new JSArray();
        boolean more = false;
        try (Cursor images = open(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, false);
             Cursor videos = open(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, true)) {
            Row img = Row.first(images, false);
            Row vid = Row.first(videos, true);
            int seen = 0;
            while (img != null || vid != null) {
                boolean takeVideo = img == null || (vid != null && vid.added > img.added);
                Row row = takeVideo ? vid : img;
                if (seen >= offset) {
                    if (items.length() == limit) {
                        more = true;
                        break;
                    }
                    items.put(row.toJs());
                }
                seen++;
                if (takeVideo) vid = Row.next(videos, true);
                else img = Row.next(images, false);
            }
        }
        JSObject result = new JSObject();
        result.put("items", items);
        result.put("more", more);
        return result;
    }

    private Cursor open(Uri collection, boolean video) {
        String[] projection = video
            ? new String[] {
                MediaStore.MediaColumns._ID, MediaStore.MediaColumns.MIME_TYPE, MediaStore.MediaColumns.DISPLAY_NAME,
                MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_ADDED, MediaStore.MediaColumns.DATE_MODIFIED,
                MediaStore.MediaColumns.WIDTH, MediaStore.MediaColumns.HEIGHT, MediaStore.Video.VideoColumns.DURATION,
            }
            : new String[] {
                MediaStore.MediaColumns._ID, MediaStore.MediaColumns.MIME_TYPE, MediaStore.MediaColumns.DISPLAY_NAME,
                MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_ADDED, MediaStore.MediaColumns.DATE_MODIFIED,
                MediaStore.MediaColumns.WIDTH, MediaStore.MediaColumns.HEIGHT,
            };
        // No LIMIT clause: Android 11+ rejects one smuggled into sortOrder, and
        // the cursor is windowed anyway, so walking past `offset` is cheap.
        return getContext().getContentResolver().query(
            collection, projection, null, null, MediaStore.MediaColumns.DATE_ADDED + " DESC");
    }

    /** One cursor row, read out so the two cursors can be merged. */
    private static final class Row {
        long id;
        long added;
        boolean video;
        String mime;
        String name;
        long size;
        long modified;
        int width;
        int height;
        long duration;

        static Row first(Cursor c, boolean video) {
            return c != null && c.moveToFirst() ? read(c, video) : null;
        }

        static Row next(Cursor c, boolean video) {
            return c != null && c.moveToNext() ? read(c, video) : null;
        }

        private static Row read(Cursor c, boolean video) {
            Row r = new Row();
            r.video = video;
            r.id = c.getLong(c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID));
            r.added = longCol(c, MediaStore.MediaColumns.DATE_ADDED);
            r.mime = stringCol(c, MediaStore.MediaColumns.MIME_TYPE);
            r.name = stringCol(c, MediaStore.MediaColumns.DISPLAY_NAME);
            r.size = longCol(c, MediaStore.MediaColumns.SIZE);
            r.modified = longCol(c, MediaStore.MediaColumns.DATE_MODIFIED);
            r.width = (int) longCol(c, MediaStore.MediaColumns.WIDTH);
            r.height = (int) longCol(c, MediaStore.MediaColumns.HEIGHT);
            r.duration = video ? longCol(c, MediaStore.Video.VideoColumns.DURATION) : 0;
            return r;
        }

        private static long longCol(Cursor c, String col) {
            int i = c.getColumnIndex(col);
            return i >= 0 && !c.isNull(i) ? c.getLong(i) : 0;
        }

        private static String stringCol(Cursor c, String col) {
            int i = c.getColumnIndex(col);
            return i >= 0 ? c.getString(i) : null;
        }

        JSObject toJs() {
            Uri base = video ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
            JSObject item = new JSObject();
            item.put("id", id);
            item.put("uri", ContentUris.withAppendedId(base, id).toString());
            item.put("video", video);
            item.put("mime", mime);
            item.put("name", name);
            item.put("size", size);
            item.put("modified", modified);
            item.put("width", width);
            item.put("height", height);
            item.put("duration", duration);
            return item;
        }
    }

    @SuppressWarnings("deprecation")
    private void writeThumbnail(Uri uri, long id, boolean video, File out) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        Bitmap bitmap;
        if (Build.VERSION.SDK_INT >= 29) {
            bitmap = resolver.loadThumbnail(uri, new Size(THUMB_PX, THUMB_PX), null);
        } else if (video) {
            bitmap = MediaStore.Video.Thumbnails.getThumbnail(resolver, id, MediaStore.Video.Thumbnails.MINI_KIND, null);
        } else {
            bitmap = MediaStore.Images.Thumbnails.getThumbnail(resolver, id, MediaStore.Images.Thumbnails.MINI_KIND, null);
        }
        if (bitmap == null) throw new IllegalStateException("No thumbnail");
        // Written beside the target and renamed, so a concurrent request for
        // the same item never serves a half-written file.
        File tmp = new File(out.getParentFile(), out.getName() + ".tmp" + Thread.currentThread().getId());
        try (OutputStream os = new FileOutputStream(tmp)) {
            bitmap.compress(Bitmap.CompressFormat.JPEG, 80, os);
        } finally {
            bitmap.recycle();
        }
        if (!tmp.renameTo(out)) {
            tmp.delete();
            if (!out.exists()) throw new IllegalStateException("Could not store thumbnail");
        }
    }

    private File thumbDir() {
        File dir = new File(getContext().getCacheDir(), "gallery-thumbs");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    /** Keeps the cache to the newest {@link #MAX_CACHED_THUMBS} files. */
    private void trimThumbCache() {
        File[] files = thumbDir().listFiles();
        if (files == null || files.length <= MAX_CACHED_THUMBS) return;
        Arrays.sort(files, Comparator.comparingLong(File::lastModified));
        for (int i = 0; i < files.length - MAX_CACHED_THUMBS; i++) files[i].delete();
    }
}
