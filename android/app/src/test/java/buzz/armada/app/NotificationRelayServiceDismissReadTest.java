package buzz.armada.app;

import static org.junit.Assert.assertEquals;

import java.util.HashMap;
import java.util.Map;

import org.junit.Test;

public class NotificationRelayServiceDismissReadTest {

    /** Dismissals held while the app is covered keep the newest stamp per room. */
    @Test
    public void heldReadStampsKeepTheNewestPerKey() {
        Map<String, Long> held = new HashMap<>();
        Map<String, Long> first = new HashMap<>();
        first.put("c2:general", 200L);
        first.put("dm:ana", 100L);
        NotificationRelayService.mergeReadStamps(held, first);

        Map<String, Long> second = new HashMap<>();
        second.put("c2:general", 150L);
        second.put("dm:ana", 300L);
        second.put("wss://r::g", 50L);
        NotificationRelayService.mergeReadStamps(held, second);

        assertEquals(Long.valueOf(200L), held.get("c2:general"));
        assertEquals(Long.valueOf(300L), held.get("dm:ana"));
        assertEquals(Long.valueOf(50L), held.get("wss://r::g"));
        assertEquals(3, held.size());
    }
}
