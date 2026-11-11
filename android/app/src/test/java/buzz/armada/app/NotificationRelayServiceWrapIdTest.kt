package buzz.armada.app

import buzz.armada.app.db.BundledSqlDriver
import buzz.armada.app.db.Rumor
import buzz.armada.app.db.SqliteArmadaDb
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `isAuthentic` for gift wraps. A wrap's signature is not checked, but its id
 * keys the seen ledger and the store, so it must still be the hash of the
 * event carrying it — the rule `verifiedRelay.ts` applies on the web.
 */
class NotificationRelayServiceWrapIdTest {

    private val sk = ByteArray(32) { 7 }
    private val me = "a".repeat(64)

    private fun wrap(kind: Int): JSONObject =
        NostrCrypto.finalizeEvent(kind, "ciphertext", JSONArray().put(JSONArray().put("p").put(me)), 1_700_000_000L, sk)

    /** The wrap's id and signature over content its id does not commit to. */
    private fun squat(wrap: JSONObject): JSONObject = JSONObject(wrap.toString()).put("content", "junk")

    /** The service's path for one delivery: the gate, then the store's first-write-wins. */
    private fun deliver(db: SqliteArmadaDb, event: JSONObject) {
        if (!NotificationRelayService.isAuthentic(event, event.getInt("kind"), false)) return
        db.event("dm17:$me", Rumor.parse(event)!!)
    }

    @Test
    fun `a wrap is admitted without a signature check`() {
        val unsigned = wrap(1059).put("sig", "0".repeat(128))
        assertTrue(NotificationRelayService.isAuthentic(unsigned, 1059, false))
        assertTrue(NotificationRelayService.isAuthentic(wrap(21059), 21059, false))
    }

    @Test
    fun `a wrap whose id is not its hash is refused`() {
        assertFalse(NotificationRelayService.isAuthentic(squat(wrap(1059)), 1059, false))
        assertFalse(NotificationRelayService.isAuthentic(squat(wrap(21059)), 21059, false))
    }

    @Test
    fun `junk delivered under a wrap's id does not take that wrap's place in the store`() {
        val db = SqliteArmadaDb(BundledSqlDriver(":memory:"))
        try {
            val real = wrap(1059)
            deliver(db, squat(real))
            deliver(db, real)

            val stored = db.query("dm17:$me", listOf(JSONObject().put("ids", JSONArray().put(real.getString("id")))))
            assertEquals(listOf("ciphertext"), stored.map { it.content })
        } finally {
            db.close()
        }
    }

    @Test
    fun `any other kind still needs its signature`() {
        val note = NostrCrypto.finalizeEvent(9, "hi", JSONArray(), 1_700_000_000L, sk)
        assertTrue(NotificationRelayService.isAuthentic(note, 9, false))
        assertFalse(NotificationRelayService.isAuthentic(JSONObject(note.toString()).put("sig", "0".repeat(128)), 9, false))
    }
}
