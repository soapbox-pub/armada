import ArmadaNotify
import Capacitor
import Foundation

/// Settings › Storage: the on-disk cache the WebView can't see — the
/// notification extension's sender avatars in the App Group — measured and
/// cleared. The counterpart of `ArmadaStoragePlugin.java`.
@objc(ArmadaStoragePlugin)
public class ArmadaStoragePlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "ArmadaStoragePlugin"
    public let jsName = "ArmadaStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "usage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
    ]

    @objc func usage(_ call: CAPPluginCall) {
        call.resolve(["avatars": AvatarCache.bytes()])
    }

    @objc func clear(_ call: CAPPluginCall) {
        let kind = call.getString("kind") ?? ""
        guard kind == "avatars" else { return call.reject("unknown cache: \(kind)") }
        AvatarCache.clear()
        call.resolve()
    }
}
