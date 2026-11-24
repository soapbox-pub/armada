package buzz.armada.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Set;

import org.junit.Test;

/**
 * A reaction readers don't count rings nobody (CORD-04 §8): the service reads the two
 * lists `reactionGateIn` in `src/concord/lib/channelJudges.ts` writes into its config.
 */
public class ReactionGateTest {
    @Test public void aDeniedReactorRingsNobody() {
        assertTrue(NotificationRelayService.reactionUncounted(Set.of("a"), null, "a"));
        assertFalse(NotificationRelayService.reactionUncounted(Set.of("a"), null, "b"));
    }

    @Test public void onlyTheListedReactRingWhereAMemberWithNoRoleCant() {
        assertFalse(NotificationRelayService.reactionUncounted(null, Set.of("owner"), "owner"));
        assertTrue(NotificationRelayService.reactionUncounted(null, Set.of("owner"), "b"));
    }

    @Test public void everyoneRingsWithNoList() {
        assertFalse(NotificationRelayService.reactionUncounted(null, null, "b"));
    }
}
