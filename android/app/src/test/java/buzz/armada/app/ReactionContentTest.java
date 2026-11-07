package buzz.armada.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** The service's port of {@code reactionContent.ts}, against the same cases as {@code chat.test.ts}. */
public class ReactionContentTest {
    @Test
    public void takesLikesShortcodesAndShortGlyphs() {
        assertTrue(ReactionContent.renderable(""));
        assertTrue(ReactionContent.renderable("+"));
        assertTrue(ReactionContent.renderable(":catJAM:"));
        assertTrue(ReactionContent.renderable("🔥"));
    }

    @Test
    public void dropsJunk() {
        assertFalse(ReactionContent.renderable(":catclap:https://i.nostr.build/lLMrw.gif"));
        assertFalse(ReactionContent.renderable("this is a whole sentence"));
        assertFalse(ReactionContent.renderable("a\u00a0b"));
    }
}
