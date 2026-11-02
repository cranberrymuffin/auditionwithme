import AVFoundation
import CryptoKit
import Foundation

enum MediaError: LocalizedError {
    case lineNotLoaded
    case decodeFailed

    var errorDescription: String? {
        switch self {
        case .lineNotLoaded: return "That line's audio isn't loaded"
        case .decodeFailed: return "Couldn't decode the line's audio"
        }
    }
}

/// The single owner of the app's media hardware: the audio session, the
/// audio engines, the mic and the camera. Everything that turns hardware on
/// or off goes through here, and every change is reported with a reason so
/// on-device testing can see exactly when the mic was live.
///
/// Modes:
/// - `idle`: no engine running.
/// - `playback`: a playback-only engine plays the scene partner. It never
///   touches the mic input (`inputNode`), so it can't turn the mic on.
/// - `capture`: (phase 2) a capture engine, created fresh and destroyed on
///   release, runs the mic, the scene partner and the take mix together.
///
/// Playback graph:
///
///     reader line ─▶ player ─▶ timePitch (pace) ─▶ dynamics (level) ─▶ speakers
///
/// The audio session's category is still set at launch (AppDelegate) because
/// the web view's getUserMedia relies on it until native capture replaces
/// it; this controller doesn't change or deactivate the session yet.
///
/// Main-thread only.
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

    /// How long the playback engine keeps running after the last line ends,
    /// so back-to-back cues don't pay to restart it.
    private let idleStopDelay: TimeInterval = 3

    /// Every line is decoded to this before playing, so the graph never has
    /// to be reconnected for a line rendered at a different rate.
    private let lineFormat = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
    private let linesDir: URL

    private var playbackEngine: AVAudioEngine?
    private let player = AVAudioPlayerNode()
    private let timePitch = AVAudioUnitTimePitch()
    private let dynamics = AVAudioUnitEffect(audioComponentDescription: AudioComponentDescription(
        componentType: kAudioUnitType_Effect,
        componentSubType: kAudioUnitSubType_DynamicsProcessor,
        componentManufacturer: kAudioUnitManufacturer_Apple,
        componentFlags: 0,
        componentFlagsMask: 0
    ))
    private var lineToken = 0
    private var playing = false
    private var idleStop: DispatchWorkItem?

    init() {
        linesDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("reader-lines", isDirectory: true)
        try? FileManager.default.createDirectory(at: linesDir, withIntermediateDirectories: true)
    }

    /// Reports the current state, e.g. when the web view starts listening.
    func report(reason: String) {
        print("[media] mode=\(state.mode.rawValue) mic=\(state.mic) camera=\(state.camera) leases=\(state.leases) reason=\(reason)")
        onStateChange?(state, reason)
    }

    private func setMode(_ mode: Mode, reason: String) {
        guard state.mode != mode else { return }
        state.mode = mode
        report(reason: reason)
    }

    // MARK: Playback engine

    /// Builds the playback engine if needed and makes sure it's running.
    /// Never touches `inputNode`.
    private func ensurePlaybackEngine() throws -> AVAudioEngine {
        if let engine = playbackEngine {
            if !engine.isRunning { try engine.start() }
            return engine
        }
        let engine = AVAudioEngine()
        [player, timePitch, dynamics].forEach { engine.attach($0) }
        engine.connect(player, to: timePitch, format: lineFormat)
        engine.connect(timePitch, to: dynamics, format: lineFormat)
        engine.connect(dynamics, to: engine.mainMixerNode, format: lineFormat)
        // The web player's compressor (useTtsPlayer's ensureTap: -24 dB, 4:1,
        // 10 dB knee) evens out loud and quiet renders; the dynamics processor
        // has no ratio and sets its own from the headroom.
        setDynamics(kDynamicsProcessorParam_Threshold, -24)
        setDynamics(kDynamicsProcessorParam_HeadRoom, 6)
        setDynamics(kDynamicsProcessorParam_AttackTime, 0.003)
        setDynamics(kDynamicsProcessorParam_ReleaseTime, 0.25)
        NotificationCenter.default.addObserver(
            self, selector: #selector(playbackEngineConfigurationChanged),
            name: .AVAudioEngineConfigurationChange, object: engine
        )
        engine.prepare()
        try engine.start()
        playbackEngine = engine
        return engine
    }

    /// Route changes (headphones in or out) stop the engine. Restart it only
    /// if a line is playing; an idle engine stays stopped.
    @objc private func playbackEngineConfigurationChanged() {
        DispatchQueue.main.async { [self] in
            guard playing, let engine = playbackEngine, !engine.isRunning else { return }
            try? engine.start()
            report(reason: "playback engine restarted after a route change")
        }
    }

    private func setDynamics(_ parameter: AudioUnitParameterID, _ value: AudioUnitParameterValue) {
        AudioUnitSetParameter(dynamics.audioUnit, parameter, kAudioUnitScope_Global, 0, value, 0)
    }

    private func scheduleIdleStop() {
        idleStop?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.playing else { return }
            self.playbackEngine?.stop()
            self.setMode(.idle, reason: "playback idle")
        }
        idleStop = work
        DispatchQueue.main.asyncAfter(deadline: .now() + idleStopDelay, execute: work)
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

    /// Plays a stored line; returns the token its `onLineEnded` will carry.
    func playLine(key: String, rate: Float, volume: Float) throws -> Int {
        guard hasLine(key: key) else { throw MediaError.lineNotLoaded }
        let buffer = try decodedLine(key)
        idleStop?.cancel()
        _ = try ensurePlaybackEngine()
        // Stopping fires the previous line's completion; the token bump below
        // makes it stale before it lands on the main queue.
        player.stop()
        lineToken += 1
        let token = lineToken
        setRate(rate)
        setVolume(volume)
        player.scheduleBuffer(buffer, at: nil, options: [], completionCallbackType: .dataPlayedBack) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, self.lineToken == token else { return }
                self.playing = false
                self.scheduleIdleStop()
                self.onLineEnded?(token)
            }
        }
        player.play()
        playing = true
        setMode(.playback, reason: "playing a line")
        return token
    }

    func stopLine() {
        lineToken += 1
        player.stop()
        if playing {
            playing = false
            scheduleIdleStop()
        }
    }

    /// Pace, pitch preserved — as HTMLMediaElement.playbackRate is.
    func setRate(_ rate: Float) {
        timePitch.rate = min(max(rate, 0.25), 4)
    }

    /// The speaker's level (lib/characterVolume.ts): unity is 1, up to 2
    /// boosts — as the web player's GainNode does.
    func setVolume(_ volume: Float) {
        player.volume = volume > 0 ? 1 : 0
        setDynamics(kDynamicsProcessorParam_OverallGain, volume > 0 ? max(20 * log10(volume), -40) : 0)
    }
}
