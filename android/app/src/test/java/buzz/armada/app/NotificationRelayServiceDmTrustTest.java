package buzz.armada.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import org.junit.Test;

/** Pure NIP-17 request/mute policy tests; no Android runtime is required. */
public class NotificationRelayServiceDmTrustTest {
    private static final String ALICE = "a".repeat(64);
    private static final String BOB = "b".repeat(64);
    private static final String CAROL = "c".repeat(64);
    private static final String GROUP = ALICE + "," + BOB;
    private static final List<String> GROUP_PEERS = Arrays.asList(ALICE, BOB);

    @Test
    public void exactGroupRosterTrustDoesNotGlobalizeMembers() {
        Set<String> knownConversations = Collections.singleton(GROUP);

        assertTrue(NotificationRelayService.dmConversationKnown(
                GROUP, GROUP_PEERS, Collections.emptySet(), knownConversations));

        // Bob speaking inside the rostered group is trusted there, but a new
        // 1:1 from Bob remains a request.
        assertFalse(NotificationRelayService.dmConversationKnown(
                BOB, Collections.singletonList(BOB),
                Collections.emptySet(), knownConversations));
    }

    @Test
    public void everyIndividuallyKnownParticipantAlsoMakesGroupKnown() {
        Set<String> bothKnown = new LinkedHashSet<>(GROUP_PEERS);
        assertTrue(NotificationRelayService.dmConversationKnown(
                GROUP, GROUP_PEERS, bothKnown, Collections.emptySet()));

        assertFalse(NotificationRelayService.dmConversationKnown(
                GROUP, GROUP_PEERS, Collections.singleton(ALICE),
                Collections.emptySet()));
    }

    @Test
    public void anyMutedParticipantSuppressesTheWholeGroup() {
        assertTrue(NotificationRelayService.dmConversationMuted(
                GROUP_PEERS, Collections.singleton(BOB)));
        assertFalse(NotificationRelayService.dmConversationMuted(
                GROUP_PEERS, Collections.singleton(CAROL)));
        assertFalse(NotificationRelayService.dmConversationMuted(
                GROUP_PEERS, Collections.emptySet()));
    }
}
