import AVFoundation
import Capacitor
import Foundation
import UIKit

/// The web view's bridge to the native media hardware
/// (src/lib/native/nativeMedia.ts): MediaSessionController for audio and
/// the mic, CameraRecorder for the camera and the take file. Only used
/// inside the iOS app; browsers keep getUserMedia, MediaRecorder and Web
/// Audio.
///
/// The camera and mic are taken together as a capture lease
/// (`acquireCapture`) and handed back with `releaseCapture`. They stay on
/// only while a lease is held, and going to the background releases every
/// lease — finishing a take in progress first, so it isn't lost.
@objc(NativeMediaPlugin)
public class NativeMediaPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeMediaPlugin"
    public let jsName = "NativeMedia"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        // Playback
        CAPPluginMethod(name: "hasLine", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadLine", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "playLine", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopLine", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVolume", returnType: CAPPluginReturnPromise),
        // Capture
        CAPPluginMethod(name: "acquireCapture", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseCapture", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseAll", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPcmStreaming", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listDevices", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setZoom", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showPreview", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hidePreview", returnType: CAPPluginReturnPromise),
        // Recording
        CAPPluginMethod(name: "startRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pauseRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resumeRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopRecording", returnType: CAPPluginReturnPromise),
        // Take files
        CAPPluginMethod(name: "getTapesDir", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keepTake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteTakeFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fileSize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listTakeFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "storageInfo", returnType: CAPPluginReturnPromise),
    ]

    private let media = MediaSessionController()
    private let camera = CameraRecorder.shared
    /// Main thread only.
    private var recording = false
    private var observers: [NSObjectProtocol] = []

    override public func load() {
        media.onStateChange = { [weak self] state, reason in
            var event = state.asDictionary
            event["reason"] = reason
            self?.notifyListeners("mediaState", data: event)
        }
        media.onLineEnded = { [weak self] token in
            self?.notifyListeners("lineEnded", data: ["token": token])
        }
        media.onMicLevel = { [weak self] rms in
            self?.notifyListeners("micLevel", data: ["rms": rms])
        }
        media.onPcmChunk = { [weak self] pcm in
            self?.notifyListeners("pcm", data: ["pcm": pcm])
        }
        media.onTakeBuffer = { [weak self] buffer, time in
            self?.camera.appendAudio(buffer, at: time)
        }
        camera.onInterrupted = { [weak self] interrupted in
            self?.notifyListeners("cameraInterrupted", data: ["interrupted": interrupted])
        }
        observers.append(NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.releaseForBackground()
        })
        DispatchQueue.main.async { [self] in media.report(reason: "plugin loaded") }
    }

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
    }

    /// Runs `work` on the main queue and settles `call` with its result.
    private func onMain(_ call: CAPPluginCall, _ work: @escaping () throws -> [String: Any]?) {
        DispatchQueue.main.async {
            do {
                if let result = try work() { call.resolve(result) } else { call.resolve() }
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func getState(_ call: CAPPluginCall) {
        onMain(call) { [self] in media.state.asDictionary }
    }

    // MARK: Playback

    @objc func hasLine(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("key is required") }
        onMain(call) { [self] in ["loaded": media.hasLine(key: key)] }
    }

    @objc func loadLine(_ call: CAPPluginCall) {
        guard let key = call.getString("key"),
              let base64 = call.getString("base64"),
              let data = Data(base64Encoded: base64) else {
            return call.reject("key and base64 audio are required")
        }
        onMain(call) { [self] in
            try media.storeLine(key: key, data: data)
            return nil
        }
    }

    @objc func playLine(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("key is required") }
        let rate = call.getFloat("rate") ?? 1
        let volume = call.getFloat("volume") ?? 1
        onMain(call) { [self] in ["token": try media.playLine(key: key, rate: rate, volume: volume)] }
    }

    @objc func stopLine(_ call: CAPPluginCall) {
        onMain(call) { [self] in
            media.stopLine()
            return nil
        }
    }

    @objc func setRate(_ call: CAPPluginCall) {
        let rate = call.getFloat("rate") ?? 1
        onMain(call) { [self] in
            media.setRate(rate)
            return nil
        }
    }

    @objc func setVolume(_ call: CAPPluginCall) {
        let volume = call.getFloat("volume") ?? 1
        onMain(call) { [self] in
            media.setVolume(volume)
            return nil
        }
    }

    // MARK: Capture

    /// `{ reason, camera, micId?, cameraId?, zoom? }` → `{ leaseId, camera? }`.
    /// Asks for permission if needed, opens the camera (if asked) and turns
    /// the mic on. Nothing is left on if any step fails.
    @objc func acquireCapture(_ call: CAPPluginCall) {
        let reason = call.getString("reason") ?? "unspecified"
        let wantsCamera = call.getBool("camera") ?? false
        let micId = call.getString("micId")
        let cameraId = call.getString("cameraId")
        let zoom = call.getDouble("zoom")
        Task {
            guard await CameraRecorder.requestAccess(for: .audio) else {
                return call.reject(MediaError.permissionDenied("Microphone").localizedDescription)
            }
            var cameraInfo: [String: Any]?
            if wantsCamera {
                do {
                    let opened = try await camera.open(cameraId: cameraId, zoom: zoom)
                    var info: [String: Any] = [
                        "width": Int(opened.width),
                        "height": Int(opened.height),
                        "zoom": Double(opened.zoom),
                    ]
                    if let range = opened.zoomRange {
                        info["zoomRange"] = ["min": Double(range.lowerBound), "max": Double(range.upperBound)]
                    } else {
                        info["zoomRange"] = NSNull()
                    }
                    cameraInfo = info
                } catch {
                    return call.reject(error.localizedDescription)
                }
            }
            DispatchQueue.main.async { [self] in
                do {
                    let leaseId = try media.acquireCapture(reason: reason, preferredInputId: micId)
                    if wantsCamera { media.setCamera(true, reason: "camera opened: \(reason)") }
                    var result: [String: Any] = ["leaseId": leaseId]
                    if let cameraInfo { result["camera"] = cameraInfo }
                    call.resolve(result)
                } catch {
                    // Don't leave the camera on if the mic couldn't start.
                    if wantsCamera, !media.isCapturing { closeCamera(reason: "mic failed to start") }
                    call.reject(error.localizedDescription)
                }
            }
        }
    }

    /// `{ leaseId, reason }`. Releasing the last lease finishes any take in
    /// progress (its file is dropped — callers stop recording first), closes
    /// the camera and turns the mic off.
    @objc func releaseCapture(_ call: CAPPluginCall) {
        guard let leaseId = call.getInt("leaseId") else { return call.reject("leaseId is required") }
        let reason = call.getString("reason") ?? "released"
        onMain(call) { [self] in
            media.releaseCapture(id: leaseId, reason: reason)
            if !media.isCapturing { stopEverything(reason: reason) }
            return nil
        }
    }

    @objc func releaseAll(_ call: CAPPluginCall) {
        let reason = call.getString("reason") ?? "released all"
        onMain(call) { [self] in
            media.releaseAll(reason: reason)
            stopEverything(reason: reason)
            return nil
        }
    }

    /// Recording and the camera only make sense while capture is on.
    private func stopEverything(reason: String) {
        if recording {
            recording = false
            Task { _ = await camera.stopRecording() }
        }
        closeCamera(reason: reason)
    }

    private func closeCamera(reason: String) {
        guard media.state.camera else { return }
        camera.close()
        media.setCamera(false, reason: "camera closed: \(reason)")
    }

    /// The app is going to the background: finish a take in progress (and
    /// tell the web view where it is, so it's saved like any other), then
    /// release everything.
    private func releaseForBackground() {
        let wasRecording = recording
        recording = false
        guard wasRecording || media.isCapturing else { return }
        // Keep running long enough to finish writing the file.
        var task = UIBackgroundTaskIdentifier.invalid
        task = UIApplication.shared.beginBackgroundTask { UIApplication.shared.endBackgroundTask(task) }
        Task {
            var take: [String: Any]?
            if wasRecording, let url = await camera.stopRecording() { take = Self.describe(url) }
            DispatchQueue.main.async { [self] in
                media.releaseAll(reason: "app went to the background")
                closeCamera(reason: "app went to the background")
                var event: [String: Any] = ["reason": "background"]
                if let take { event["take"] = take }
                notifyListeners("mediaReleased", data: event, retainUntilConsumed: true)
                UIApplication.shared.endBackgroundTask(task)
            }
        }
    }

    @objc func setPcmStreaming(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        onMain(call) { [self] in
            media.setPcmStreaming(enabled)
            return nil
        }
    }

    @objc func listDevices(_ call: CAPPluginCall) {
        let cameras = CameraRecorder.cameras().map { ["id": $0.uniqueID, "label": $0.localizedName] }
        let mics = (AVAudioSession.sharedInstance().availableInputs ?? []).map { ["id": $0.uid, "label": $0.portName] }
        call.resolve(["cameras": cameras, "mics": mics])
    }

    @objc func setZoom(_ call: CAPPluginCall) {
        camera.setZoom(call.getDouble("zoom") ?? 1)
        call.resolve()
    }

    @objc func showPreview(_ call: CAPPluginCall) {
        let frame = CGRect(
            x: call.getDouble("x") ?? 0, y: call.getDouble("y") ?? 0,
            width: call.getDouble("width") ?? 0, height: call.getDouble("height") ?? 0
        )
        let radius = CGFloat(call.getDouble("cornerRadius") ?? 0)
        onMain(call) { [self] in
            guard media.state.camera, let host = bridge?.viewController?.view else { return nil }
            camera.showPreview(in: host, frame: frame, cornerRadius: radius)
            return nil
        }
    }

    @objc func hidePreview(_ call: CAPPluginCall) {
        onMain(call) { [self] in
            camera.hidePreview()
            return nil
        }
    }

    // MARK: Recording

    @objc func startRecording(_ call: CAPPluginCall) {
        onMain(call) { [self] in
            guard media.isCapturing, media.state.camera else { throw MediaError.notCapturing }
            try camera.startRecording(audioFormat: media.takeFormat)
            recording = true
            return nil
        }
    }

    @objc func pauseRecording(_ call: CAPPluginCall) {
        camera.pause()
        call.resolve()
    }

    @objc func resumeRecording(_ call: CAPPluginCall) {
        camera.resume()
        call.resolve()
    }

    /// Finishes the take; resolves with its file (in the temp folder until
    /// kept), or `{ path: null }` if nothing was recorded.
    @objc func stopRecording(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [self] in
            recording = false
            Task {
                guard let url = await camera.stopRecording() else {
                    return call.resolve(["path": NSNull()])
                }
                call.resolve(Self.describe(url))
            }
        }
    }

    // MARK: Take files

    /// Where kept takes live: Application Support, which is backed up and
    /// never purged, unlike the temp and cache folders.
    private static func tapesDir() throws -> URL {
        let dir = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        ).appendingPathComponent("tapes", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private static func describe(_ url: URL) -> [String: Any] {
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        return ["path": url.path, "size": size, "mimeType": "video/mp4"]
    }

    /// The tapes folder's current path. It includes the app's data container,
    /// which iOS can move on reinstall or update — so the web view stores
    /// only file names and resolves them against this each launch.
    @objc func getTapesDir(_ call: CAPPluginCall) {
        do {
            call.resolve(["path": try Self.tapesDir().path])
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    /// Moves a just-recorded take from the temp folder into the tapes folder.
    @objc func keepTake(_ call: CAPPluginCall) {
        guard let path = call.getString("path"), let tapeId = call.getString("tapeId") else {
            return call.reject("path and tapeId are required")
        }
        // The share sheet saves the file under this name.
        let fileName = call.getString("fileName") ?? "\(tapeId).mp4"
        do {
            let destination = try Self.tapesDir().appendingPathComponent(fileName)
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: URL(fileURLWithPath: path), to: destination)
            // A move keeps the recording's own timestamp, which can be hours
            // old (a take finished by backgrounding). Stamp it now, so the
            // web view's orphan cleanup times its grace period from the keep.
            try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: destination.path)
            call.resolve(Self.describe(destination))
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func deleteTakeFile(_ call: CAPPluginCall) {
        if let path = call.getString("path") { try? FileManager.default.removeItem(atPath: path) }
        call.resolve()
    }

    @objc func fileSize(_ call: CAPPluginCall) {
        let path = call.getString("path") ?? ""
        let size = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? 0
        call.resolve(["size": size])
    }

    /// `{ files: [{ name, size, modifiedAt }] }`: every file in the tapes
    /// folder, so the web view can find ones no take points at any more.
    /// `modifiedAt` is milliseconds since 1970.
    @objc func listTakeFiles(_ call: CAPPluginCall) {
        do {
            let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]
            let urls = try FileManager.default.contentsOfDirectory(
                at: Self.tapesDir(), includingPropertiesForKeys: keys
            )
            let files: [[String: Any]] = urls.compactMap { url in
                guard let values = try? url.resourceValues(forKeys: Set(keys)),
                      values.isRegularFile == true else { return nil }
                return [
                    "name": url.lastPathComponent,
                    "size": values.fileSize ?? 0,
                    "modifiedAt": (values.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000,
                ]
            }
            call.resolve(["files": files])
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    /// `{ freeBytes, totalBytes }` for the device. Takes are files, so the
    /// phone's free space, not the web view's storage quota, is what limits
    /// how many more fit. Free space is what iOS would make available for
    /// something the user asked to save (it can clear caches to get there).
    @objc func storageInfo(_ call: CAPPluginCall) {
        do {
            let values = try URL(fileURLWithPath: NSHomeDirectory()).resourceValues(forKeys: [
                .volumeAvailableCapacityForImportantUsageKey, .volumeTotalCapacityKey,
            ])
            call.resolve([
                "freeBytes": values.volumeAvailableCapacityForImportantUsage ?? 0,
                "totalBytes": values.volumeTotalCapacity ?? 0,
            ])
        } catch {
            call.reject(error.localizedDescription)
        }
    }
}
