import Foundation

/// The single owner of the app's media hardware: the audio session, the
/// audio engines, the mic and the camera. Everything that turns hardware on
/// or off goes through here, and every change is reported with a reason so
/// on-device testing can see exactly when the mic was live.
///
/// Modes:
/// - `idle`: no engine running, audio session inactive.
/// - `playback`: a playback-only engine plays the scene partner. It never
///   touches the mic input, so the mic indicator stays off.
/// - `capture`: a capture engine (created fresh, destroyed on release) runs
///   the mic, the scene partner and the take mix together. Only while at
///   least one capture lease is held.
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

    /// Reports the current state, e.g. when the web view starts listening.
    func report(reason: String) {
        print("[media] mode=\(state.mode.rawValue) mic=\(state.mic) camera=\(state.camera) leases=\(state.leases) reason=\(reason)")
        onStateChange?(state, reason)
    }
}
