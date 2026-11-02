import Capacitor

/// The app's web view controller (created by SceneDelegate). Exists to
/// register plugins that live in this app target rather than in an npm
/// package: NativeMediaPlugin (camera, mic, audio).
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativeMediaPlugin())
    }
}
