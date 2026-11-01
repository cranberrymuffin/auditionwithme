import AVFoundation
import CryptoKit
import Foundation

/// The rehearsal's one AVAudioEngine (used through NativeMediaPlugin):
///
///     reader line ─▶ player ─▶ timePitch (pace) ─▶ dynamics (level) ─┬─▶ speakers
///                                                                    └─▶ takeMixer ─▶ take tap (recording)
///     mic ─▶ input (voice processing) ─┬─▶ takeMixer
///                                      └─▶ mic tap (level, speech, Scribe PCM)
///
/// Voice processing is Apple's echo cancellation: the reader playing out of
/// the speaker stays out of the mic, so line tracking never transcribes it
/// and the take carries it once, mixed in directly. The take mix reaches
/// the speakers only through `takeMute` (volume 0) — that keeps it rendering
/// without playing the actor's own voice back at them.
///
/// State is main-thread only; taps run on AVAudioEngine's own threads and
/// hand buffers to the callbacks from there.
final class MediaAudioEngine {
    static let shared = MediaAudioEngine()

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let timePitch = AVAudioUnitTimePitch()
    private let dynamics = AVAudioUnitEffect(audioComponentDescription: AudioComponentDescription(
        componentType: kAudioUnitType_Effect,
        componentSubType: kAudioUnitSubType_DynamicsProcessor,
        componentManufacturer: kAudioUnitManufacturer_Apple,
        componentFlags: 0,
        componentFlagsMask: 0
    ))
    private let takeMixer = AVAudioMixerNode()
    private let takeMute = AVAudioMixerNode()

    /// Every line is decoded to this before playing, so the graph never has
    /// to be reconnected (and the take never glitches) for a line recorded
    /// at a different rate.
    private let lineFormat = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
    private let linesDir: URL

    private var built = false
    private(set) var micOn = false
    private var lineToken = 0
    /// The mic's format while it's on; what `onMicBuffer` delivers.
    private(set) var micFormat: AVAudioFormat?
    /// The take mix's format; what `onTakeBuffer` delivers.
    private(set) var takeFormat: AVAudioFormat?

    var onLineEnded: ((Int) -> Void)?
    var onMicLevel: ((Float) -> Void)?
    var onMicBuffer: ((AVAudioPCMBuffer) -> Void)?
    var onTakeBuffer: ((AVAudioPCMBuffer, AVAudioTime) -> Void)?

    private var lastLevelAt: TimeInterval = 0
    private var levelPeak: Float = 0

    private init() {
        linesDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("reader-lines", isDirectory: true)
        try? FileManager.default.createDirectory(at: linesDir, withIntermediateDirectories: true)
        [player, timePitch, dynamics, takeMixer, takeMute].forEach { engine.attach($0) }
        // The web player's compressor (useTtsPlayer's ensureTap: -24 dB,
        // 4:1, 10 dB knee) evens out loud and quiet renders; the dynamics
        // processor has no ratio, and sets its own from the headroom.
        setDynamics(kDynamicsProcessorParam_Threshold, -24)
        setDynamics(kDynamicsProcessorParam_HeadRoom, 6)
        setDynamics(kDynamicsProcessorParam_AttackTime, 0.003)
        setDynamics(kDynamicsProcessorParam_ReleaseTime, 0.25)
        takeMute.outputVolume = 0
        NotificationCenter.default.addObserver(
            self, selector: #selector(rebuildAfterChange), name: .AVAudioEngineConfigurationChange, object: engine
        )
        NotificationCenter.default.addObserver(
            self, selector: #selector(interrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil
        )
    }

    private func setDynamics(_ parameter: AudioUnitParameterID, _ value: AudioUnitParameterValue) {
        AudioUnitSetParameter(dynamics.audioUnit, parameter, kAudioUnitScope_Global, 0, value, 0)
    }

    // MARK: Graph

