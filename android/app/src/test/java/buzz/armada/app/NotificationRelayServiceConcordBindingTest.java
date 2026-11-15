package buzz.armada.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

/** The stream binding a Concord chat rumor must carry (CORD-02 §5, CORD-03 §3). */
public class NotificationRelayServiceConcordBindingTest {
    private static final String CHANNEL = "ab".repeat(32);
    private static final String EPOCH = "4";

    private static JSONObject rumor(String[]... tags) throws JSONException {
        JSONArray arr = new JSONArray();
        for (String[] t : tags) {
            JSONArray tag = new JSONArray();
            for (String v : t) tag.put(v);
            arr.put(tag);
        }
        return new JSONObject().put("kind", 9).put("tags", arr);
    }

    @Test
    public void bindsARumorNamingTheStreamsChannelAndEpoch() throws JSONException {
        assertTrue(NotificationRelayService.concordBound(
                rumor(new String[] {"channel", CHANNEL}, new String[] {"epoch", EPOCH}), CHANNEL, EPOCH, null));
    }

    @Test
    public void refusesAWriterEpochAtTheReadAddress() throws JSONException {
        // The timeline stands a stored `wepoch` as a writer's post; the WebView refuses it here.
        assertFalse(NotificationRelayService.concordBound(rumor(
                new String[] {"channel", CHANNEL}, new String[] {"epoch", EPOCH}, new String[] {"wepoch", "1"}),
                CHANNEL, EPOCH, null));
        assertFalse(NotificationRelayService.concordBound(rumor(
                new String[] {"channel", CHANNEL}, new String[] {"epoch", EPOCH}, new String[] {"wepoch"}),
                CHANNEL, EPOCH, null));
    }

    @Test
    public void bindsAWriterAddressRumorToItsWriterEpochOnly() throws JSONException {
        String[] ch = {"channel", CHANNEL};
        String[] ep = {"epoch", EPOCH};
        assertTrue(NotificationRelayService.concordBound(rumor(ch, ep, new String[] {"wepoch", "2"}), CHANNEL, EPOCH, "2"));
        assertFalse(NotificationRelayService.concordBound(rumor(ch, ep), CHANNEL, EPOCH, "2"));
        assertFalse(NotificationRelayService.concordBound(rumor(ch, ep, new String[] {"wepoch", "3"}), CHANNEL, EPOCH, "2"));
        assertFalse(NotificationRelayService.concordBound(rumor(ch, ep, new String[] {"wepoch", "02"}), CHANNEL, EPOCH, "02"));
        assertFalse(NotificationRelayService.concordBound(
                rumor(ch, ep, new String[] {"wepoch", "2"}, new String[] {"wepoch", "2"}), CHANNEL, EPOCH, "2"));
    }

    @Test
    public void refusesAnotherChannelOrEpochOrAMissingOrRepeatedTag() throws JSONException {
        assertFalse(NotificationRelayService.concordBound(
                rumor(new String[] {"channel", "cd".repeat(32)}, new String[] {"epoch", EPOCH}), CHANNEL, EPOCH, null));
        assertFalse(NotificationRelayService.concordBound(
                rumor(new String[] {"channel", CHANNEL}, new String[] {"epoch", "5"}), CHANNEL, EPOCH, null));
        assertFalse(NotificationRelayService.concordBound(rumor(new String[] {"channel", CHANNEL}), CHANNEL, EPOCH, null));
        assertFalse(NotificationRelayService.concordBound(rumor(
                new String[] {"channel", CHANNEL}, new String[] {"channel", CHANNEL}, new String[] {"epoch", EPOCH}),
                CHANNEL, EPOCH, null));
    }
}
