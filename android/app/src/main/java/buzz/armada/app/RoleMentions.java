package buzz.armada.app;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Role mentions (CORD-03 §3, CORD-04 §8), the service's port of
 * {@code concord/lib/roleMentions.ts}: a {@code ["role", id]} tag pings a reader
 * holding that Role when the text names it as {@code @Name}, and the Role is
 * mentionable or its author may mention any Role.
 */
final class RoleMentions {
    static final int MAX_ROLE_MENTIONS = 16;
    private static final Pattern ROLE_ID = Pattern.compile("^[0-9a-f]{64}$");

    /** A Role the reader holds: its current name, and whether any author may ping it. */
    static final class Held {
        final String id, name;
        final boolean anyone;
        Held(String id, String name, boolean anyone) {
            this.id = id;
            this.name = name;
            this.anyone = anyone;
        }
    }

    private RoleMentions() {}

    /** The sub's {@code roleMentions}; an absent or malformed one holds nothing. */
    static List<Held> parse(JSONArray arr) {
        if (arr == null) return Collections.emptyList();
        List<Held> out = new ArrayList<>();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null) continue;
            String id = o.optString("id", "");
            if (!ROLE_ID.matcher(id).matches()) continue;
            out.add(new Held(id, o.optString("name", ""), o.optBoolean("anyone", false)));
        }
        return out;
    }

    /** 64 lowercase hex characters, once each, in tag order, capped. */
    static List<String> ids(JSONArray tags) {
        List<String> out = new ArrayList<>();
        if (tags == null) return out;
        for (int i = 0; i < tags.length(); i++) {
            JSONArray t = tags.optJSONArray(i);
            if (t == null || t.length() < 2 || !"role".equals(t.optString(0))) continue;
            String v = t.optString(1, "");
            if (!ROLE_ID.matcher(v).matches()) continue;
            if (out.size() == MAX_ROLE_MENTIONS) break;
            if (!out.contains(v)) out.add(v);
        }
        return out;
    }

    static boolean pings(String content, JSONArray tags, List<Held> held, Set<String> anyAuthors, String author) {
        if (held.isEmpty() || content == null) return false;
        boolean authorAny = anyAuthors.contains(author);
        for (String id : ids(tags)) {
            for (Held r : held) {
                // An empty name would match any `@`.
                if (r.id.equals(id) && !r.name.isEmpty() && content.contains("@" + r.name) && (r.anyone || authorAny)) return true;
            }
        }
        return false;
    }
}
