import UIKit
import Capacitor
import AVFAudio

@objc(VideoCallAudioPlugin)
public class VideoCallAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VideoCallAudioPlugin"
    public let jsName = "VideoCallAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    private let audioSession = AVAudioSession.sharedInstance()
    private var callActive = false
    private var previousCategory: AVAudioSession.Category?
    private var previousMode: AVAudioSession.Mode?
    private var previousOptions: AVAudioSession.CategoryOptions?

    override public func load() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: audioSession
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleRouteChange(_:)),
            name: AVAudioSession.routeChangeNotification,
            object: audioSession
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleMediaServicesReset(_:)),
            name: AVAudioSession.mediaServicesWereResetNotification,
            object: audioSession
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    private func configureForVideoCall() throws {
        if !callActive {
            previousCategory = audioSession.category
            previousMode = audioSession.mode
            previousOptions = audioSession.categoryOptions
        }
        try audioSession.setCategory(
            .playAndRecord,
            mode: .videoChat,
            options: [.allowBluetoothHFP, .defaultToSpeaker]
        )
        try? audioSession.setPreferredSampleRate(48_000)
        try? audioSession.setPreferredIOBufferDuration(0.01)
        try audioSession.setActive(true)
        callActive = true
    }

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("Video call audio session is unavailable")
                return
            }
            do {
                try self.configureForVideoCall()
                call.resolve([
                    "sampleRate": self.audioSession.sampleRate,
                    "outputChannels": self.audioSession.outputNumberOfChannels
                ])
            } catch {
                call.reject("Could not activate video call audio", nil, error)
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.resolve()
                return
            }
            guard self.callActive else {
                call.resolve()
                return
            }
            var stopError: Error?
            do {
                try self.audioSession.setActive(false, options: .notifyOthersOnDeactivation)
            } catch {
                stopError = error
            }
            if let category = self.previousCategory,
               let mode = self.previousMode,
               let options = self.previousOptions {
                do {
                    try self.audioSession.setCategory(category, mode: mode, options: options)
                } catch {
                    if stopError == nil { stopError = error }
                }
            }
            self.callActive = false
            self.previousCategory = nil
            self.previousMode = nil
            self.previousOptions = nil
            if let stopError {
                call.reject("Could not restore the previous audio session", nil, stopError)
            } else {
                call.resolve()
            }
        }
    }

    @objc private func handleInterruption(_ notification: Notification) {
        guard let rawValue = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: rawValue) else { return }
        if type == .began {
            notifyListeners("stateChange", data: ["status": "interrupted"])
            return
        }

        let optionsRaw = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
        let options = AVAudioSession.InterruptionOptions(rawValue: optionsRaw)
        if callActive && options.contains(.shouldResume) {
            try? configureForVideoCall()
        }
        notifyListeners("stateChange", data: ["status": "resumed"])
    }

    @objc private func handleRouteChange(_ notification: Notification) {
        let rawReason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
        let reason = AVAudioSession.RouteChangeReason(rawValue: rawReason) ?? .unknown
        notifyListeners("stateChange", data: [
            "status": "route-changed",
            "reason": reason.rawValue
        ])
    }

    @objc private func handleMediaServicesReset(_ notification: Notification) {
        if callActive {
            try? configureForVideoCall()
        }
        notifyListeners("stateChange", data: ["status": "media-services-reset"])
    }
}

@objc(EthanBridgeViewController)
class EthanBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        // This is a game surface, so an incidental two-finger gesture should
        // never magnify the entire WKWebView and move the board off-screen.
        webView?.scrollView.minimumZoomScale = 1
        webView?.scrollView.maximumZoomScale = 1
        webView?.scrollView.pinchGestureRecognizer?.isEnabled = false
        bridge?.registerPluginInstance(VideoCallAudioPlugin())
    }
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
