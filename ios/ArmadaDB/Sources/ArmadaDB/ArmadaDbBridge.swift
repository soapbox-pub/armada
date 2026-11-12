import Foundation

/// The store's surface as the WebView sees it: JSON text in, JSON text out.
///
/// This is `ArmadaDbPlugin.kt` with the Capacitor glue removed. The Kotlin port
/// builds its response strings inside the plugin class, where a JVM test can
/// reach them only by standing up a `PluginCall`; here the same work lives in
/// the package, so the wire format — the one thing both sides have to agree on
/// — is covered by the Linux conformance suite, and the iOS plugin is left with
/// nothing but `call.getString` and `call.resolve`.
///
/// Everything crosses as JSON TEXT rather than as marshalled objects. Capacitor
/// would have to guess at number types (a `created_at` is 64-bit, a `kind` is
/// not, and JavaScript has one number), and a page of rumors is far cheaper to
/// hand over as one string the WebView parses itself than as a few thousand
/// marshalled objects.
///
/// The database logic is NOT here. This carries filters in and rumors out;
/// every filter is planned, every tag tokenized and every NIP-09 deletion
/// applied by `SqliteArmadaDb`.
public final class ArmadaDbBridge {

    private let db: SqliteArmadaDb

    public init(db: SqliteArmadaDb) {
        self.db = db
    }

    /// Rumors matching any of the filters, newest-first, as a JSON array.
    public func query(tenant: String, filters: String) throws -> String {
        let rumors = try db.query(tenant: tenant, filters: Self.parseFilters(filters))

        // Written straight out, not built into an array of dictionaries and
        // serialized. The bridge will escape whatever comes back into its own
        // response envelope — a second full pass over the payload that is not
        // ours to remove — so the one pass that IS ours has to be the cheap one.
        var hint = 2
        for rumor in rumors { hint += rumor.jsonSizeHint() + 1 }

        var out = [UInt8]()
        out.reserveCapacity(hint)
        out.append(UInt8(ascii: "["))
        for (index, rumor) in rumors.enumerated() {
            if index > 0 { out.append(UInt8(ascii: ",")) }
            rumor.appendJson(to: &out)
        }
        out.append(UInt8(ascii: "]"))

        return String(decoding: out, as: UTF8.self)
    }

    /// Store a batch of rumors in one transaction. `rumors` is a JSON array; the
    /// WebView coalesces a burst into a single call, so the batch here IS the
    /// burst and commits as one.
    public func event(tenant: String, rumors: String) throws {
        guard let decoded = try? JSONSerialization.jsonObject(with: Data(rumors.utf8)),
            let array = decoded as? [Any]
        else {
            throw ArmadaDbError.unusable("rumors is not valid JSON")
        }

        let writes = array.compactMap { body -> SqliteArmadaDb.Write? in
            guard let object = body as? [String: Any], let rumor = Rumor.parse(object) else {
                return nil
            }
            return SqliteArmadaDb.Write(tenant: tenant, rumor: rumor)
        }

        try db.write(writes)
    }

    public func count(tenant: String, filters: String) throws -> (
        count: Int64, approximate: Bool
    ) {
        let result = try db.count(tenant: tenant, filters: Self.parseFilters(filters))
        return (result.count, result.approximate)
    }

    public func remove(tenant: String, filters: String) throws {
        try db.remove(tenant: tenant, filters: Self.parseFilters(filters))
    }

    /// Every tenant that has ever been written to (the logout purge reads this).
    public func tenants() throws -> String {
        var out = [UInt8]()
        out.append(UInt8(ascii: "["))
        for (index, id) in try db.tenantIds().enumerated() {
            if index > 0 { out.append(UInt8(ascii: ",")) }
            JsonText.quote(&out, id)
        }
        out.append(UInt8(ascii: "]"))
        return String(decoding: out, as: UTF8.self)
    }

    /// What the store holds, for Settings › Storage, in `ArmadaDBUsage`'s shape.
    public func usage() throws -> String {
        let usage = try db.usage()
        var out = [UInt8]()
        out.append(contentsOf: Array("{\"tenants\":[".utf8))
        for (index, tenant) in usage.tenants.enumerated() {
            if index > 0 { out.append(UInt8(ascii: ",")) }
            out.append(contentsOf: Array("{\"id\":".utf8))
            JsonText.quote(&out, tenant.id)
            out.append(contentsOf: Array(",\"rumors\":\(tenant.rumors),\"bytes\":\(tenant.bytes)}".utf8))
        }
        out.append(contentsOf: Array("],\"kv\":{\"entries\":\(usage.kvEntries),\"bytes\":\(usage.kvBytes),\"groups\":[".utf8))
        for (index, group) in usage.kvGroups.enumerated() {
            if index > 0 { out.append(UInt8(ascii: ",")) }
            out.append(contentsOf: Array("{\"group\":".utf8))
            JsonText.quote(&out, group.group)
            out.append(contentsOf: Array(",\"entries\":\(group.entries),\"bytes\":\(group.bytes)}".utf8))
        }
        out.append(contentsOf: Array("]},\"fileBytes\":\(usage.fileBytes)}".utf8))
        return String(decoding: out, as: UTF8.self)
    }

    /// Empty every table (logout purge). The file and its schema survive.
    public func wipe() throws {
        try db.wipe()
    }

