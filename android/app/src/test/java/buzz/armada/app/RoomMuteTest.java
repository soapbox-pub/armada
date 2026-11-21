package buzz.armada.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Map;

import org.junit.Test;

/**
 * Timed mutes the service judges itself ({@code roomMutes}), so a mute lifts
 * with the app closed. Key shapes mirror {@code roomMuteKey} in
 * `src/lib/notifRecords.ts`; {@code roomMutedAt} there is the same rule.
 */
public class RoomMuteTest {
    private static final String CHANNEL = "11".repeat(32);
    private static final String COMMUNITY = "22".repeat(32);

    @Test public void aChannelIsSilentUntilItsMuteEnds() {
        Map<String, Long> mutes = NotificationRelayService.parseRoomMutes("{\"c2:" + CHANNEL + "\":1000}");
        assertTrue(NotificationRelayService.roomMuted(mutes, "c2:" + CHANNEL, COMMUNITY, 999));
        assertFalse(NotificationRelayService.roomMuted(mutes, "c2:" + CHANNEL, COMMUNITY, 1000));
    }

    @Test public void aCommunityMuteCoversItsChannels() {
        Map<String, Long> mutes = NotificationRelayService.parseRoomMutes("{\"c2:" + COMMUNITY + "\":1000}");
        assertTrue(NotificationRelayService.roomMuted(mutes, "c2:" + CHANNEL, COMMUNITY.toUpperCase(), 10));
        assertFalse(NotificationRelayService.roomMuted(mutes, "c2:" + CHANNEL, null, 10));
    }

    @Test public void aServerMuteCoversItsGroups() {
        Map<String, Long> mutes = NotificationRelayService.parseRoomMutes("{\"h:wss://relay.example\":1000}");
        assertTrue(NotificationRelayService.roomMuted(mutes, "h:wss://relay.example|grp", null, 10));
        assertFalse(NotificationRelayService.roomMuted(mutes, "h:wss://other.example|grp", null, 10));
    }

    @Test public void aDmMuteIsExact() {
        Map<String, Long> mutes = NotificationRelayService.parseRoomMutes("{\"dm:abc\":1000}");
        assertTrue(NotificationRelayService.roomMuted(mutes, "dm:abc", null, 10));
        assertFalse(NotificationRelayService.roomMuted(mutes, "dm:abd", null, 10));
    }

    @Test public void malformedEntriesAreDropped() {
        assertEquals(0, NotificationRelayService.parseRoomMutes("{\"dm:a\":\"x\",\"dm:b\":-1}").size());
        assertEquals(0, NotificationRelayService.parseRoomMutes("not json").size());
        assertEquals(0, NotificationRelayService.parseRoomMutes(null).size());
    }
}
