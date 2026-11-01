import ArmadaDB
import Capacitor
import Foundation

/// The WebView's door onto the native store — the iOS transport behind
/// `src/lib/db/NativeArmadaDB.ts`, and the counterpart of `ArmadaDbPlugin.kt`.
///
/// Deliberately nothing but glue. Every filter is planned, every tag tokenized,
/// every NIP-09 deletion applied and every response string built by the
/// `ArmadaDB` package, whose conformance suite runs on Linux under `swift test`
/// — so the only code here that a Mac is needed to compile is the part that
/// cannot be tested anywhere: reading a `CAPPluginCall` and resolving it.
///
/// Everything crosses as JSON TEXT rather than as marshalled objects. Capacitor
/// would have to guess at number types (a `created_at` is 64-bit, a `kind` is
/// not, and JavaScript has one number), and a page of rumors is far cheaper as
/// one string the WebView parses itself than as a few thousand marshalled
/// objects.
///
/// Calls arrive on the bridge's own background queue (`CapacitorBridge`
/// dispatches to a queue labelled "bridge"), so the store's blocking lock is
/// never taken on the main thread.
@objc(ArmadaDbPlugin)
public class ArmadaDbPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "ArmadaDbPlugin"
    public let jsName = "ArmadaDB"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "query", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "event", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "count", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "tenants", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "kvGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "kvSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "kvDelete", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "kvList", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "kvOps", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wipe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forget", returnType: CAPPluginReturnPromise),
    ]

    /// The store, opened on first use.
    ///
    /// `ArmadaDbStore` holds the one connection per path, so this allocates
    /// nothing but the wrapper. Deliberately not cached here as a `Result`: a
    /// failure to open would then be sticky for the life of the process, and a
    /// missing App Group is worth reporting on every call rather than once.
    ///
    /// The file lives in the App Group container, so this is the same database
    /// a notification extension would open in its own process.
    private func db() throws -> ArmadaDbBridge {
        ArmadaDbBridge(db: try ArmadaDbStore.shared(path: try ArmadaDbLocation.path()))
    }

    // MARK: - rumors

    @objc func query(_ call: CAPPluginCall) {
        guard let tenant = call.getString("tenant") else {
            return call.reject("tenant is required")
        }
        guard let filters = call.getString("filters") else {
            return call.reject("filters is required")
        }

        do {
            call.resolve(["rumors": try db().query(tenant: tenant, filters: filters)])
        } catch {
            call.reject("\(error)")
        }
    }

    @objc func event(_ call: CAPPluginCall) {
        guard let tenant = call.getString("tenant") else {
            return call.reject("tenant is required")
        }
        guard let rumors = call.getString("rumors") else {
            return call.reject("rumors is required")
        }

        do {
            try db().event(tenant: tenant, rumors: rumors)
            call.resolve()
        } catch {
            call.reject("\(error)")
        }
    }

    @objc func count(_ call: CAPPluginCall) {
        guard let tenant = call.getString("tenant") else {
            return call.reject("tenant is required")
        }
        guard let filters = call.getString("filters") else {
            return call.reject("filters is required")
        }

        do {
            let counted = try db().count(tenant: tenant, filters: filters)
            call.resolve(["count": counted.count, "approximate": counted.approximate])
        } catch {
            call.reject("\(error)")
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let tenant = call.getString("tenant") else {
            return call.reject("tenant is required")
        }
        guard let filters = call.getString("filters") else {
            return call.reject("filters is required")
        }

        do {
            try db().remove(tenant: tenant, filters: filters)
            call.resolve()
        } catch {
            call.reject("\(error)")
        }
    }

    /// Every tenant that has ever been written to (the logout purge reads this).
    @objc func tenants(_ call: CAPPluginCall) {
        do {
            call.resolve(["tenants": try db().tenants()])
        } catch {
            call.reject("\(error)")
        }
    }

    /// Remove rumors from this device for good (`ArmadaDB.forget`); `ids` is a JSON array.
    @objc func forget(_ call: CAPPluginCall) {
        guard let ids = call.getString("ids") else {
            return call.reject("ids is required")
        }

        do {
            try db().forget(ids: ids)
            call.resolve()
        } catch {
            call.reject("\(error)")
        }
    }

    /// Empty every table (logout purge). The file and its schema survive.
    @objc func wipe(_ call: CAPPluginCall) {
        do {
            try db().wipe()
            call.resolve()
        } catch {
            call.reject("\(error)")
        }
    }

    // MARK: - KV
    //
    // Values cross as the JSON text the WebView serialized. Nothing here parses
    // them, so the store never has to agree with JavaScript about how a value
    // round-trips.

    @objc func kvGet(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("key is required") }

        do {
            // `value` is ABSENT rather than null when the key was never set:
            // the JS side tells the two apart, and a stored JSON `null` is a
            // value like any other.
            if let value = try db().kvGet(key: key) {
                call.resolve(["value": value])
            } else {
                call.resolve([:])
            }
        } catch {
            call.reject("\(error)")
        }
    }

    @objc func kvSet(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("key is required") }
        guard let value = call.getString("value") else {
            return call.reject("value is required")
        }

        do {
            try db().kvSet(key: key, value: value)
            call.resolve()
        } catch {
            call.reject("\(error)")
        }
    }

    @objc func kvDelete(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("key is required") }

        do {
            try db().kvDelete(key: key)
            call.resolve()
        } catch {
            call.reject("\(error)")
        }
    }

    @objc func kvList(_ call: CAPPluginCall) {
        do {
            let entries = try db().kvList(
                prefix: call.getString("prefix"),
                start: call.getString("start"),
                end: call.getString("end"),
                limit: call.getInt("limit"),
                reverse: call.getBool("reverse", false)
            )
            call.resolve(["entries": entries])
        } catch {
            call.reject("\(error)")
        }
    }

    /// A whole burst of KV operations as ONE crossing — the WebView coalesces a
    /// tick's worth of get/set/delete/list into a single call.
    @objc func kvOps(_ call: CAPPluginCall) {
        guard let ops = call.getString("ops") else { return call.reject("ops is required") }

        do {
            call.resolve(["results": try db().kvOps(ops: ops)])
        } catch {
            call.reject("\(error)")
        }
    }
}
