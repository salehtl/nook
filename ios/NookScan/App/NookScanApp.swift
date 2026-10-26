import SwiftUI
import UIKit

@main
struct NookScanApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var store = CaptureStore()

    var body: some Scene {
        WindowGroup {
            CapturesListView()
                .environmentObject(store)
                .environment(ProcessingStore.shared)
        }
    }
}

/// Only for background uploads: iOS relaunches the app to deliver their events.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        ProcessingStore.shared.handleBackgroundEvents(identifier: identifier, completion: completionHandler)
    }
}
