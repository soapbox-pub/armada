package buzz.armada.app.db

import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.security.SecureRandom

/**
 * Reproduction, not a suite member: skipped unless run as
 * `./gradlew :app:testDebugUnitTest --tests '*QueryHeapRepro' -PreproRows=70000`
 * (256 MB heap by default, `-PreproHeap` to change it).
 * Seeds `invites:<me>` with spam-sized kind-3313 rumors, then does what ONE
 * unlimited read crossing costs on Android: the engine's read, the plugin's
 * JSON string, and Capacitor's reply envelope serialized around it. ~70k rows
 * (~65 MB) exhaust 256 MB, which is why `NativeArmadaDB` pages such reads
 * (`READ_PAGE`).
 */
class QueryHeapRepro {
    private val rng = SecureRandom()

    private fun hex(bytes: Int): String {
        val b = ByteArray(bytes).also(rng::nextBytes)
        return b.joinToString("") { "%02x".format(it) }
    }

    /** The shape `scripts/spambot.mjs` phantomBundle() sends. */
    private fun bundle(): String = JSONObject()
        .put("community_id", hex(32)).put("owner", hex(32)).put("owner_salt", hex(32))
        .put("community_root", hex(32)).put("root_epoch", 0).put("control_pk", hex(32))
        .put("channels", org.json.JSONArray())
        .put("relays", org.json.JSONArray(listOf("wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net")))
        .put("name", "Spam ${hex(4)}")
        .put("description", "The official community. Invite-only alpha, join before it fills up.")
        .put("creator_npub", hex(32))
        .toString()

    @Test
    fun unlimitedInviteRead() {
        val rows = System.getProperty("reproRows")?.toIntOrNull()
        assumeTrue(rows != null)
        val db = SqliteArmadaDb(BundledSqlDriver(":memory:"))
        val tenant = "invites:${hex(32)}"
        var t = 1_700_000_000L
        for (start in 0 until rows!! step 1000) {
            db.write((start until minOf(rows, start + 1000)).map {
                SqliteArmadaDb.Write(tenant, Rumor.of(hex(32), hex(32), t++, 3313, emptyList(), bundle())!!)
            })
        }
        val rt = Runtime.getRuntime()
        System.gc()
        println("REPRO rows=$rows maxHeap=${rt.maxMemory() shr 20}MB usedBefore=${(rt.totalMemory() - rt.freeMemory()) shr 20}MB")

        // ArmadaDbPlugin.queryNow
        val rumors = db.query(tenant, listOf(JSONObject("{\"kinds\":[3313]}")))
        val out = StringBuilder()
        out.append('[')
        for ((i, r) in rumors.withIndex()) {
            if (i > 0) out.append(',')
            r.appendJsonTo(out)
        }
        out.append(']')
        val payload = out.toString()
        println("REPRO payload=${payload.length shr 10}KB")
        // call.resolve → MessageHandler.sendResponseMessage → data.toString()
        val envelope = JSONObject().put("success", true).put("data", JSONObject().put("rumors", payload))
        val message = envelope.toString()
        println("REPRO message=${message.length shr 10}KB OK")
        db.close()
    }
}
