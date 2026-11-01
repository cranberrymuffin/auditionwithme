import AVFoundation
import Capacitor
import Foundation
import Speech
#if canImport(FoundationModels)
import FoundationModels
#endif

// Apple's on-device models, exposed to the web app (src/lib/native/appleAI.ts)
// so rehearsal work that used to be a paid API call can run on the phone:
//
// - Speech: SpeechAnalyzer + SpeechTranscriber follow the actor's line in
//   place of ElevenLabs Scribe. The web app keeps capturing the mic (the
//   self-tape recorder owns the only MediaStream) and pushes the same 16 kHz
//   16-bit mono PCM it would have sent Scribe; nothing here opens the mic.
// - Language model: Foundation Models judges a paraphrased line (in place of
//   the Haiku semantic match) and directs lines (in place of the Sonnet
//   director). Prompts come from the web app; the structured output types
//   live here because guided generation needs them at compile time.
//
// Everything is iOS 26+. On older systems, or devices without Apple
// Intelligence, the status calls say so and the web app uses the cloud.
@objc(AppleAIPlugin)
public class AppleAIPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppleAIPlugin"
    public let jsName = "AppleAI"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "speechStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "installSpeech", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startTranscription", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pushAudio", returnType: CAPPluginReturnNone),
        CAPPluginMethod(name: "stopTranscription", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "modelStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "semanticMatch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "directLines", returnType: CAPPluginReturnPromise),
    ]

    /// The live transcription (a `Transcription` on iOS 26). One at a time:
    /// the web app opens one per actor line, as it did Scribe sockets.
    private var transcription: AnyObject?
    /// Bumped on every start/stop, so a start that finishes preparing after
    /// a newer start or a stop doesn't install itself as the live session.
    private var generation = 0

    // MARK: Speech

    /// `{ status }`: "installed" (ready now), "supported" (needs a one-time
    /// model download, see installSpeech), "downloading", or "unsupported".
    @objc func speechStatus(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *) else {
            call.resolve(["status": "unsupported"])
            return
        }
        let language = call.getString("language") ?? "en"
        Task {
            call.resolve(["status": await Transcription.status(language: language)])
        }
    }

    /// Downloads the speech model for a language. Resolves once installed.
    @objc func installSpeech(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *) else {
            call.reject("On-device speech needs iOS 26")
            return
        }
        let language = call.getString("language") ?? "en"
        Task {
            do {
                try await Transcription.install(language: language)
                call.resolve()
            } catch {
                call.reject("Speech model download failed: \(error.localizedDescription)")
            }
        }
    }

    /// Starts transcribing pushed audio and resolves `{ session }`. Emits
    /// `transcript` events `{ session, text, isFinal }`: a volatile
    /// (in-progress) guess replaces the last one, and a final result commits
    /// that stretch of speech — the same partial/committed shape Scribe
    /// sends. `session` lets the web app drop a late result from the
    /// previous line. Rejects if the model isn't installed; the web app
    /// falls back to Scribe.
    @objc func startTranscription(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *) else {
            call.reject("On-device speech needs iOS 26")
            return
        }
        let language = call.getString("language") ?? "en"
        let contextualStrings = call.getArray("contextualStrings", String.self) ?? []
        // Session state is only touched on the main queue.
        DispatchQueue.main.async {
            self.stopCurrent()
            self.beginTranscription(call, language: language, contextualStrings: contextualStrings)
        }
    }

    @available(iOS 26.0, *)
    private func beginTranscription(_ call: CAPPluginCall, language: String, contextualStrings: [String]) {
        let started = generation
        Task {
            do {
                let session = try await Transcription.start(
                    language: language,
                    contextualStrings: contextualStrings,
                    onResult: { [weak self] text, isFinal in
                        self?.notifyListeners(
                            "transcript", data: ["session": started, "text": text, "isFinal": isFinal]
                        )
                    },
                    onError: { [weak self] message in
                        self?.notifyListeners("transcriptionError", data: ["session": started, "message": message])
                    }
                )
                DispatchQueue.main.async {
                    guard self.generation == started else {
                        Task { await session.stop() }
                        call.reject("Transcription was stopped before it started")
                        return
                    }
                    self.transcription = session
                    call.resolve(["session": started])
                }
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    /// `{ pcm }`: base64 16 kHz 16-bit little-endian mono PCM.
    @objc func pushAudio(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *),
              let pcm = call.getString("pcm"),
              let data = Data(base64Encoded: pcm) else { return }
        DispatchQueue.main.async {
            (self.transcription as? Transcription)?.push(data)
        }
    }

    /// `{ session }`: stops that session if it's still the live one, so a
    /// late stop from a line the web app has left can't end the next line's.
    @objc func stopTranscription(_ call: CAPPluginCall) {
        let session = call.getInt("session")
        DispatchQueue.main.async {
            if session == nil || session == self.generation { self.stopCurrent() }
            call.resolve()
        }
    }

    private func stopCurrent() {
        generation += 1
        if #available(iOS 26.0, *), let session = transcription as? Transcription {
            Task { await session.stop() }
        }
        transcription = nil
    }

    // MARK: Language model

    /// `{ status }`: "available", "deviceNotEligible",
    /// "appleIntelligenceNotEnabled", "modelNotReady", "unsupportedLanguage"
    /// or "unsupported" (before iOS 26).
    @objc func modelStatus(_ call: CAPPluginCall) {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            let model = SystemLanguageModel.default
            switch model.availability {
            case .available:
                let language = call.getString("language") ?? "en"
                let supported = model.supportsLocale(Locale(identifier: language))
                call.resolve(["status": supported ? "available" : "unsupportedLanguage"])
            case .unavailable(.deviceNotEligible):
                call.resolve(["status": "deviceNotEligible"])
            case .unavailable(.appleIntelligenceNotEnabled):
                call.resolve(["status": "appleIntelligenceNotEnabled"])
            case .unavailable(.modelNotReady):
                call.resolve(["status": "modelNotReady"])
            case .unavailable:
                call.resolve(["status": "unsupported"])
            }
            return
        }
        #endif
        call.resolve(["status": "unsupported"])
    }

    /// `{ instructions, prompt }` → `{ match }`.
    @objc func semanticMatch(_ call: CAPPluginCall) {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            guard let instructions = call.getString("instructions"),
                  let prompt = call.getString("prompt") else {
                call.reject("instructions and prompt are required")
                return
            }
            Task {
                do {
                    let session = LanguageModelSession(instructions: instructions)
                    let response = try await session.respond(
                        to: prompt,
                        generating: LineVerdict.self,
                        options: GenerationOptions(sampling: .greedy)
                    )
                    call.resolve(["match": response.content.match])
                } catch {
                    call.reject("On-device match failed: \(error.localizedDescription)")
                }
            }
            return
        }
        #endif
        call.reject("On-device language model needs iOS 26")
    }

    /// `{ instructions, prompt }` → `{ lines: [{ row, markup }] }`: only the
    /// rows the model chose to mark up. The web app validates each one
    /// (sanitizePerformance) before using it.
    @objc func directLines(_ call: CAPPluginCall) {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            guard let instructions = call.getString("instructions"),
                  let prompt = call.getString("prompt") else {
                call.reject("instructions and prompt are required")
                return
            }
            Task {
                do {
                    let session = LanguageModelSession(instructions: instructions)
                    let response = try await session.respond(
                        to: prompt,
                        generating: DirectedScene.self,
                        options: GenerationOptions(sampling: .greedy)
                    )
                    call.resolve([
                        "lines": response.content.lines.map { ["row": $0.row, "markup": $0.markup] },
                    ])
                } catch {
                    call.reject("On-device direction failed: \(error.localizedDescription)")
                }
            }
            return
        }
        #endif
        call.reject("On-device language model needs iOS 26")
    }
}

