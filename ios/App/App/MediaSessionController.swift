import AVFoundation
import CryptoKit
import Foundation

enum MediaError: LocalizedError {
    case lineNotLoaded
    case decodeFailed
    case cameraUnavailable
    case notCapturing
    case permissionDenied(String)

    var errorDescription: String? {
        switch self {
        case .lineNotLoaded: return "That line's audio isn't loaded"
        case .decodeFailed: return "Couldn't decode the line's audio"
        case .cameraUnavailable: return "No camera is available"
        case .notCapturing: return "The camera and mic aren't on"
        case .permissionDenied(let what): return "NotAllowedError: \(what) access was denied"
        }
    }
}

/// The scene partner's playback chain. Each engine gets its own, since a
/// node can only be attached to one engine.
///
///     reader line ─▶ player ─▶ timePitch (pace) ─▶ dynamics (level)
private final class ReaderChain {
    let player = AVAudioPlayerNode()
    let timePitch = AVAudioUnitTimePitch()
    let dynamics = AVAudioUnitEffect(audioComponentDescription: AudioComponentDescription(
        componentType: kAudioUnitType_Effect,
        componentSubType: kAudioUnitSubType_DynamicsProcessor,
        componentManufacturer: kAudioUnitManufacturer_Apple,
        componentFlags: 0,
        componentFlagsMask: 0
    ))

    init(in engine: AVAudioEngine, format: AVAudioFormat) {
        [player, timePitch, dynamics].forEach { engine.attach($0) }
        engine.connect(player, to: timePitch, format: format)
        engine.connect(timePitch, to: dynamics, format: format)
        // The web player's compressor (useTtsPlayer's ensureTap: -24 dB, 4:1,
        // 10 dB knee) evens out loud and quiet renders; the dynamics processor
        // has no ratio and sets its own from the headroom.
        set(kDynamicsProcessorParam_Threshold, -24)
        set(kDynamicsProcessorParam_HeadRoom, 6)
        set(kDynamicsProcessorParam_AttackTime, 0.003)
        set(kDynamicsProcessorParam_ReleaseTime, 0.25)
    }

    func set(_ parameter: AudioUnitParameterID, _ value: AudioUnitParameterValue) {
        AudioUnitSetParameter(dynamics.audioUnit, parameter, kAudioUnitScope_Global, 0, value, 0)
    }

    /// Pace, pitch preserved — as HTMLMediaElement.playbackRate is.
    func setRate(_ rate: Float) {
        timePitch.rate = min(max(rate, 0.25), 4)
    }

    /// The speaker's level (lib/characterVolume.ts): unity is 1, up to 2
    /// boosts — as the web player's GainNode does.
    func setVolume(_ volume: Float) {
        player.volume = volume > 0 ? 1 : 0
        set(kDynamicsProcessorParam_OverallGain, volume > 0 ? max(20 * log10(volume), -40) : 0)
    }
}

/// The single owner of the app's audio hardware: the audio session, the
/// audio engines and the mic. Everything that turns the mic on or off goes
/// through here, and every change is reported with a reason so on-device
/// testing can see exactly when the mic was live.
///
/// Modes:
/// - `idle`: no engine running.
/// - `playback`: a playback-only engine plays the scene partner. It never
///   touches `inputNode`, so it can't turn the mic on.
/// - `capture`: while at least one capture lease is held, a capture engine
///   runs the mic, the scene partner and the take mix together:
///
///         reader chain ─┬─▶ speakers
///                       └─▶ takeMixer ─▶ take tap (recording) ─▶ takeMute (silent) ─▶ speakers
///         mic ─▶ input (voice processing) ─┬─▶ takeMixer
///                                          └─▶ mic tap (level, Scribe PCM)
///
///   Voice processing is Apple's echo cancellation, which keeps the reader
///   playing out of the speaker out of the mic; it only works for audio
///   played by the same engine, which is why the reader moves onto the
///   capture engine for a take.
///
/// Releasing the last lease destroys the capture engine (a fresh instance is
/// made next time) and deactivates the audio session. An engine that has
/// used its input can keep the mic live for as long as it runs, so the
/// capture engine is never reused for playback.
///
/// The session's category is still set at launch (AppDelegate) for the
/// coaching screen's web recorder; it doesn't turn the mic on by itself.
///
/// State is main-thread only; taps run on the engine's own threads.
final class MediaSessionController {
    enum Mode: String {
        case idle, playback, capture
    }

