import Capacitor
import Foundation

/// The web view's bridge to MediaSessionController (src/lib/native/nativeMedia.ts).
/// Only used inside the iOS app; browsers keep getUserMedia, MediaRecorder
/// and Web Audio.
@objc(NativeMediaPlugin)
public class NativeMediaPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeMediaPlugin"
    public let jsName = "NativeMedia"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
    ]

    private let media = MediaSessionController()

    override public func load() {
        media.onStateChange = { [weak self] state, reason in
            var event = state.asDictionary
            event["reason"] = reason
            self?.notifyListeners("mediaState", data: event)
        }
        media.report(reason: "plugin loaded")
    }

    @objc func getState(_ call: CAPPluginCall) {
        call.resolve(media.state.asDictionary)
    }
}
