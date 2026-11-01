import AVFoundation
import UIKit

/// The camera for self-tapes (used through NativeMediaPlugin): a preview
/// drawn natively over the web view where the page reserves room for it,
/// and recording to an .mp4 with AVAssetWriter — video from the camera,
/// audio from MediaAudioEngine's take mix (mic plus reader). Both carry
/// host-clock timestamps, which is how the writer keeps them in sync.
final class CameraRecorder: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    static let shared = CameraRecorder()

    private let session = AVCaptureSession()
    private let videoOutput = AVCaptureVideoDataOutput()
    private let sessionQueue = DispatchQueue(label: "camera.session")
    /// Video frames and audio buffers both land here, so writer state has
    /// one owner.
    private let writerQueue = DispatchQueue(label: "camera.writer")
    private var device: AVCaptureDevice?
    private var previewView: PreviewView?
    private var rotationCoordinator: AnyObject?

    var onInterrupted: ((Bool) -> Void)?

    // Writer state: writerQueue only.
    private var recording = false
    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?
    private var outputURL: URL?
    private var sessionStart: CMTime?
    private var paused = false
    private var pausedAt: CMTime?
    private var timeOffset = CMTime.zero
    private var audioFormat: AVAudioFormat?
    /// Where the next audio buffer starts: each one follows the last
    /// exactly, so the track has no gaps for the encoder to fill with
    /// silence (clock time alone jitters by a few milliseconds per buffer).
    private var nextAudioPts: CMTime?

    private override init() {
        super.init()
        session.automaticallyConfiguresApplicationAudioSession = false
        videoOutput.setSampleBufferDelegate(self, queue: writerQueue)
        videoOutput.alwaysDiscardsLateVideoFrames = false
        NotificationCenter.default.addObserver(
            self, selector: #selector(wasInterrupted), name: .AVCaptureSessionWasInterrupted, object: session
        )
        NotificationCenter.default.addObserver(
            self, selector: #selector(interruptionEnded), name: .AVCaptureSessionInterruptionEnded, object: session
        )
    }

    @objc private func wasInterrupted() { onInterrupted?(true) }
    @objc private func interruptionEnded() { onInterrupted?(false) }

    // MARK: Devices

    static func cameras() -> [AVCaptureDevice] {
        AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .builtInUltraWideCamera, .builtInTelephotoCamera],
            mediaType: .video,
            position: .unspecified
        ).devices
    }

    static func requestAccess(for media: AVMediaType) async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: media) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: media)
        default: return false
        }
    }

    // MARK: Camera

    struct Opened {
        let width: Int32
        let height: Int32
        let zoomRange: ClosedRange<CGFloat>?
        let zoom: CGFloat
    }

    /// Opens the chosen camera (front by default) at 1080p where it can.
    func open(cameraId: String?, zoom: Double?) async throws -> Opened {
        guard await Self.requestAccess(for: .video) else { throw MediaError.permissionDenied("Camera") }
        let chosen = cameraId.flatMap { id in Self.cameras().first { $0.uniqueID == id } }
            ?? AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front)
            ?? AVCaptureDevice.default(for: .video)
        guard let camera = chosen else { throw MediaError.cameraUnavailable }
        let input = try AVCaptureDeviceInput(device: camera)

        return try await withCheckedThrowingContinuation { continuation in
            sessionQueue.async { [self] in
                session.beginConfiguration()
                session.inputs.forEach { session.removeInput($0) }
                session.sessionPreset = session.canSetSessionPreset(.hd1920x1080) ? .hd1920x1080 : .high
                guard session.canAddInput(input) else {
                    session.commitConfiguration()
                    continuation.resume(throwing: MediaError.cameraUnavailable)
                    return
                }
                session.addInput(input)
                if !session.outputs.contains(videoOutput), session.canAddOutput(videoOutput) {
                    session.addOutput(videoOutput)
                }
                session.commitConfiguration()
                if !session.isRunning { session.startRunning() }
                device = camera

                // Zoom past 4x is digital mush for a self-tape; offer up to that.
                let range = camera.minAvailableVideoZoomFactor...min(camera.maxAvailableVideoZoomFactor, 4)
                let initial = min(max(CGFloat(zoom ?? 1), range.lowerBound), range.upperBound)
                applyZoom(initial)
                let dims = CMVideoFormatDescriptionGetDimensions(camera.activeFormat.formatDescription)
                continuation.resume(returning: Opened(
                    width: dims.width,
                    height: dims.height,
                    zoomRange: range.upperBound > range.lowerBound ? range : nil,
                    zoom: initial
                ))
            }
        }
    }

    func close() {
        sessionQueue.async { [self] in
            if session.isRunning { session.stopRunning() }
            session.inputs.forEach { session.removeInput($0) }
            device = nil
        }
        DispatchQueue.main.async { [self] in
            previewView?.removeFromSuperview()
            previewView = nil
            rotationCoordinator = nil
        }
    }

    private func applyZoom(_ value: CGFloat) {
        guard let device, (try? device.lockForConfiguration()) != nil else { return }
        device.videoZoomFactor = min(max(value, device.minAvailableVideoZoomFactor), device.maxAvailableVideoZoomFactor)
        device.unlockForConfiguration()
    }

    func setZoom(_ value: Double) {
        sessionQueue.async { [self] in applyZoom(CGFloat(value)) }
    }

    // MARK: Preview (main thread)

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    /// Shows the preview over `host` at `frame` (web view coordinates =
    /// CSS pixels, since the web view fills the screen).
    func showPreview(in host: UIView, frame: CGRect, cornerRadius: CGFloat) {
        let view: PreviewView
        if let existing = previewView {
            view = existing
        } else {
            view = PreviewView()
            view.previewLayer.session = session
            view.previewLayer.videoGravity = .resizeAspectFill
            view.isUserInteractionEnabled = false
            view.clipsToBounds = true
            host.addSubview(view)
            previewView = view
        }
        view.frame = frame
        view.layer.cornerRadius = cornerRadius
        view.isHidden = false
        host.bringSubviewToFront(view)
        updatePreviewRotation()
    }

    func hidePreview() {
        previewView?.isHidden = true
    }

    private func updatePreviewRotation() {
        guard let view = previewView, let connection = view.previewLayer.connection else { return }
        // Unmirrored, like the web preview: the actor sees what the tape will.
        if connection.isVideoMirroringSupported {
            connection.automaticallyAdjustsVideoMirroring = false
            connection.isVideoMirrored = false
        }
        if #available(iOS 17.0, *) {
            if rotationCoordinator == nil, let device {
                rotationCoordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: view.previewLayer)
            }
            if let coordinator = rotationCoordinator as? AVCaptureDevice.RotationCoordinator {
                let angle = coordinator.videoRotationAngleForHorizonLevelPreview
                if connection.isVideoRotationAngleSupported(angle) { connection.videoRotationAngle = angle }
            }
        } else if connection.isVideoOrientationSupported {
            connection.videoOrientation = Self.videoOrientation()
        }
    }

    /// The interface's orientation as the camera names it (the two enums
    /// share names for the interface — it's UIDeviceOrientation that's
    /// flipped).
    private static func videoOrientation() -> AVCaptureVideoOrientation {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        switch scene?.interfaceOrientation {
        case .landscapeLeft: return .landscapeLeft
        case .landscapeRight: return .landscapeRight
        case .portraitUpsideDown: return .portraitUpsideDown
        default: return .portrait
        }
    }

    // MARK: Recording

    /// Starts recording; frames are upright for the interface's orientation
    /// at this moment, as the web recorder's were. `audioFormat` is
    /// MediaAudioEngine's take mix.
    func startRecording(audioFormat: AVAudioFormat) throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("take-\(UUID().uuidString).mp4")
        DispatchQueue.main.async { [self] in
            // Upright frames for the writer, unmirrored (only the preview
            // is a mirror).
            if let connection = videoOutput.connection(with: .video) {
                if #available(iOS 17.0, *),
                   let coordinator = rotationCoordinator as? AVCaptureDevice.RotationCoordinator {
                    let angle = coordinator.videoRotationAngleForHorizonLevelCapture
                    if connection.isVideoRotationAngleSupported(angle) { connection.videoRotationAngle = angle }
                } else if connection.isVideoOrientationSupported {
                    connection.videoOrientation = Self.videoOrientation()
                }
                if connection.isVideoMirroringSupported {
                    connection.automaticallyAdjustsVideoMirroring = false
                    connection.isVideoMirrored = false
                }
            }
            writerQueue.async { [self] in
                outputURL = url
                self.audioFormat = audioFormat
                writer = nil
                videoInput = nil
                audioInput = nil
                sessionStart = nil
                paused = false
                pausedAt = nil
                timeOffset = .zero
                nextAudioPts = nil
                recording = true
            }
        }
    }

    func pause() {
        writerQueue.async { [self] in
            guard recording, !paused else { return }
            paused = true
            pausedAt = CMClockGetTime(CMClockGetHostTimeClock())
        }
    }

    func resume() {
        writerQueue.async { [self] in
            guard recording, paused, let pausedAt else { return }
            // Everything after the pause shifts back by its length, so the
            // file has no gap.
            timeOffset = CMTimeAdd(timeOffset, CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), pausedAt))
            self.pausedAt = nil
            paused = false
        }
    }

    /// Finishes the file; resolves with its URL, or nil if no frame was
    /// ever written.
    func stopRecording() async -> URL? {
        await withCheckedContinuation { continuation in
            writerQueue.async { [self] in
                recording = false
                guard let writer, writer.status == .writing else {
                    self.writer = nil
                    continuation.resume(returning: nil)
                    return
                }
                videoInput?.markAsFinished()
                audioInput?.markAsFinished()
                let url = outputURL
                writer.finishWriting {
                    continuation.resume(returning: writer.status == .completed ? url : nil)
                }
                self.writer = nil
            }
        }
    }

    /// The first frame after start sets up the writer, sized to the frames
    /// actually arriving (rotation included).
    private func makeWriter(for sample: CMSampleBuffer) -> Bool {
        guard let outputURL, let format = CMSampleBufferGetFormatDescription(sample),
              let audioFormat else { return false }
        let dims = CMVideoFormatDescriptionGetDimensions(format)
        do {
            let newWriter = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
            let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: dims.width,
                AVVideoHeightKey: dims.height,
                AVVideoCompressionPropertiesKey: [
                    AVVideoAverageBitRateKey: 8_000_000,
                    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                ],
            ])
            video.expectsMediaDataInRealTime = true
            let audio = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: audioFormat.sampleRate,
                AVNumberOfChannelsKey: audioFormat.channelCount,
                AVEncoderBitRateKey: 128_000,
            ])
            audio.expectsMediaDataInRealTime = true
            guard newWriter.canAdd(video), newWriter.canAdd(audio) else { return false }
            newWriter.add(video)
            newWriter.add(audio)
            guard newWriter.startWriting() else { return false }
            let start = CMSampleBufferGetPresentationTimeStamp(sample)
            newWriter.startSession(atSourceTime: start)
            writer = newWriter
            videoInput = video
            audioInput = audio
            sessionStart = start
            return true
        } catch {
            return false
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard recording, !paused else { return }
        if writer == nil, !makeWriter(for: sampleBuffer) { return }
        guard let videoInput, videoInput.isReadyForMoreMediaData else { return }
        if timeOffset == .zero {
            videoInput.append(sampleBuffer)
        } else if let shifted = Self.shifted(sampleBuffer, by: timeOffset) {
            videoInput.append(shifted)
        }
    }

    /// The take's audio from MediaAudioEngine, on its tap thread.
    func appendAudio(_ buffer: AVAudioPCMBuffer, at time: AVAudioTime) {
        // The engine reuses a tap's buffer once the callback returns, so it's
        // copied here, before the hop to the writer queue — reading it there
        // later picked up recycled audio and left holes in the take.
        guard let copy = Self.copy(buffer) else { return }
        let clockPts = time.isHostTimeValid
            ? CMClockMakeHostTimeFromSystemUnits(time.hostTime)
            : CMClockGetTime(CMClockGetHostTimeClock())
        writerQueue.async { [self] in
            guard recording, !paused, let sessionStart, let audioInput else { return }
            let measured = CMTimeSubtract(clockPts, timeOffset)
            // Contiguous with the previous buffer unless the two clocks have
            // drifted apart by more than 50 ms (an interruption), when the
            // track re-anchors to the camera's clock to stay in sync.
            let pts: CMTime
            if let next = nextAudioPts, abs(CMTimeSubtract(measured, next).seconds) < 0.05 {
                pts = next
            } else {
                pts = measured
            }
            guard CMTimeCompare(pts, sessionStart) >= 0 else { return }
            nextAudioPts = CMTimeAdd(pts, CMTime(value: CMTimeValue(copy.frameLength), timescale: CMTimeScale(copy.format.sampleRate)))
            guard audioInput.isReadyForMoreMediaData, let sample = Self.sampleBuffer(from: copy, pts: pts) else { return }
            audioInput.append(sample)
        }
    }

    /// A buffer that's ours to keep, for audio that outlives a tap callback.
    static func copy(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard buffer.frameLength > 0,
              let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else { return nil }
        copy.frameLength = buffer.frameLength
        let source = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: buffer.audioBufferList))
        let destination = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        for (from, to) in zip(source, destination) {
            guard let fromData = from.mData, let toData = to.mData else { continue }
            memcpy(toData, fromData, Int(min(from.mDataByteSize, to.mDataByteSize)))
        }
        return copy
    }

    private static func shifted(_ sample: CMSampleBuffer, by offset: CMTime) -> CMSampleBuffer? {
        var count: CMItemCount = 0
        CMSampleBufferGetSampleTimingInfoArray(sample, entryCount: 0, arrayToFill: nil, entriesNeededOut: &count)
        var timing = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(), count: count)
        CMSampleBufferGetSampleTimingInfoArray(sample, entryCount: count, arrayToFill: &timing, entriesNeededOut: &count)
        for i in timing.indices {
            timing[i].presentationTimeStamp = CMTimeSubtract(timing[i].presentationTimeStamp, offset)
            if timing[i].decodeTimeStamp.isValid {
                timing[i].decodeTimeStamp = CMTimeSubtract(timing[i].decodeTimeStamp, offset)
            }
        }
        var copy: CMSampleBuffer?
        CMSampleBufferCreateCopyWithNewTiming(
            allocator: nil, sampleBuffer: sample, sampleTimingEntryCount: count,
            sampleTimingArray: &timing, sampleBufferOut: &copy
        )
        return copy
    }

    private static func sampleBuffer(from buffer: AVAudioPCMBuffer, pts: CMTime) -> CMSampleBuffer? {
        var description: CMAudioFormatDescription?
        guard CMAudioFormatDescriptionCreate(
            allocator: nil, asbd: buffer.format.streamDescription, layoutSize: 0, layout: nil,
            magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &description
        ) == noErr, let description else { return nil }
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: CMTimeScale(buffer.format.sampleRate)),
            presentationTimeStamp: pts,
            decodeTimeStamp: .invalid
        )
        var sample: CMSampleBuffer?
        guard CMSampleBufferCreate(
            allocator: nil, dataBuffer: nil, dataReady: false, makeDataReadyCallback: nil, refcon: nil,
            formatDescription: description, sampleCount: CMItemCount(buffer.frameLength),
            sampleTimingEntryCount: 1, sampleTimingArray: &timing,
            sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &sample
        ) == noErr, let sample else { return nil }
        guard CMSampleBufferSetDataBufferFromAudioBufferList(
            sample, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0,
            bufferList: buffer.audioBufferList
        ) == noErr else { return nil }
        return sample
    }
}
