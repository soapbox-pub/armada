package buzz.armada.app;

import java.util.regex.Pattern;

/**
 * What a Concord reaction may say, the service's port of {@code concord/lib/reactionContent.ts}
 * (Vector {@code is_renderable_reaction}): one no row could render rings nobody.
 */
final class ReactionContent {
    private static final Pattern SHORTCODE = Pattern.compile("^:([A-Za-z0-9_~+-]{1,48}):$");
    private static final Pattern WHITE_SPACE = Pattern.compile("\\p{IsWhite_Space}");

    private ReactionContent() {}

    static boolean renderable(String content) {
        if (content.isEmpty() || content.equals("+") || content.equals("-")) return true;
        if (SHORTCODE.matcher(content).matches()) return true;
        return content.codePointCount(0, content.length()) <= 12
                && !WHITE_SPACE.matcher(content).find()
                && !content.contains("://");
    }
}
