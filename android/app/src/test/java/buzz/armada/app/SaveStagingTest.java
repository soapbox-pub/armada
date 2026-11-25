package buzz.armada.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class SaveStagingTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void clearsStagingLeftByAProcessThatDied() throws Exception {
        File dir = tmp.newFolder("pending-saves");
        File orphan = new File(dir, "orphan");
        assertTrue(orphan.createNewFile());
        new SaveStaging(dir).clearStale();
        assertFalse(orphan.exists());
    }

    /** `load()` queues the cleanup on the io pool, so a save can begin before it runs. */
    @Test
    public void keepsASaveThatBeganBeforeTheCleanupRan() throws Exception {
        SaveStaging staging = new SaveStaging(tmp.newFolder("pending-saves"));
        String id = staging.begin("clip.mp4", "video/mp4");
        byte[] piece = "first piece".getBytes(StandardCharsets.UTF_8);
        Files.write(staging.get(id).staged.toPath(), piece);

        staging.clearStale();

        assertTrue(staging.get(id).staged.exists());
        assertArrayEquals(piece, Files.readAllBytes(staging.get(id).staged.toPath()));
    }
}
