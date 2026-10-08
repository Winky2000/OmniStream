import Foundation

enum AppConfig {
    // Single fixed URL (per your requirement).
    // Example: https://omnistream.yourdomain.com
    static let baseURL = URL(string: "https://YOUR_OMNISTREAM_HOST")!

    static let statusPollIntervalSeconds: TimeInterval = 10
}
