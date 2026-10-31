package buzz.armada.app.db

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONObject

/**
 * The WebView's door onto the native [SqliteArmadaDb] — the Android transport
 * behind `src/lib/db/NativeArmadaDB.ts`.
 *
 * The database logic is NOT here. This bridge carries filters in and rumors out;
 * every filter is planned, every tag tokenized and every NIP-09 deletion applied
 * by the same Kotlin store the notification service writes through. That is the
 * point of the port: one engine, one file, one set of semantics, so an event the
 * service received at 3am is simply *in the store* when the app opens, rather
 * than being replayed into a second copy of the query engine.
 *
 * Everything crosses as JSON TEXT rather than as `JSObject` trees. Capacitor's
 * conversion would have to guess at number types (a `created_at` is a Long, a
 * `kind` an Int, and JavaScript has one number), and a page of rumors is far
 * cheaper to hand over as one string the WebView parses itself than as a few
 * thousand marshalled objects.
 *
 * Plugin calls hop to a dedicated `ArmadaDb` thread (see [dbThread]), so the
 * store's blocking lock is held off the UI thread AND off the task thread the
 * other plugins share.
 */
@CapacitorPlugin(name = "ArmadaDB")
class ArmadaDbPlugin : Plugin() {

    private val db: SqliteArmadaDb
        get() = ArmadaDb.get(context)

