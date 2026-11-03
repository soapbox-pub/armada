import Foundation
import XCTest

@testable import ArmadaDB

/// The wire format the WebView and the store agree on.
///
/// These matter more than their size suggests: the plugin above this is pure
/// Capacitor glue, so this is the last layer either side can be tested against.
/// A response that is well-formed JSON but the wrong SHAPE — a value
/// re-serialized, a `null` where an array belongs, results misaligned with the
/// ops that produced them — would surface as data quietly missing in the app,
/// not as an error.
final class ArmadaDbBridgeTests: XCTestCase {

    private var store: SqliteArmadaDb?

    private func open() throws -> ArmadaDbBridge {
        let db = try SqliteArmadaDb(db: try SqliteDriver(path: ":memory:"))
        store = db
        return ArmadaDbBridge(db: db)
    }

    override func tearDown() {
        store?.close()
        store = nil
        super.tearDown()
    }

    private func rumorJson(id: String, content: String = "hello", createdAt: Int64 = 1000)
        -> String
    {
        #"{"id":"\#(id)","pubkey":"alice","created_at":\#(createdAt),"kind":1,"tags":[["channel","c1"]],"content":"\#(content)"}"#
    }

    private func decodeArray(_ json: String) throws -> [Any] {
        try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [Any]
        )
    }

    func testEventStoresABatchAndQueryReturnsAJsonArray() throws {
        let bridge = try open()
        try bridge.event(
            tenant: "t", rumors: "[\(rumorJson(id: "a")),\(rumorJson(id: "b", createdAt: 2000))]"
        )

        let rumors = try decodeArray(try bridge.query(tenant: "t", filters: "[{}]"))
        XCTAssertEqual(rumors.count, 2)

        let first = try XCTUnwrap(rumors[0] as? [String: Any])
        XCTAssertEqual(first["id"] as? String, "b")
        XCTAssertEqual(first["content"] as? String, "hello")
        XCTAssertEqual((first["kind"] as? NSNumber)?.intValue, 1)
        XCTAssertEqual((first["created_at"] as? NSNumber)?.int64Value, 2000)
        XCTAssertEqual(first["tags"] as? [[String]], [["channel", "c1"]])
    }

    func testQueryOfAnEmptyTenantIsAnEmptyArrayNotNull() throws {
        let bridge = try open()
        XCTAssertEqual(try bridge.query(tenant: "nothing", filters: "[{}]"), "[]")
    }

    func testCountAndRemoveCrossIntact() throws {
        let bridge = try open()
        try bridge.event(tenant: "t", rumors: "[\(rumorJson(id: "a"))]")

        let counted = try bridge.count(tenant: "t", filters: "[{}]")
        XCTAssertEqual(counted.count, 1)
        XCTAssertFalse(counted.approximate)

        try bridge.remove(tenant: "t", filters: ##"[{"ids":["a"]}]"##)
        XCTAssertEqual(try bridge.count(tenant: "t", filters: "[{}]").count, 0)
    }

    func testTenantsIsAJsonArrayOfStrings() throws {
        let bridge = try open()
        try bridge.event(tenant: "main", rumors: "[\(rumorJson(id: "a"))]")
        try bridge.event(tenant: "c2:abc", rumors: "[\(rumorJson(id: "b"))]")

        let tenants = try decodeArray(try bridge.tenants())
        XCTAssertEqual(tenants.compactMap { $0 as? String }, ["main", "c2:abc"])
    }

    func testUsageIsTheArmadaDBUsageShape() throws {
        let bridge = try open()
        try bridge.event(tenant: "c2:\"x\"", rumors: "[\(rumorJson(id: "a"))]")
        try bridge.kvSet(key: "k", value: "1")

        let usage = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(try bridge.usage().utf8)) as? [String: Any]
        )
        let tenants = try XCTUnwrap(usage["tenants"] as? [[String: Any]])
        XCTAssertEqual(tenants.count, 1)
        XCTAssertEqual(tenants[0]["id"] as? String, "c2:\"x\"")
        XCTAssertEqual(tenants[0]["rumors"] as? Int, 1)
        // "hello" (5) + '[["channel","c1"]]' (18) + "a" (1) + "alice" (5)
        XCTAssertEqual(tenants[0]["bytes"] as? Int, 29)
        let kv = try XCTUnwrap(usage["kv"] as? [String: Any])
        XCTAssertEqual(kv["entries"] as? Int, 1)
        XCTAssertEqual(kv["bytes"] as? Int, 2)
        XCTAssertGreaterThan(try XCTUnwrap(usage["fileBytes"] as? Int), 0)
    }

    /// A filter list that didn't parse is a programming error on the JS side.
    /// Answering it with "no constraints" would hand back the whole tenant,
    /// which is the opposite of what a narrowing query should do.
    func testUnparseableFiltersThrowRatherThanMatchingEverything() throws {
        let bridge = try open()
        try bridge.event(tenant: "t", rumors: "[\(rumorJson(id: "a"))]")

        XCTAssertThrowsError(try bridge.query(tenant: "t", filters: "not json"))
        XCTAssertThrowsError(try bridge.query(tenant: "t", filters: #"{"kinds":[1]}"#))
        XCTAssertThrowsError(try bridge.remove(tenant: "t", filters: "nope"))
        // The rumor is still there: nothing ran.
        XCTAssertEqual(try bridge.count(tenant: "t", filters: "[{}]").count, 1)
    }

    func testEventIgnoresEntriesThatAreNotRumors() throws {
        let bridge = try open()
        // A structurally invalid entry is skipped, not fatal: the batch is a
        // page from the wire and one bad row must not lose the rest.
        try bridge.event(
            tenant: "t", rumors: #"[{"nope":1},null,\#(rumorJson(id: "a"))]"#
        )

        XCTAssertEqual(try bridge.count(tenant: "t", filters: "[{}]").count, 1)
    }

    // MARK: - KV

    func testKvEntriesCarryTheirValueAsText() throws {
        let bridge = try open()
        try bridge.kvSet(key: "a:1", value: #"{"since":7}"#)
        try bridge.kvSet(key: "a:2", value: "null")

        let entries = try decodeArray(try bridge.kvList(prefix: "a:"))
        XCTAssertEqual(entries.count, 2)

        let first = try XCTUnwrap(entries[0] as? [String: Any])
        XCTAssertEqual(first["key"] as? String, "a:1")
        // TEXT, not a re-serialized object: the WebView is the only side that
        // parses, so a number can never be respelled in transit.
        XCTAssertEqual(first["value"] as? String, #"{"since":7}"#)

        let second = try XCTUnwrap(entries[1] as? [String: Any])
        XCTAssertEqual(second["value"] as? String, "null")
    }

    func testKvGetIsNilWhenUnset() throws {
        let bridge = try open()
        XCTAssertNil(try bridge.kvGet(key: "missing"))

        try bridge.kvSet(key: "k", value: #""v""#)
        XCTAssertEqual(try bridge.kvGet(key: "k"), #""v""#)

        try bridge.kvDelete(key: "k")
        XCTAssertNil(try bridge.kvGet(key: "k"))
    }

    func testKvOpsResultsAlignWithTheOpsThatProducedThem() throws {
        let bridge = try open()

        let results = try decodeArray(
            try bridge.kvOps(
                ops: """
                    [{"op":"set","key":"a","value":"1"},
                     {"op":"get","key":"a"},
                     {"op":"get","key":"missing"},
                     {"op":"list","prefix":"a"},
                     {"op":"delete","key":"a"},
                     {"op":"get","key":"a"}]
                    """
            )
        )

        XCTAssertEqual(results.count, 6)
        XCTAssertTrue(results[0] is NSNull, "a set answers null")
        XCTAssertEqual(results[1] as? String, "1")
        XCTAssertTrue(results[2] is NSNull, "an unset get answers null")

        let listed = try XCTUnwrap(results[3] as? [Any])
        XCTAssertEqual(listed.count, 1)
        XCTAssertEqual((listed[0] as? [String: Any])?["key"] as? String, "a")

        XCTAssertTrue(results[4] is NSNull, "a delete answers null")
        XCTAssertTrue(results[5] is NSNull, "the get after the delete answers null")
    }

    func testKvOpsListCarriesRangeLimitAndReverse() throws {
        let bridge = try open()
        for n in 1...4 { try bridge.kvSet(key: "log:\(n)", value: "null") }

        let results = try decodeArray(
            try bridge.kvOps(
                ops: """
                    [{"op":"list","prefix":"log:","start":"log:3"},
                     {"op":"list","prefix":"log:","limit":2},
                     {"op":"list","prefix":"log:","limit":1,"reverse":true}]
                    """
            )
        )

        func keys(_ index: Int) throws -> [String] {
            try XCTUnwrap(results[index] as? [Any]).compactMap {
                ($0 as? [String: Any])?["key"] as? String
            }
        }

        XCTAssertEqual(try keys(0), ["log:3", "log:4"])
        XCTAssertEqual(try keys(1), ["log:1", "log:2"])
        XCTAssertEqual(try keys(2), ["log:4"])
    }

    func testKvOpsRejectsABatchItCannotExecute() throws {
        let bridge = try open()

        XCTAssertThrowsError(try bridge.kvOps(ops: "not json"))
        XCTAssertThrowsError(try bridge.kvOps(ops: #"[{"op":"fly","key":"a"}]"#))
        XCTAssertThrowsError(try bridge.kvOps(ops: #"[{"op":"set","key":"a"}]"#))
        XCTAssertThrowsError(try bridge.kvOps(ops: "[3]"))
    }

    /// A batch is parsed in full before any of it executes, so an op the bridge
    /// cannot even read leaves the store untouched rather than half-applied.
    /// (Failure DURING execution is the store's transaction to roll back; this
    /// covers the earlier of the two boundaries.)
    func testARejectedBatchWritesNothing() throws {
        let bridge = try open()

        XCTAssertThrowsError(
            try bridge.kvOps(
                ops: #"[{"op":"set","key":"a","value":"1"},{"op":"fly"}]"#
            )
        )
        XCTAssertNil(try bridge.kvGet(key: "a"))
    }

    // MARK: - escaping

    /// Every string in a response is escaped by the same writer the rumor
    /// bodies use, so a key or value carrying JSON's own punctuation cannot
    /// break the envelope it travels in.
    func testHostileStringsSurviveTheWireFormat() throws {
        let bridge = try open()
        let nasty = "a\"b\\c\u{1}\n\t"

        try bridge.kvSet(key: nasty, value: "{\"v\":\"\(nasty.replacingOccurrences(of: "\"", with: "\\\""))\"}")
        let entries = try decodeArray(try bridge.kvList())
        XCTAssertEqual((entries[0] as? [String: Any])?["key"] as? String, nasty)

        try bridge.event(tenant: nasty, rumors: "[\(rumorJson(id: "a", content: "x"))]")
        let tenants = try decodeArray(try bridge.tenants())
        XCTAssertEqual(tenants.compactMap { $0 as? String }, [nasty])
    }

    // MARK: - tenant ids

    func testTenantIdsMatchTheirJavaScriptSpelling() {
        XCTAssertEqual(ArmadaDbTenants.nip29(relayUrl: "wss://relay.example/"), "nip29:wss://relay.example")
        XCTAssertEqual(ArmadaDbTenants.nip29(relayUrl: "wss://relay.example"), "nip29:wss://relay.example")
        XCTAssertEqual(ArmadaDbTenants.community(idHex: "abc"), "c2:abc")
        XCTAssertEqual(ArmadaDbTenants.serviceQueue(relayUrl: nil), "svc")
        XCTAssertEqual(ArmadaDbTenants.serviceQueue(relayUrl: ""), "svc")
        XCTAssertEqual(
            ArmadaDbTenants.serviceQueue(relayUrl: "wss://relay.example/"),
            "svc:wss://relay.example"
        )
        XCTAssertEqual(
            ArmadaDbTenants.queueRelay(tenant: "svc:wss://relay.example"), "wss://relay.example"
        )
        XCTAssertNil(ArmadaDbTenants.queueRelay(tenant: "svc"))
        XCTAssertNil(ArmadaDbTenants.queueRelay(tenant: "main"))
    }
}
