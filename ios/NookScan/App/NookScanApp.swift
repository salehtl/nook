import SwiftUI

@main
struct NookScanApp: App {
    @StateObject private var store = CaptureStore()

    var body: some Scene {
        WindowGroup {
            CapturesListView()
                .environmentObject(store)
        }
    }
}
