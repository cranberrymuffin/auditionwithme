import Capacitor
import Foundation

/// The web view's bridge to MediaSessionController (src/lib/native/nativeMedia.ts).
/// Only used inside the iOS app; browsers keep getUserMedia, MediaRecorder
/// and Web Audio. Capacitor calls these on a background queue; the
/// controller is main-thread only, so every call hops to main.
@objc(NativeMediaPlugin)
public class NativeMediaPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeMediaPlugin"
    public let jsName = "NativeMedia"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hasLine", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadLine", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "playLine", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopLine", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVolume", returnType: CAPPluginReturnPromise),
    ]

    private let media = MediaSessionController()

    override public func load() {
        media.onStateChange = { [weak self] state, reason in
            var event = state.asDictionary
            event["reason"] = reason
            self?.notifyListeners("mediaState", data: event)
        }
        media.onLineEnded = { [weak self] token in
            self?.notifyListeners("lineEnded", data: ["token": token])
        }
        DispatchQueue.main.async { [self] in media.report(reason: "plugin loaded") }
    }

    @objc func getState(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [self] in call.resolve(media.state.asDictionary) }
    }

    @objc func hasLine(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("key is required") }
        DispatchQueue.main.async { [self] in call.resolve(["loaded": media.hasLine(key: key)]) }
    }

    @objc func loadLine(_ call: CAPPluginCall) {
        guard let key = call.getString("key"),
              let base64 = call.getString("base64"),
              let data = Data(base64Encoded: base64) else {
            return call.reject("key and base64 audio are required")
        }
        DispatchQueue.main.async { [self] in
            do {
                try media.storeLine(key: key, data: data)
                call.resolve()
            } catch {
                call.reject("Couldn't store the line: \(error.localizedDescription)")
            }
        }
    }

    @objc func playLine(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("key is required") }
        let rate = call.getFloat("rate") ?? 1
        let volume = call.getFloat("volume") ?? 1
        DispatchQueue.main.async { [self] in
            do {
                call.resolve(["token": try media.playLine(key: key, rate: rate, volume: volume)])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func stopLine(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [self] in
            media.stopLine()
            call.resolve()
        }
    }

    @objc func setRate(_ call: CAPPluginCall) {
        let rate = call.getFloat("rate") ?? 1
        DispatchQueue.main.async { [self] in
            media.setRate(rate)
            call.resolve()
        }
    }

    @objc func setVolume(_ call: CAPPluginCall) {
        let volume = call.getFloat("volume") ?? 1
        DispatchQueue.main.async { [self] in
            media.setVolume(volume)
            call.resolve()
        }
    }
}