    struct State {
        var mode: Mode = .idle
        var mic = false
        var camera = false
        var leases = 0

        var asDictionary: [String: Any] {
            ["mode": mode.rawValue, "mic": mic, "camera": camera, "leases": leases]
        }
    }

    private(set) var state = State()

    /// Called on every state change with the reason for it.
    var onStateChange: ((State, String) -> Void)?
    /// Called with a line's token when it finishes playing on its own.
    var onLineEnded: ((Int) -> Void)?
    /// The mic's level, ~20 times a second (tap thread).
    var onMicLevel: ((Float) -> Void)?
    /// 128 ms chunks of 16 kHz 16-bit mono PCM for Scribe, base64 (tap thread).
    var onPcmChunk: ((String) -> Void)?
    /// The take mix, for recording (tap thread).
    var onTakeBuffer: ((AVAudioPCMBuffer, AVAudioTime) -> Void)?

    /// How long the playback engine keeps running after the last line ends,
    /// so back-to-back cues don't pay to restart it.
    private let idleStopDelay: TimeInterval = 3

    /// Every line is decoded to this before playing, so the graph never has
    /// to be reconnected for a line rendered at a different rate.
    private let lineFormat = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
    /// The take mix's format; what `onTakeBuffer` delivers.
    let takeFormat = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
    private let linesDir: URL

    private var playbackEngine: AVAudioEngine?
    private var playbackChain: ReaderChain?
    private var captureEngine: AVAudioEngine?
    private var captureChain: ReaderChain?

    private var leases: [Int: String] = [:]
    private var nextLeaseId = 1

    private var lineToken = 0
    private var playing = false
    private var lastRate: Float = 1
    private var lastVolume: Float = 1
    private var idleStop: DispatchWorkItem?

    // Mic tap state (tap thread), with the flags the main thread sets
    // guarded by `tapLock`.
    private let tapLock = NSLock()
    private var pcmStreaming = false
    private var pcmReset = false
    private var pcmConverter: AVAudioConverter?
    private var pcmPending = Data()
    private let pcmFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
    /// 128 ms of 16 kHz 16-bit audio — the chunk size the web tracker sent Scribe.
    private let pcmChunkBytes = 2048 * 2
    private var lastLevelAt: TimeInterval = 0
    private var levelPeak: Float = 0

    init() {
        linesDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("reader-lines", isDirectory: true)
        try? FileManager.default.createDirectory(at: linesDir, withIntermediateDirectories: true)
        NotificationCenter.default.addObserver(
            self, selector: #selector(interrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil
        )
    }

    /// Reports the current state, e.g. when the web view starts listening.
    func report(reason: String) {
        print("[media] mode=\(state.mode.rawValue) mic=\(state.mic) camera=\(state.camera) leases=\(state.leases) reason=\(reason)")
        onStateChange?(state, reason)
    }

    private func update(reason: String, _ change: (inout State) -> Void) {
        var next = state
        change(&next)
        next.leases = leases.count
        guard next.mode != state.mode || next.mic != state.mic || next.camera != state.camera
            || next.leases != state.leases else { return }
        state = next
        report(reason: reason)
    }

    /// The camera is owned by CameraRecorder; this just records whether it's on.
    func setCamera(_ on: Bool, reason: String) {
        update(reason: reason) { $0.camera = on }
    }

    var isCapturing: Bool { captureEngine != nil }

    // MARK: Playback engine

    /// Builds the playback engine if needed and makes sure it's running.
    /// Never touches `inputNode`.
    private func ensurePlaybackChain() throws -> ReaderChain {
        if let engine = playbackEngine, let chain = playbackChain {
            if !engine.isRunning { try engine.start() }
            return chain
        }
        let engine = AVAudioEngine()
        let chain = ReaderChain(in: engine, format: lineFormat)
        engine.connect(chain.dynamics, to: engine.mainMixerNode, format: lineFormat)
        NotificationCenter.default.addObserver(
            self, selector: #selector(playbackEngineConfigurationChanged),
            name: .AVAudioEngineConfigurationChange, object: engine
        )
        engine.prepare()
        try engine.start()
        playbackEngine = engine
        playbackChain = chain
        return chain
    }