    /// Remove rumors from this device for good (`ArmadaDB.forget`); `ids` is a JSON array.
    public func forget(ids: String) throws {
        guard let array = try JSONSerialization.jsonObject(with: Data(ids.utf8)) as? [Any] else {
            throw ArmadaDbError.unusable("ids must be a JSON array")
        }
        try db.forget(ids: array.compactMap { $0 as? String })
    }

    // MARK: - KV
    //
    // Values cross as the JSON text the WebView serialized. Nothing here parses
    // them, so the store never has to agree with JavaScript about how a value
    // round-trips — `undefined`, a `Map`, a `bigint` are the caller's problem in
    // exactly the way the ArmadaKV contract already says they are.

    public func kvGet(key: String) throws -> String? {
        try db.kvGet(key)
    }

    public func kvSet(key: String, value: String) throws {
        try db.kvSet(key, value)
    }

    public func kvDelete(key: String) throws {
        try db.kvDelete(key)
    }

    /// The entries a selector picks out, as `{ key, value }` objects. `value` is
    /// the stored JSON TEXT carried as a string: re-serializing it here would
    /// risk respelling a number, and the WebView is the only side that parses.
    public func kvList(
        prefix: String? = nil,
        start: String? = nil,
        end: String? = nil,
        limit: Int? = nil,
        reverse: Bool = false
    ) throws -> String {
        let entries = try db.kvList(
            prefix: prefix, start: start, end: end, limit: limit, reverse: reverse
        )

        var out = [UInt8]()
        Self.appendEntries(&out, entries)
        return String(decoding: out, as: UTF8.self)
    }

    /// A whole burst of KV operations as ONE crossing — the WebView coalesces a
    /// tick's worth of get/set/delete/list into a single call (see
    /// `NativeArmadaDB.ts`), and the store executes them in arrival order in one
    /// lock turn (one transaction, when the batch writes).
    ///
    /// `ops` is a JSON array of `{ op: "get"|"set"|"delete"|"list", ... }`.
    /// Returns a JSON array aligned with `ops`: the stored JSON text (or null)
    /// for a get, null for a set/delete, an array of `{ key, value }` for a
    /// list.
    public func kvOps(ops raw: String) throws -> String {
        guard let decoded = try? JSONSerialization.jsonObject(with: Data(raw.utf8)),
            let array = decoded as? [Any]
        else {
            throw ArmadaDbError.unusable("ops is not a valid batch")
        }

        var ops = [SqliteArmadaDb.KvOp]()
        for (index, entry) in array.enumerated() {
            guard let body = entry as? [String: Any] else {
                throw ArmadaDbError.unusable("ops[\(index)] is not an object")
            }

            switch body["op"] as? String {
            case "get":
                ops.append(.get(key: try Self.requiredString(body, "key", index)))
            case "set":
                ops.append(
                    .set(
                        key: try Self.requiredString(body, "key", index),
                        json: try Self.requiredString(body, "value", index)
                    )
                )
            case "delete":
                ops.append(.delete(key: try Self.requiredString(body, "key", index)))
            case "list":
                ops.append(
                    .scan(
                        prefix: body["prefix"] as? String,
                        start: body["start"] as? String,
                        end: body["end"] as? String,
                        limit: (body["limit"] as? NSNumber)?.intValue,
                        reverse: (body["reverse"] as? NSNumber)?.boolValue ?? false
                    )
                )
            case let other:
                throw ArmadaDbError.unusable(
                    "ops[\(index)]: unknown op \"\(other ?? "")\""
                )
            }
        }

        let results = try db.kvOps(ops)

        var out = [UInt8]()
        out.append(UInt8(ascii: "["))
        for (index, result) in results.enumerated() {
            if index > 0 { out.append(UInt8(ascii: ",")) }
            switch result {
            case let .entries(entries):
                Self.appendEntries(&out, entries)
            case .value(nil):
                out.append(contentsOf: Array("null".utf8))
            case let .value(json?):
                JsonText.quote(&out, json)
            }
        }
        out.append(UInt8(ascii: "]"))

        return String(decoding: out, as: UTF8.self)
    }

    // MARK: - helpers

    private static func appendEntries(_ out: inout [UInt8], _ entries: [KvEntry]) {
        out.append(UInt8(ascii: "["))
        for (index, entry) in entries.enumerated() {
            if index > 0 { out.append(UInt8(ascii: ",")) }
            out.append(contentsOf: Array(#"{"key":"#.utf8))
            JsonText.quote(&out, entry.key)
            out.append(contentsOf: Array(#","value":"#.utf8))
            JsonText.quote(&out, entry.json)
            out.append(UInt8(ascii: "}"))
        }
        out.append(UInt8(ascii: "]"))
    }

    private static func requiredString(
        _ body: [String: Any], _ name: String, _ index: Int
    ) throws -> String {
        guard let value = body[name] as? String else {
            throw ArmadaDbError.unusable("ops[\(index)]: \(name) is required")
        }
        return value
    }

    /// The filters a call carried.
    ///
    /// Throws rather than falling back to "no constraints": a filter list that
    /// didn't parse is a programming error on the JS side, and answering it with
    /// an unconstrained filter would hand back the whole tenant.
    static func parseFilters(_ raw: String) throws -> [[String: Any]] {
        guard let decoded = try? JSONSerialization.jsonObject(with: Data(raw.utf8)),
            let array = decoded as? [Any]
        else {
            throw ArmadaDbError.unusable("filters is not valid JSON")
        }
        return array.compactMap { $0 as? [String: Any] }
    }
}
