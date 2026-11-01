import Capacitor

/// The app's web view controller (Main.storyboard). Exists to register the
/// plugins that live in this app target rather than in an npm package.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(AppleAIPlugin())
    }
}
