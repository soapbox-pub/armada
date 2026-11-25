package buzz.armada.app;

import java.io.File;
import java.io.IOException;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The saves {@link MediaGalleryPlugin} has in flight: each staged in a file of
 * its own under one cache directory, named by an id minted here, never a
 * caller's path. Plain Java, so its bookkeeping is tested off a device.
 */
final class SaveStaging {
    static final class Pending {
        final String name;
        final String mime;
        final File staged;

        Pending(String name, String mime, File staged) {
            this.name = name;
            this.mime = mime;
            this.staged = staged;
        }
    }

    private final File dir;
    private final Map<String, Pending> saves = new ConcurrentHashMap<>();

    SaveStaging(File dir) {
        this.dir = dir;
    }

    /** A new save's id; its staging file exists, so an empty save still has something to copy. */
    String begin(String name, String mime) throws IOException {
        String id = UUID.randomUUID().toString();
        File staged = new File(dir(), id);
        // Pending before its file exists, so a cleanup running meanwhile passes it by.
        saves.put(id, new Pending(name, mime, staged));
        try {
            if (!staged.createNewFile()) throw new IOException("Staging file exists");
        } catch (IOException e) {
            saves.remove(id);
            throw e;
        }
        return id;
    }

    Pending get(String id) {
        return id != null ? saves.get(id) : null;
    }

    /** The save, no longer pending; its file is the caller's to delete. */
    Pending take(String id) {
        return id != null ? saves.remove(id) : null;
    }

    void discard(String id) {
        Pending save = take(id);
        if (save != null) save.staged.delete();
    }

    /** Staging left by a save the process died during; a save still pending keeps its file. */
    void clearStale() {
        File[] files = dir().listFiles();
        if (files != null) for (File f : files) if (!saves.containsKey(f.getName())) f.delete();
    }

    private File dir() {
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }
}
