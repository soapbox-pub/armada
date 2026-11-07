package buzz.armada.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import org.json.JSONArray;
import org.junit.Test;

/** The service's port of {@code roleMentions.ts}, checked against the same cases as {@code roleMentions.test.ts}. */
public class RoleMentionsTest {
    private static final String MODS = "a".repeat(64);
    private static final String QUIET = "b".repeat(64);
    private static final String AUTHOR = "c".repeat(64);

    private static final List<RoleMentions.Held> HELD = List.of(
            new RoleMentions.Held(MODS, "Mods", true),
            new RoleMentions.Held(QUIET, "Quiet", false));

    private static JSONArray tags(String... roleIds) {
        JSONArray out = new JSONArray();
        for (String id : roleIds) out.put(new JSONArray().put("role").put(id));
        return out;
    }

    @Test public void pingsAHeldMentionableRoleNamedInTheText() {
        assertTrue(RoleMentions.pings("hey @Mods", tags(MODS), HELD, Collections.emptySet(), AUTHOR));
    }

    @Test public void aTagWithoutItsNameInTheTextPingsNobody() {
        assertFalse(RoleMentions.pings("hey all", tags(MODS), HELD, Collections.emptySet(), AUTHOR));
    }

    @Test public void aRoleThatIsntMentionablePingsOnlyFromAnAuthorWhoMayMentionAny() {
        assertFalse(RoleMentions.pings("hey @Quiet", tags(QUIET), HELD, Collections.emptySet(), AUTHOR));
        Set<String> any = new HashSet<>(Set.of(AUTHOR));
        assertTrue(RoleMentions.pings("hey @Quiet", tags(QUIET), HELD, any, AUTHOR));
    }

    @Test public void readsOnlyLowercaseIdsTheFirstSixteenDistinct() {
        assertTrue(RoleMentions.ids(tags(MODS.toUpperCase())).isEmpty());
        String[] many = new String[20];
        for (int i = 0; i < 20; i++) many[i] = String.format("%064x", i);
        assertEquals(16, RoleMentions.ids(tags(many)).size());
        assertEquals(1, RoleMentions.ids(tags(MODS, MODS)).size());
    }

    @Test public void parsesTheSubsRoles() throws Exception {
        JSONArray arr = new JSONArray("[{\"id\":\"" + MODS + "\",\"name\":\"Mods\",\"anyone\":true},{\"id\":\"x\"}]");
        List<RoleMentions.Held> held = RoleMentions.parse(arr);
        assertEquals(1, held.size());
        assertTrue(held.get(0).anyone);
    }
}