    /// (Re)builds and starts the graph, with or without the mic. Voice
    /// processing can only change while the engine is stopped, so turning
    /// the mic on or off restarts the engine — done at rehearsal start and
    /// end, never between lines.
    private func build(withMic: Bool) throws {
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        takeMixer.removeTap(onBus: 0)
        [player, timePitch, dynamics, takeMixer, takeMute].forEach { engine.disconnectNodeOutput($0) }
        engine.disconnectNodeOutput(engine.inputNode)

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
        try session.setActive(true)
        if engine.inputNode.isVoiceProcessingEnabled != withMic {
            try engine.inputNode.setVoiceProcessingEnabled(withMic)
        }

        let main = engine.mainMixerNode
        engine.connect(player, to: timePitch, format: lineFormat)
        engine.connect(timePitch, to: dynamics, format: lineFormat)
        engine.connect(
            dynamics,
            to: [
                AVAudioConnectionPoint(node: main, bus: main.nextAvailableInputBus),
                AVAudioConnectionPoint(node: takeMixer, bus: 0),
            ],
            fromBus: 0,
            format: lineFormat
        )
        if withMic {
            let format = engine.inputNode.outputFormat(forBus: 0)
            engine.connect(engine.inputNode, to: takeMixer, fromBus: 0, toBus: 1, format: format)
            engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                self?.micTap(buffer)
            }
            micFormat = format
        } else {
            micFormat = nil
        }
        let mixFormat = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        engine.connect(takeMixer, to: takeMute, format: mixFormat)
        engine.connect(takeMute, to: main, format: mixFormat)
        takeMixer.installTap(onBus: 0, bufferSize: 4096, format: mixFormat) { [weak self] buffer, time in
            self?.onTakeBuffer?(buffer, time)
        }
        takeFormat = mixFormat

        engine.prepare()
        try engine.start()
        built = true
        micOn = withMic
    }

    private func ensureRunning() throws {
        if !built || !engine.isRunning { try build(withMic: micOn) }
    }

    /// Route changes (headphones in or out) and media-services resets stop
    /// the engine; pick up where it was.
    @objc private func rebuildAfterChange() {
        DispatchQueue.main.async { [self] in
            guard built else { return }
            try? build(withMic: micOn)
        }
    }

    @objc private func interrupted(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              AVAudioSession.InterruptionType(rawValue: raw) == .ended else { return }
        rebuildAfterChange()
    }

    // MARK: Reader lines

    private func lineURL(_ key: String) -> URL {
        let digest = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
        return linesDir.appendingPathComponent(digest)
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

    /// Plays a stored line; returns the token its `onLineEnded` will carry.
    func playLine(key: String, rate: Float, volume: Float) throws -> Int {
        guard FileManager.default.fileExists(atPath: lineURL(key).path) else { throw MediaError.lineNotLoaded }
        try ensureRunning()
        let buffer = try decodedLine(key)
        // Stopping fires the previous line's completion; the token bump
        // below makes it stale before it lands on the main queue.
        player.stop()
        lineToken += 1
        let token = lineToken
        setRate(rate)
        setVolume(volume)
        player.scheduleBuffer(buffer, at: nil, options: [], completionCallbackType: .dataPlayedBack) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, self.lineToken == token else { return }
                self.onLineEnded?(token)
            }
        }
        player.play()
        return token
    }

    func stopLine() {
        lineToken += 1
        player.stop()
    }

    /// Pace, pitch preserved — as HTMLMediaElement.playbackRate is.
    func setRate(_ rate: Float) {
        timePitch.rate = min(max(rate, 0.25), 4)
    }

    /// The speaker's level (lib/characterVolume.ts): unity is 1, above 1
    /// boosts — as the web player's GainNode does.
    func setVolume(_ volume: Float) {
        player.volume = volume > 0 ? 1 : 0
        setDynamics(kDynamicsProcessorParam_OverallGain, volume > 0 ? max(20 * log10(volume), -40) : 0)
    }

    // MARK: Mic

    func startMic(preferredInputId: String?) throws {
        let session = AVAudioSession.sharedInstance()
        if let preferredInputId,
           let port = session.availableInputs?.first(where: { $0.uid == preferredInputId }) {
            try? session.setPreferredInput(port)
        } else {
            try? session.setPreferredInput(nil)
        }
        if !micOn || !engine.isRunning { try build(withMic: true) }
    }

    func stopMic() throws {
        if micOn { try build(withMic: false) }
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
        onMicBuffer?(buffer)
    }
}

enum MediaError: LocalizedError {
    case decodeFailed
    case lineNotLoaded
    case cameraUnavailable
    case permissionDenied(String)

    var errorDescription: String? {
        switch self {
        case .decodeFailed: return "The line's audio couldn't be decoded"
        case .lineNotLoaded: return "notLoaded"
        case .cameraUnavailable: return "No camera is available"
        case .permissionDenied(let what): return "NotAllowedError: \(what) access was denied"
        }
    }
}
