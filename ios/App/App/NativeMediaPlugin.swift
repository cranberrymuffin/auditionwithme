import AVFoundation
import Capacitor
import Foundation

// The iOS app's own media hardware for rehearsal (src/lib/native/nativeMedia.ts):
// the scene partner's playback, the mic and line tracking, and the camera
// and self-tape recording — in place of WKWebView's getUserMedia,
// MediaRecorder and Web Audio, which crackled live and cost a lot of copying.
// Only used inside the app; browsers keep the web code.
@objc(NativeMediaPlugin)
public class NativeMediaPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeMediaPlugin"
    public let jsName = "NativeMedia"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "loadLine", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "playLine", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopLine", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startMic", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopMic", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startTranscription", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopTranscription", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPcmStreaming", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listDevices", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openCamera", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "closeCamera", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setZoom", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showPreview", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hidePreview", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pauseRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resumeRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keepTake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "storeTakeFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteTakeFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fileSize", returnType: CAPPluginReturnPromise),
    ]

    private let audio = MediaAudioEngine.shared
    private let camera = CameraRecorder.shared

    // Line tracking (main thread): the live on-device transcription, the
    // generation that identifies it, and the Scribe PCM stream.
    private var transcription: AnyObject?
    private var generation = 0
    private var pcmStreaming = false
    /// Guards `transcription`, `pcmStreaming` and `pcmReset`, which the mic
    /// tap thread reads while the main thread changes them.
    private let tapLock = NSLock()
    /// Set on the main thread, honored on the tap thread, which alone owns
    /// the converter and the pending bytes.
    private var pcmReset = false
    /// A new transcription still owes the recognizer the recent audio.
    private var primeTranscription = false
    /// The last half second of mic audio (tap thread only), handed to each
    /// new transcription so the start of the actor's line isn't lost while
    /// the recognizer spins up — what the web tracker's pending buffer did.
    private var recentMic: [AVAudioPCMBuffer] = []
    private var recentMicFrames: AVAudioFrameCount = 0
    private var pcmConverter: AVAudioConverter?
    private var pcmPending = Data()
    private let pcmFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
    /// 128 ms of 16 kHz 16-bit audio — the chunk size the web tracker sent Scribe.
    private let pcmChunkBytes = 2048 * 2

    public override func load() {
        audio.onLineEnded = { [weak self] token in
            self?.notifyListeners("lineEnded", data: ["token": token])
        }
        audio.onMicLevel = { [weak self] rms in
            self?.notifyListeners("micLevel", data: ["rms": rms])
        }
        audio.onMicBuffer = { [weak self] buffer in
            self?.micBuffer(buffer)
        }
        audio.onTakeBuffer = { [weak self] buffer, time in
            self?.camera.appendAudio(buffer, at: time)
        }
        camera.onInterrupted = { [weak self] interrupted in
            self?.notifyListeners("cameraInterrupted", data: ["interrupted": interrupted])
        }
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

    // MARK: Reader lines

    @objc func loadLine(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let base64 = call.getString("base64"),
              let data = Data(base64Encoded: base64) else {
            call.reject("key and base64 are required")
            return
        }
        onMain(call) { [self] in
            try audio.storeLine(key: key, data: data)
            return nil
        }
    }

    @objc func playLine(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("key is required")
            return
        }
        let rate = Float(call.getDouble("rate") ?? 1)
        let volume = Float(call.getDouble("volume") ?? 1)
        onMain(call) { [self] in
            ["token": try audio.playLine(key: key, rate: rate, volume: volume)]
        }
    }

    @objc func stopLine(_ call: CAPPluginCall) {
        onMain(call) { [self] in
            audio.stopLine()
            return nil
        }
    }

    @objc func setRate(_ call: CAPPluginCall) {
        let rate = Float(call.getDouble("rate") ?? 1)
        onMain(call) { [self] in
            audio.setRate(rate)
            return nil
        }
    }

    @objc func setVolume(_ call: CAPPluginCall) {
        let volume = Float(call.getDouble("volume") ?? 1)
        onMain(call) { [self] in
            audio.setVolume(volume)
            return nil
        }
    }

    // MARK: Mic and line tracking

    @objc func startMic(_ call: CAPPluginCall) {
        let micId = call.getString("micId")
        AVAudioSession.sharedInstance().requestRecordPermission { [self] granted in
            guard granted else {
                call.reject(MediaError.permissionDenied("Microphone").localizedDescription)
                return
            }
            onMain(call) { [self] in
                try audio.startMic(preferredInputId: micId)
                return nil
            }
        }
    }

    @objc func stopMic(_ call: CAPPluginCall) {
        onMain(call) { [self] in
            stopTranscriptionNow()
            tapLock.lock()
            pcmStreaming = false
            tapLock.unlock()
            try audio.stopMic()
            return nil
        }
    }

    /// Mic buffers, on the engine's tap thread.
    private func micBuffer(_ buffer: AVAudioPCMBuffer) {
        tapLock.lock()
        let session = transcription
        let streaming = pcmStreaming
        let reset = pcmReset
        let prime = primeTranscription
        pcmReset = false
        primeTranscription = false
        tapLock.unlock()

        if let copy = CameraRecorder.copy(buffer) {
            recentMic.append(copy)
            recentMicFrames += copy.frameLength
            let keep = AVAudioFrameCount(buffer.format.sampleRate / 2)
            while recentMicFrames - (recentMic.first?.frameLength ?? 0) >= keep, recentMic.count > 1 {
                recentMicFrames -= recentMic.removeFirst().frameLength
            }
        }
        if #available(iOS 26.0, *), let session = session as? Transcription {
            if prime {
                // Everything up to and including this buffer.
                recentMic.forEach { session.push($0) }
            } else {
                session.push(buffer)
            }
        }
        if reset {
            pcmPending.removeAll()
            pcmConverter = nil
        }
        if streaming { streamPcm(buffer) }
    }

    private func setTranscription(_ session: AnyObject?) {
        tapLock.lock()
        transcription = session
        primeTranscription = session != nil
        tapLock.unlock()
    }

    @objc func startTranscription(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *) else {
            call.reject("On-device speech needs iOS 26")
            return
        }
        let language = call.getString("language") ?? "en"
        let contextualStrings = call.getArray("contextualStrings", String.self) ?? []
        DispatchQueue.main.async { [self] in
            guard let micFormat = audio.micFormat else {
                call.reject("The mic isn't on")
                return
            }
            stopTranscriptionNow()
            let started = generation
            Task {
                do {
                    let session = try await Transcription.start(
                        language: language,
                        contextualStrings: contextualStrings,
                        inputFormat: micFormat,
                        onResult: { [weak self] text, isFinal in
                            self?.notifyListeners(
                                "transcript", data: ["session": started, "text": text, "isFinal": isFinal]
                            )
                        },
                        onError: { [weak self] message in
                            self?.notifyListeners("transcriptionError", data: ["session": started, "message": message])
                        }
                    )
                    DispatchQueue.main.async { [self] in
                        guard generation == started else {
                            Task { await session.stop() }
                            call.reject("Transcription was stopped before it started")
                            return
                        }
                        setTranscription(session)
                        call.resolve(["session": started])
                    }
                } catch {
                    call.reject(error.localizedDescription)
                }
            }
        }
    }

    /// `{ session }`: stops it if it's still the live one, so a late stop
    /// from a line the web app has left can't end the next line's.
    @objc func stopTranscription(_ call: CAPPluginCall) {
        let session = call.getInt("session")
        onMain(call) { [self] in
            if session == nil || session == generation { stopTranscriptionNow() }
            return nil
        }
    }

    private func stopTranscriptionNow() {
        generation += 1
        if #available(iOS 26.0, *), let session = transcription as? Transcription {
            Task { await session.stop() }
        }
        setTranscription(nil)
    }

    @objc func setPcmStreaming(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        onMain(call) { [self] in
            tapLock.lock()
            pcmStreaming = enabled
            pcmReset = true
            tapLock.unlock()
            return nil
        }
    }

    /// 16 kHz 16-bit mono for Scribe, boosted 3x through a soft limiter as
    /// the web tracker's gain and limiter did, sent in 128 ms chunks.
    private func streamPcm(_ buffer: AVAudioPCMBuffer) {
        if pcmConverter == nil || pcmConverter?.inputFormat != buffer.format {
            pcmConverter = AVAudioConverter(from: buffer.format, to: pcmFormat)
        }
        guard let converter = pcmConverter else { return }
        let ratio = pcmFormat.sampleRate / buffer.format.sampleRate
        guard let converted = AVAudioPCMBuffer(
            pcmFormat: pcmFormat, frameCapacity: AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        ) else { return }
        var supplied = false
        converter.convert(to: converted, error: nil) { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        guard let samples = converted.floatChannelData?[0] else { return }
        for i in 0..<Int(converted.frameLength) {
            let boosted = samples[i] * 3
            let magnitude = abs(boosted)
            let limited = magnitude <= 0.5 ? boosted : (boosted < 0 ? -1 : 1) * (0.5 + 0.5 * tanh((magnitude - 0.5) / 0.5))
            var value = Int16(max(-1, min(1, limited)) * Float(Int16.max)).littleEndian
            withUnsafeBytes(of: &value) { pcmPending.append(contentsOf: $0) }
        }
        while pcmPending.count >= pcmChunkBytes {
            let chunk = pcmPending.prefix(pcmChunkBytes)
            pcmPending.removeFirst(pcmChunkBytes)
            notifyListeners("pcm", data: ["pcm": Data(chunk).base64EncodedString()])
        }
    }

    // MARK: Camera and recording

    @objc func listDevices(_ call: CAPPluginCall) {
        let cameras = CameraRecorder.cameras().map { ["id": $0.uniqueID, "label": $0.localizedName] }
        let mics = (AVAudioSession.sharedInstance().availableInputs ?? []).map { ["id": $0.uid, "label": $0.portName] }
        call.resolve(["cameras": cameras, "mics": mics])
    }

    @objc func openCamera(_ call: CAPPluginCall) {
        let cameraId = call.getString("cameraId")
        let zoom = call.getDouble("zoom")
        Task {
            do {
                let opened = try await camera.open(cameraId: cameraId, zoom: zoom)
                var result: [String: Any] = [
                    "width": Int(opened.width),
                    "height": Int(opened.height),
                    "zoom": Double(opened.zoom),
                ]
                if let range = opened.zoomRange {
                    result["zoomRange"] = ["min": Double(range.lowerBound), "max": Double(range.upperBound)]
                } else {
                    result["zoomRange"] = NSNull()
                }
                call.resolve(result)
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func closeCamera(_ call: CAPPluginCall) {
        camera.close()
        call.resolve()
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
            guard let host = bridge?.viewController?.view else { return nil }
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

    @objc func startRecording(_ call: CAPPluginCall) {
        onMain(call) { [self] in
            guard let format = audio.takeFormat else { throw MediaError.cameraUnavailable }
            try camera.startRecording(audioFormat: format)
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

    @objc func stopRecording(_ call: CAPPluginCall) {
        Task {
            guard let url = await camera.stopRecording() else {
                call.resolve(["path": NSNull()])
                return
            }
            call.resolve(Self.describe(url))
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

    /// Moves a just-recorded take from the temp folder into the tapes folder.
    @objc func keepTake(_ call: CAPPluginCall) {
        guard let path = call.getString("path"), let tapeId = call.getString("tapeId") else {
            call.reject("path and tapeId are required")
            return
        }
        // The share sheet saves the file under this name.
        let fileName = call.getString("fileName") ?? "\(tapeId).mp4"
        do {
            let destination = try Self.tapesDir().appendingPathComponent(fileName)
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: URL(fileURLWithPath: path), to: destination)
            call.resolve(Self.describe(destination))
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    /// Writes a take that exists only as bytes (one recorded in the web
    /// view before native recording) into the tapes folder.
    @objc func storeTakeFile(_ call: CAPPluginCall) {
        guard let tapeId = call.getString("tapeId"), let base64 = call.getString("base64"),
              let data = Data(base64Encoded: base64) else {
            call.reject("tapeId and base64 are required")
            return
        }
        let ext = call.getString("extension") ?? "mp4"
        do {
            let destination = try Self.tapesDir().appendingPathComponent("\(tapeId).\(ext)")
            try data.write(to: destination, options: .atomic)
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
}