    /**
     * ArmadaDB's OWN thread, instead of the one Capacitor task thread every
     * plugin shares. On that shared thread a large KV burst or a deep query held
     * up the notification plugin, the signer and every other bridge call behind
     * it — which the WebView experiences as the whole app freezing. One thread,
     * so calls still execute in the order the WebView made them (the ordering
     * the batching in NativeArmadaDB.ts relies on); a PluginCall resolves from
     * any thread.
     */
    private val dbThread = java.util.concurrent.Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "ArmadaDb").apply { isDaemon = true }
    }

    private fun onDbThread(block: () -> Unit) {
        dbThread.execute(block)
    }

    /**
     * Profiling builds: time a plugin call under `db.<method> <family>` (a
     * tenant's or key's family — ids elided) and record the result size, so
     * `dumpsys` shows what the WebView keeps this thread busy with.
     */
    private inline fun profiled(call: PluginCall, method: String, block: () -> Unit) {
        if (!buzz.armada.app.ServiceProfiler.ON) return block()
        val subject = call.getString("tenant") ?: call.getString("key") ?: call.getString("prefix") ?: ""
        val label = "plugin.$method ${family(subject)}" +
            (call.getString("filters")?.let { " " + filterShape(it) } ?: "")
        val started = buzz.armada.app.ServiceProfiler.begin(label)
        try {
            block()
        } finally {
            buzz.armada.app.ServiceProfiler.end(label, started)
            buzz.armada.app.ServiceProfiler.units("plugin.in bytes $method", (call.data?.toString()?.length ?: 0).toLong())
        }
    }

    /** A filter list's shape for a profile label: kinds, and which keys it names. */
    private fun filterShape(raw: String): String = try {
        val array = JSONArray(raw)
        (0 until array.length()).joinToString("|") { i ->
            val f = array.optJSONObject(i) ?: return@joinToString "?"
            val kinds = f.optJSONArray("kinds")?.let { k -> (0 until k.length()).joinToString(",") { k.opt(it).toString() } }
            val keys = f.keys().asSequence().filter { it != "kinds" }.sorted().joinToString("+") { key ->
                if (key == "search") "search=" + f.optString(key).substringBefore(':') else key
            }
            "k[${kinds ?: "*"}]" + (if (keys.isEmpty()) "" else "+$keys")
        }.take(120)
    } catch (_: Exception) {
        "?"
    }

    private fun family(subject: String): String =
        subject.replace(Regex("[0-9a-f]{16,}"), "…").replace(Regex("wss?://[^/]+"), "<relay>").take(40)

    /** Rumors matching any of the filters, newest-first, as a JSON array. */
    @PluginMethod
    fun query(call: PluginCall) = onDbThread { profiled(call, "query") { queryNow(call) } }

    private fun queryNow(call: PluginCall) {
        val tenant = call.getString("tenant") ?: return call.reject("tenant is required")
        val filters = parseFilters(call) ?: return

        try {
            val rumors = db.query(tenant, filters)

            // Written straight out, not built into a `JSONArray` and
            // stringified. Capacitor will escape whatever comes back into its
            // own response envelope — a second full pass over the payload that
            // is not ours to remove — so the one pass that IS ours has to be
            // the cheap one. `org.json` was neither: it re-derived every rumor
            // body from parsed fields, then appended the result a character at
            // a time.
            var hint = 2
            for (rumor in rumors) hint += rumor.jsonSizeHint() + 1
            val out = StringBuilder(hint)
            out.append('[')
            for ((i, rumor) in rumors.withIndex()) {
                if (i > 0) out.append(',')
                rumor.appendJsonTo(out)
            }
            out.append(']')

            call.resolve(JSObject().put("rumors", out.toString()))
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    /**
     * Store a batch of rumors in one transaction. `rumors` is a JSON array; the
     * WebView coalesces a burst into a single call, so the batch here IS the
     * burst and commits as one.
     */
    @PluginMethod
    fun event(call: PluginCall) = onDbThread { profiled(call, "event") { eventNow(call) } }

    private fun eventNow(call: PluginCall) {
        val tenant = call.getString("tenant") ?: return call.reject("tenant is required")
        val raw = call.getString("rumors") ?: return call.reject("rumors is required")

        try {
            val array = JSONArray(raw)
            val writes = ArrayList<SqliteArmadaDb.Write>(array.length())
            for (i in 0 until array.length()) {
                val body = array.optJSONObject(i) ?: continue
                val rumor = Rumor.parse(body) ?: continue
                writes.add(SqliteArmadaDb.Write(tenant, rumor))
            }
            db.write(writes)
            call.resolve()
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    @PluginMethod
    fun count(call: PluginCall) = onDbThread { profiled(call, "count") { countNow(call) } }

    private fun countNow(call: PluginCall) {
        val tenant = call.getString("tenant") ?: return call.reject("tenant is required")
        val filters = parseFilters(call) ?: return

        try {
            val count = db.count(tenant, filters)
            call.resolve(
                JSObject()
                    .put("count", count.count)
                    .put("approximate", count.approximate),
            )
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    @PluginMethod
    fun remove(call: PluginCall) = onDbThread { profiled(call, "remove") { removeNow(call) } }

    private fun removeNow(call: PluginCall) {
        val tenant = call.getString("tenant") ?: return call.reject("tenant is required")
        val filters = parseFilters(call) ?: return

        try {
            db.remove(tenant, filters)
            call.resolve()
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    /** Remove rumors from this device for good (`ArmadaDB.forget`); `ids` is a JSON array. */
    @PluginMethod
    fun forget(call: PluginCall) = onDbThread { profiled(call, "forget") { forgetNow(call) } }

    private fun forgetNow(call: PluginCall) {
        val ids = call.getString("ids") ?: return call.reject("ids is required")
        try {
            val array = JSONArray(ids)
            db.forget((0 until array.length()).map { array.getString(it) })
            call.resolve()
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    /** Every tenant that has ever been written to (the logout purge reads this). */
    @PluginMethod
    fun tenants(call: PluginCall) = onDbThread { profiled(call, "tenants") { tenantsNow(call) } }

    private fun tenantsNow(call: PluginCall) {
        try {
            call.resolve(JSObject().put("tenants", JSONArray(db.tenantIds()).toString()))
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    // ── KV ────────────────────────────────────────────────────────────────────
    //
    // Values cross as the JSON text the WebView serialized. Nothing here parses
    // them, so the store never has to agree with JavaScript about how a value
    // round-trips — `undefined`, a `Map`, a `bigint` are the caller's problem in
    // exactly the way the ArmadaKV contract already says they are.

    @PluginMethod
    fun kvGet(call: PluginCall) = onDbThread { profiled(call, "kvGet") { kvGetNow(call) } }

    private fun kvGetNow(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key is required")

        try {
            val value = db.kvGet(key)
            val result = JSObject()
            if (value != null) result.put("value", value)
            call.resolve(result)
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    @PluginMethod
    fun kvSet(call: PluginCall) = onDbThread { profiled(call, "kvSet") { kvSetNow(call) } }

    private fun kvSetNow(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key is required")
        val value = call.getString("value") ?: return call.reject("value is required")

        try {
            db.kvSet(key, value)
            call.resolve()
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    @PluginMethod
    fun kvDelete(call: PluginCall) = onDbThread { profiled(call, "kvDelete") { kvDeleteNow(call) } }

    private fun kvDeleteNow(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key is required")

        try {
            db.kvDelete(key)
            call.resolve()
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    /**
     * The entries a selector picks out, as `{ key, value }` objects. `value` is
     * the stored JSON TEXT carried as a string: re-serializing it here would
     * risk respelling a number, and the WebView is the only side that parses.
     */
    @PluginMethod
    fun kvList(call: PluginCall) = onDbThread { profiled(call, "kvList") { kvListNow(call) } }

    private fun kvListNow(call: PluginCall) {
        try {
            val entries = db.kvList(
                prefix = call.getString("prefix"),
                start = call.getString("start"),
                end = call.getString("end"),
                limit = call.getInt("limit"),
                reverse = call.getBoolean("reverse", false) == true,
            )
            val out = StringBuilder()
            out.append('[')
            for ((i, entry) in entries.withIndex()) {
                if (i > 0) out.append(',')
                appendEntry(out, entry)
            }
            out.append(']')
            call.resolve(JSObject().put("entries", out.toString()))
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    /**
     * A whole burst of KV operations as ONE crossing — the WebView coalesces a
     * tick's worth of get/set/delete/list into a single call (see
     * `NativeArmadaDB.ts`), and the store executes them in arrival order in
     * one lock turn (one transaction, when the batch writes).
     *
     * `ops` is a JSON array of `{ op: "get"|"set"|"delete"|"list", ... }`.
     * Resolves `{ results }` — a JSON array aligned with `ops`: the stored
     * JSON text (or null) for a get, null for a set/delete, an array of
     * `{ key, value }` for a list.
     */
    @PluginMethod
    fun kvOps(call: PluginCall) = onDbThread { profiled(call, "kvOps") { kvOpsNow(call) } }

    private fun kvOpsNow(call: PluginCall) {
        val raw = call.getString("ops") ?: return call.reject("ops is required")

        val ops: List<SqliteArmadaDb.KvOp>
        try {
            val array = JSONArray(raw)
            ops = (0 until array.length()).map { i ->
                val body = array.optJSONObject(i) ?: return call.reject("ops[$i] is not an object")
                when (val op = body.optString("op")) {
                    "get" -> SqliteArmadaDb.KvOp.Get(body.getString("key"))
                    "set" -> SqliteArmadaDb.KvOp.Set(body.getString("key"), body.getString("value"))
                    "delete" -> SqliteArmadaDb.KvOp.Delete(body.getString("key"))
                    "list" -> SqliteArmadaDb.KvOp.Scan(
                        prefix = body.stringOrNull("prefix"),
                        start = body.stringOrNull("start"),
                        end = body.stringOrNull("end"),
                        limit = if (body.has("limit")) body.getInt("limit") else null,
                        reverse = body.optBoolean("reverse", false),
                    )
                    else -> return call.reject("ops[$i]: unknown op \"$op\"")
                }
            }
        } catch (error: Exception) {
            return call.reject("ops is not a valid batch", error)
        }

        try {
            if (buzz.armada.app.ServiceProfiler.ON) {
                for (op in ops) buzz.armada.app.ServiceProfiler.count(
                    "plugin.kvOps op " + op.javaClass.simpleName + " " +
                        family(when (op) {
                            is SqliteArmadaDb.KvOp.Get -> op.key
                            is SqliteArmadaDb.KvOp.Set -> op.key
                            is SqliteArmadaDb.KvOp.Delete -> op.key
                            is SqliteArmadaDb.KvOp.Scan -> op.prefix ?: "*"
                        }).substringBeforeLast(':'),
                )
            }
            val dbStarted = buzz.armada.app.ServiceProfiler.begin("plugin.kvOps store")
            val results = try { db.kvOps(ops) } finally { buzz.armada.app.ServiceProfiler.end("plugin.kvOps store", dbStarted) }
            val encodeStarted = buzz.armada.app.ServiceProfiler.begin("plugin.kvOps encode+resolve")
            val out = StringBuilder()
            out.append('[')
            for ((i, result) in results.withIndex()) {
                if (i > 0) out.append(',')
                if (ops[i] is SqliteArmadaDb.KvOp.Scan) {
                    out.append('[')
                    @Suppress("UNCHECKED_CAST")
                    for ((j, entry) in (result as List<KvEntry>).withIndex()) {
                        if (j > 0) out.append(',')
                        appendEntry(out, entry)
                    }
                    out.append(']')
                } else if (result == null) {
                    out.append("null")
                } else {
                    JsonText.quote(out, result as String)
                }
            }
            out.append(']')
            buzz.armada.app.ServiceProfiler.units("plugin.out bytes kvOps", out.length.toLong())
            call.resolve(JSObject().put("results", out.toString()))
            buzz.armada.app.ServiceProfiler.end("plugin.kvOps encode+resolve", encodeStarted)
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    /** Empty every table (logout purge). The file and its schema survive. */
    @PluginMethod
    fun wipe(call: PluginCall) = onDbThread { profiled(call, "wipe") { wipeNow(call) } }

    private fun wipeNow(call: PluginCall) {
        try {
            db.wipe()
            call.resolve()
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    /**
     * The call's `filters`, or null once the call has been rejected — a filter
     * list that didn't parse is a programming error on the JS side, and
     * answering it with "no constraints" would hand back the whole tenant.
     */
    /**
     * One `{ key, value }` entry. `value` is the stored JSON TEXT carried as a
     * string rather than spliced in: re-serializing it would risk respelling a
     * number, and the WebView is the only side that parses.
     */
    private fun appendEntry(out: StringBuilder, entry: KvEntry) {
        out.append("{\"key\":")
        JsonText.quote(out, entry.key)
        out.append(",\"value\":")
        JsonText.quote(out, entry.json)
        out.append('}')
    }

    /** The string under [name], or null when absent — `optString` would return `""`. */
    private fun JSONObject.stringOrNull(name: String): String? =
        if (has(name) && !isNull(name)) getString(name) else null

    private fun parseFilters(call: PluginCall): List<JSONObject>? {
        val raw = call.getString("filters")
        if (raw == null) {
            call.reject("filters is required")
            return null
        }

        return try {
            val array = JSONArray(raw)
            (0 until array.length()).mapNotNull { array.optJSONObject(it) }
        } catch (error: Exception) {
            call.reject("filters is not valid JSON", error)
            null
        }
    }
}