    private func stopPlaybackEngine() {
        playbackChain?.player.stop()
        playbackEngine?.stop()
    }

    /// Route changes (headphones in or out) stop the engine. Restart it only
    /// if a line is playing; an idle engine stays stopped.
    @objc private func playbackEngineConfigurationChanged() {
        DispatchQueue.main.async { [self] in
            guard playing, !isCapturing, let engine = playbackEngine, !engine.isRunning else { return }
            endInterruptedLine(reason: "line cut off by a route change")
            try? engine.start()
            report(reason: "playback engine restarted after a route change")
            scheduleIdleStop()
        }
    }

    /// An engine that stops underneath a playing line (a route change, a
    /// call, Siri) leaves its player stopped, and the line's completion never
    /// comes — the rehearsal would wait on it forever. So the line is ended
    /// here instead: stopped for good, and reported as finished, so the
    /// scene moves on to the actor's turn.
    private func endInterruptedLine(reason: String) {
        guard playing else { return }
        let token = lineToken
        lineToken += 1 // a late completion from the stopped player is stale
        captureChain?.player.stop()
        playbackChain?.player.stop()
        playing = false
        report(reason: reason)
        onLineEnded?(token)
    }

    private func scheduleIdleStop() {
        idleStop?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.playing, !self.isCapturing else { return }
            self.stopPlaybackEngine()
            self.update(reason: "playback idle") { $0.mode = .idle }
        }
        idleStop = work
        DispatchQueue.main.asyncAfter(deadline: .now() + idleStopDelay, execute: work)
    }

    // MARK: Capture engine

    /// Takes a capture lease, turning the mic on if this is the first. The
    /// mic stays on until every lease is released.
    func acquireCapture(reason: String, preferredInputId: String?) throws -> Int {
        let session = AVAudioSession.sharedInstance()
        if let preferredInputId,
           let port = session.availableInputs?.first(where: { $0.uid == preferredInputId }) {
            try? session.setPreferredInput(port)
        } else {
            try? session.setPreferredInput(nil)
        }
        if captureEngine == nil { try buildCaptureEngine() }
        let id = nextLeaseId
        nextLeaseId += 1
        leases[id] = reason
        update(reason: "capture lease \(id) taken: \(reason)") {
            $0.mode = .capture
            $0.mic = true
        }
        return id
    }

    /// Returns a lease; releasing the last one destroys the capture engine.
    /// Unknown ids are ignored, so a release can safely run twice.
    func releaseCapture(id: Int, reason: String) {
        guard leases.removeValue(forKey: id) != nil else { return }
        if leases.isEmpty {
            teardownCapture(reason: "capture lease \(id) released: \(reason)")
        } else {
            update(reason: "capture lease \(id) released: \(reason)") { _ in }
        }
    }

    /// Drops every lease at once (backgrounding, the web view going away).
    func releaseAll(reason: String) {
        guard !leases.isEmpty || captureEngine != nil else { return }
        leases.removeAll()
        teardownCapture(reason: reason)
    }

    private func buildCaptureEngine() throws {
        // One engine at a time plays the reader: the capture engine takes it
        // over so echo cancellation can hear it.
        idleStop?.cancel()
        stopPlaybackEngine()
        playing = false

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
        try session.setActive(true)

        let engine = AVAudioEngine()
        let input = engine.inputNode
        try input.setVoiceProcessingEnabled(true)
        let chain = ReaderChain(in: engine, format: lineFormat)
        chain.setRate(lastRate)
        chain.setVolume(lastVolume)
        let takeMixer = AVAudioMixerNode()
        let takeMute = AVAudioMixerNode()
        engine.attach(takeMixer)
        engine.attach(takeMute)
        takeMute.outputVolume = 0

        let main = engine.mainMixerNode
        engine.connect(
            chain.dynamics,
            to: [
                AVAudioConnectionPoint(node: main, bus: main.nextAvailableInputBus),
                AVAudioConnectionPoint(node: takeMixer, bus: 0),
            ],
            fromBus: 0,
            format: lineFormat
        )
        let micFormat = input.outputFormat(forBus: 0)
        engine.connect(input, to: takeMixer, fromBus: 0, toBus: 1, format: micFormat)
        engine.connect(takeMixer, to: takeMute, format: takeFormat)
        engine.connect(takeMute, to: main, format: takeFormat)

        tapLock.lock()
        pcmReset = true
        tapLock.unlock()
        input.installTap(onBus: 0, bufferSize: 1024, format: micFormat) { [weak self] buffer, _ in
            self?.micTap(buffer)
        }
        takeMixer.installTap(onBus: 0, bufferSize: 4096, format: takeFormat) { [weak self] buffer, time in
            self?.onTakeBuffer?(buffer, time)
        }
        NotificationCenter.default.addObserver(
            self, selector: #selector(captureEngineConfigurationChanged(_:)),
            name: .AVAudioEngineConfigurationChange, object: engine
        )
        engine.prepare()
        try engine.start()
        captureEngine = engine
        captureChain = chain
    }

    /// Stops and throws away the capture engine, then lets the session go.
    private func destroyCaptureEngine() {
        guard let engine = captureEngine else { return }
        NotificationCenter.default.removeObserver(self, name: .AVAudioEngineConfigurationChange, object: engine)
        captureChain?.player.stop()
        engine.inputNode.removeTap(onBus: 0)
        engine.mainMixerNode.removeTap(onBus: 0)
        engine.attachedNodes.compactMap { $0 as? AVAudioMixerNode }.forEach { $0.removeTap(onBus: 0) }
        engine.stop()
        captureEngine = nil
        captureChain = nil
    }

    private func teardownCapture(reason: String) {
        lineToken += 1
        playing = false
        destroyCaptureEngine()
        // Here rather than in destroyCaptureEngine, so a rebuild mid-take
        // keeps sending Scribe its audio.
        tapLock.lock()
        pcmStreaming = false
        tapLock.unlock()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        update(reason: reason) {
            $0.mode = .idle
            $0.mic = false
        }
    }

    /// The engine posts this when its I/O changes: a route change (headphones,
    /// a different mic), and also once just after it starts with voice
    /// processing on. Apple's guidance is to restart the same engine, not
    /// build a new one — building a new one posts this again, which looped.
    /// So: nothing if it's still running, restart it if it stopped, and only
    /// rebuild if a restart fails (at most once a second).
    @objc private func captureEngineConfigurationChanged(_ note: Notification) {
        DispatchQueue.main.async { [self] in
            guard !leases.isEmpty, let engine = captureEngine,
                  (note.object as? AVAudioEngine) === engine, !engine.isRunning else { return }
            endInterruptedLine(reason: "line cut off by a configuration change")
            restartCapture(engine, reason: "capture engine restarted after a configuration change")
        }
    }

    @objc private func interrupted(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .began {
            // iOS has already stopped the engine for the call or Siri.
            DispatchQueue.main.async { [self] in
                endInterruptedLine(reason: "line cut off by an interruption")
                if !isCapturing, playbackEngine != nil {
                    update(reason: "playback interrupted") { $0.mode = .idle }
                }
            }
            return
        }
        DispatchQueue.main.async { [self] in
            // Only a live capture comes back; an idle app stays idle.
            guard !leases.isEmpty, let engine = captureEngine, !engine.isRunning else { return }
            try? AVAudioSession.sharedInstance().setActive(true)
            restartCapture(engine, reason: "capture engine restarted after an interruption")
        }
    }

    private var lastRebuildAt: TimeInterval = 0

    private func restartCapture(_ engine: AVAudioEngine, reason: String) {
        do {
            try engine.start()
            report(reason: reason)
        } catch {
            let now = ProcessInfo.processInfo.systemUptime
            guard now - lastRebuildAt >= 1 else {
                leases.removeAll()
                teardownCapture(reason: "capture engine kept failing to restart: \(error.localizedDescription)")
                return
            }
            lastRebuildAt = now
            rebuildCapture(reason: "capture engine rebuilt after a failed restart")
        }
    }

    private func rebuildCapture(reason: String) {
        destroyCaptureEngine()
        do {
            try buildCaptureEngine()
            report(reason: reason)
        } catch {
            leases.removeAll()
            teardownCapture(reason: "capture engine couldn't restart: \(error.localizedDescription)")
        }
    }

    // MARK: Mic tap (tap thread)

    /// While on, the mic's audio is also sent as Scribe PCM.
    func setPcmStreaming(_ enabled: Bool) {
        tapLock.lock()
        pcmStreaming = enabled
        pcmReset = true
        tapLock.unlock()
    }

    /// The level the web tracker measured on a 3x-boosted signal
    /// (useScribeTracking's analyser), so SILENCE_RMS means the same thing
    /// here: the loudest reading in each ~50 ms window.
    private func micTap(_ buffer: AVAudioPCMBuffer) {
        if let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 {
            var sum: Float = 0
            for i in 0..<Int(buffer.frameLength) { sum += samples[i] * samples[i] }
            levelPeak = max(levelPeak, 3 * (sum / Float(buffer.frameLength)).squareRoot())
            let now = ProcessInfo.processInfo.systemUptime
            if now - lastLevelAt >= 0.05 {
                lastLevelAt = now
                onMicLevel?(levelPeak)
                levelPeak = 0
            }
        }
        tapLock.lock()
        let streaming = pcmStreaming
        let reset = pcmReset
        pcmReset = false
        tapLock.unlock()
        if reset {
            pcmPending.removeAll()
            pcmConverter = nil
        }
        if streaming { streamPcm(buffer) }
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
            onPcmChunk?(Data(chunk).base64EncodedString())
        }
    }

    // MARK: Reader lines

    private func lineURL(_ key: String) -> URL {
        let digest = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
        return linesDir.appendingPathComponent(digest)
    }

    func hasLine(key: String) -> Bool {
        FileManager.default.fileExists(atPath: lineURL(key).path)
    }

    func storeLine(key: String, data: Data) throws {
        try data.write(to: lineURL(key), options: .atomic)
    }

    /// The line decoded to `lineFormat`.
    private func decodedLine(_ key: String) throws -> AVAudioPCMBuffer {
        let file = try AVAudioFile(forReading: lineURL(key))
        let frames = AVAudioFrameCount(file.length)
        guard let source = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames) else {
            throw MediaError.decodeFailed
        }
        try file.read(into: source)
        if file.processingFormat == lineFormat { return source }
        guard let converter = AVAudioConverter(from: file.processingFormat, to: lineFormat) else {
            throw MediaError.decodeFailed
        }
        let ratio = lineFormat.sampleRate / file.processingFormat.sampleRate
        guard let output = AVAudioPCMBuffer(
            pcmFormat: lineFormat, frameCapacity: AVAudioFrameCount(Double(frames) * ratio) + 1024
        ) else { throw MediaError.decodeFailed }
        var supplied = false
        var conversionError: NSError?
        converter.convert(to: output, error: &conversionError) { _, status in
            if supplied {
                status.pointee = .endOfStream
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return source
        }
        if let conversionError { throw conversionError }
        return output
    }

    /// The chain that plays lines right now: the capture engine's during a
    /// take or setup, otherwise the playback engine's.
    private func activeChain() throws -> ReaderChain {
        if let captureChain { return captureChain }
        return try ensurePlaybackChain()
    }

    /// Plays a stored line; returns the token its `onLineEnded` will carry.
    func playLine(key: String, rate: Float, volume: Float) throws -> Int {
        guard hasLine(key: key) else { throw MediaError.lineNotLoaded }
        let buffer = try decodedLine(key)
        idleStop?.cancel()
        let chain = try activeChain()
        // Stopping fires the previous line's completion; the token bump below
        // makes it stale before it lands on the main queue.
        chain.player.stop()
        lineToken += 1
        let token = lineToken
        setRate(rate)
        setVolume(volume)
        chain.player.scheduleBuffer(buffer, at: nil, options: [], completionCallbackType: .dataPlayedBack) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, self.lineToken == token else { return }
                self.playing = false
                if !self.isCapturing { self.scheduleIdleStop() }
                self.onLineEnded?(token)
            }
        }
        chain.player.play()
        playing = true
        if !isCapturing {
            update(reason: "playing a line") { $0.mode = .playback }
        }
        return token
    }

    func stopLine() {
        lineToken += 1
        captureChain?.player.stop()
        playbackChain?.player.stop()
        if playing {
            playing = false
            if !isCapturing { scheduleIdleStop() }
        }
    }

    func setRate(_ rate: Float) {
        lastRate = rate
        captureChain?.setRate(rate)
        playbackChain?.setRate(rate)
    }

    func setVolume(_ volume: Float) {
        lastVolume = volume
        captureChain?.setVolume(volume)
        playbackChain?.setVolume(volume)
    }
}