#if canImport(FoundationModels)
@available(iOS 26.0, *)
@Generable
struct LineVerdict {
    @Guide(description: "true if the transcript is consistent with the actor having spoken the script line")
    var match: Bool
}

@available(iOS 26.0, *)
@Generable
struct DirectedLine {
    @Guide(description: "The row number of the line being marked up")
    var row: Int
    @Guide(description: "That row's exact words with performance markup added")
    var markup: String
}

@available(iOS 26.0, *)
@Generable
struct DirectedScene {
    @Guide(description: "Only the rows that need markup; rows fine as written are left out")
    var lines: [DirectedLine]
}
#endif

/// One SpeechAnalyzer session fed by pushed PCM.
@available(iOS 26.0, *)
final class Transcription {
    /// What the web app sends: Scribe's input format.
    private static let pushedFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true
    )!

    private let analyzer: SpeechAnalyzer
    private let input: AsyncStream<AnalyzerInput>.Continuation
    private let converter: AVAudioConverter?
    private let analyzerFormat: AVAudioFormat
    private var resultsTask: Task<Void, Never>?

    private init(
        analyzer: SpeechAnalyzer,
        input: AsyncStream<AnalyzerInput>.Continuation,
        analyzerFormat: AVAudioFormat
    ) {
        self.analyzer = analyzer
        self.input = input
        self.analyzerFormat = analyzerFormat
        converter = analyzerFormat == Self.pushedFormat
            ? nil
            : AVAudioConverter(from: Self.pushedFormat, to: analyzerFormat)
    }

    private static func transcriber(language: String) async -> SpeechTranscriber? {
        guard let locale = await SpeechTranscriber.supportedLocale(
            equivalentTo: Locale(identifier: language)
        ) else { return nil }
        // Volatile results give the line tracker words while the actor is
        // still mid-sentence, as Scribe's partials did; fastResults trades a
        // little accuracy for lower latency, which the reader's cue needs.
        return SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults, .fastResults],
            attributeOptions: []
        )
    }

    static func status(language: String) async -> String {
        guard SpeechTranscriber.isAvailable,
              let transcriber = await transcriber(language: language) else { return "unsupported" }
        switch await AssetInventory.status(forModules: [transcriber]) {
        case .installed: return "installed"
        case .downloading: return "downloading"
        case .supported: return "supported"
        case .unsupported: return "unsupported"
        @unknown default: return "unsupported"
        }
    }

    static func install(language: String) async throws {
        guard let transcriber = await transcriber(language: language) else {
            throw TranscriptionError.unsupportedLanguage
        }
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall()
        }
    }

    static func start(
        language: String,
        contextualStrings: [String],
        onResult: @escaping (String, Bool) -> Void,
        onError: @escaping (String) -> Void
    ) async throws -> Transcription {
        guard let transcriber = await transcriber(language: language) else {
            throw TranscriptionError.unsupportedLanguage
        }
        guard await AssetInventory.status(forModules: [transcriber]) == .installed else {
            throw TranscriptionError.notInstalled
        }
        // Lingering keeps the model loaded between lines, so the actor's next
        // line doesn't wait on a reload.
        let analyzer = SpeechAnalyzer(
            modules: [transcriber],
            options: SpeechAnalyzer.Options(priority: .userInitiated, modelRetention: .lingering)
        )
        let format = await SpeechAnalyzer.bestAvailableAudioFormat(
            compatibleWith: [transcriber], considering: pushedFormat
        ) ?? pushedFormat
        // The line's names and unusual words (extractKeyterms), as Scribe's
        // keyterms were, so the recognizer favors them.
        if !contextualStrings.isEmpty {
            let context = AnalysisContext()
            context.contextualStrings[.general] = contextualStrings
            try await analyzer.setContext(context)
        }
        try await analyzer.prepareToAnalyze(in: format)

        let (stream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
        let session = Transcription(analyzer: analyzer, input: continuation, analyzerFormat: format)
        session.resultsTask = Task {
            do {
                for try await result in transcriber.results {
                    onResult(String(result.text.characters), result.isFinal)
                }
            } catch {
                if !Task.isCancelled { onError(error.localizedDescription) }
            }
        }
        try await analyzer.start(inputSequence: stream)
        return session
    }

    func push(_ data: Data) {
        let frames = AVAudioFrameCount(data.count / 2)
        guard frames > 0,
              let pcm = AVAudioPCMBuffer(pcmFormat: Self.pushedFormat, frameCapacity: frames),
              let channel = pcm.int16ChannelData else { return }
        pcm.frameLength = frames
        data.withUnsafeBytes { raw in
            channel[0].update(from: raw.bindMemory(to: Int16.self).baseAddress!, count: Int(frames))
        }
        guard let converter else {
            input.yield(AnalyzerInput(buffer: pcm))
            return
        }
        let ratio = analyzerFormat.sampleRate / Self.pushedFormat.sampleRate
        let capacity = AVAudioFrameCount((Double(frames) * ratio).rounded(.up)) + 32
        guard let converted = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: capacity) else { return }
        var supplied = false
        var conversionError: NSError?
        converter.convert(to: converted, error: &conversionError) { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return pcm
        }
        if conversionError == nil, converted.frameLength > 0 {
            input.yield(AnalyzerInput(buffer: converted))
        }
    }

    /// Drops whatever is still in flight: the web app has already moved on
    /// to the next line, so there's no point finalizing this one.
    func stop() async {
        input.finish()
        resultsTask?.cancel()
        await analyzer.cancelAndFinishNow()
    }
}

enum TranscriptionError: LocalizedError {
    case unsupportedLanguage
    case notInstalled

    var errorDescription: String? {
        switch self {
        case .unsupportedLanguage: return "This language isn't supported by on-device speech"
        case .notInstalled: return "The on-device speech model isn't downloaded yet"
        }
    }
}
