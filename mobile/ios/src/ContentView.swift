import SwiftUI

enum AppScreen {
    case pair
    case status
}

struct ContentView: View {
    @State private var screen: AppScreen = .pair
    @State private var deviceTokenInput: String = ""
    @State private var errorText: String? = nil

    @State private var statusText: String = ""
    @State private var lastUpdated: Date? = nil

    @State private var snapshot: StatusSnapshot? = nil
    @State private var showRaw: Bool = false

    @State private var pollTask: Task<Void, Never>? = nil

    var body: some View {
        NavigationView {
            Group {
                if screen == .pair {
                    pairView
                } else {
                    statusView
                }
            }
            .navigationTitle("OmniStream")
        }
        .onAppear {
            if let token = TokenStore.shared.loadToken(), !token.isEmpty {
                screen = .status
                startPolling(with: token)
            } else {
                screen = .pair
            }
        }
        .onDisappear {
            pollTask?.cancel()
            pollTask = nil
        }
    }

    private var pairView: some View {
        Form {
            Section(header: Text("Server")) {
                Text(AppConfig.baseURL.absoluteString)
                    .font(.footnote)
            }

            Section(header: Text("Link device")) {
                Text("This mobile app must be linked from the OmniStream web UI after login (Settings → System → Tools → Mobile devices).")
                    .font(.footnote)
                    .foregroundColor(.secondary)

                TextEditor(text: $deviceTokenInput)
                    .frame(minHeight: 80)
                    .font(.system(.footnote, design: .monospaced))

                if let errorText {
                    Text(errorText)
                        .foregroundColor(.red)
                        .font(.footnote)
                }

                Button("Link device") {
                    linkDevice()
                }
                .disabled(deviceTokenInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    private var statusView: some View {
        List {
            Section {
                HStack {
                    if let lastUpdated {
                        Text("Updated: \\(lastUpdated.formatted(date: .abbreviated, time: .standard))")
                            .font(.footnote)
                            .foregroundColor(.secondary)
                    } else {
                        Text("Not updated yet")
                            .font(.footnote)
                            .foregroundColor(.secondary)
                    }
                    Spacer()
                    Button("Log Out") { logout() }
                }
            }

            if let errorText {
                Section {
                    Text(errorText)
                        .foregroundColor(.red)
                        .font(.footnote)
                }
            }

            if let snapshot {
                Section("Summary") {
                    LabeledContent("Servers") {
                        Text("\\(snapshot.onlineCount)/\\(snapshot.serverCount) online")
                    }
                    LabeledContent("Active Streams") {
                        Text("\\(snapshot.totalStreams)")
                    }
                    LabeledContent("Transcodes") {
                        Text("\\(snapshot.totalTranscodes)")
                    }
                    LabeledContent("Direct Plays") {
                        Text("\\(snapshot.totalDirectPlays)")
                    }
                    if let lastPoll = snapshot.lastPollAtIso, !lastPoll.isEmpty {
                        LabeledContent("Last Poll") {
                            Text(lastPoll)
                                .font(.footnote)
                                .foregroundColor(.secondary)
                        }
                    }
                }

                Section("Servers") {
                    if snapshot.servers.isEmpty {
                        Text("No servers configured")
                            .foregroundColor(.secondary)
                    }
                    ForEach(snapshot.servers) { s in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(s.name)
                                    .font(.body)
                                Spacer()
                                Text(s.online ? "Online" : "Offline")
                                    .font(.footnote)
                                    .foregroundColor(s.online ? .green : .red)
                            }
                            HStack(spacing: 12) {
                                Text("Streams: \\(s.sessionCount)")
                                Text("Transcodes: \\(s.transcodes)")
                                if let latency = s.latencyMs {
                                    Text("Latency: \\(latency)ms")
                                }
                            }
                            .font(.footnote)
                            .foregroundColor(.secondary)
                        }
                    }
                }

                Section("Live Sessions") {
                    if snapshot.sessions.isEmpty {
                        Text("No active streams")
                            .foregroundColor(.secondary)
                    }
                    ForEach(snapshot.sessions) { sess in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(sess.user.isEmpty ? "(unknown user)" : sess.user)
                                    .font(.body)
                                Spacer()
                                Text(sess.serverName)
                                    .font(.footnote)
                                    .foregroundColor(.secondary)
                            }
                            Text(sess.title.isEmpty ? "(unknown title)" : sess.title)
                                .font(.subheadline)
                            HStack(spacing: 8) {
                                Text(sess.detail)
                                if let bw = sess.bandwidthMbps {
                                    Text(String(format: "%.1f Mbps", bw))
                                }
                            }
                            .font(.footnote)
                            .foregroundColor(.secondary)
                        }
                    }
                }

                Section {
                    DisclosureGroup(isExpanded: $showRaw) {
                        Text(snapshot.rawPretty.isEmpty ? "(empty)" : snapshot.rawPretty)
                            .font(.system(.footnote, design: .monospaced))
                            .textSelection(.enabled)
                    } label: {
                        Text("Raw JSON")
                    }
                }
            } else {
                Section {
                    Text("Loading status…")
                        .foregroundColor(.secondary)
                }
            }
        }
    }

    private func linkDevice() {
        let token = deviceTokenInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { return }
        errorText = nil
        TokenStore.shared.saveToken(token)
        deviceTokenInput = ""
        screen = .status
        startPolling(with: token)
    }

    private func startPolling(with token: String) {
        pollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                await fetchOnce(token: token)
                try? await Task.sleep(nanoseconds: UInt64(AppConfig.statusPollIntervalSeconds * 1_000_000_000))
            }
        }
    }

    @MainActor
    private func fetchOnce(token: String) async {
        do {
            let snap = try await ApiClient.shared.fetchStatusSnapshot(token: token)
            snapshot = snap
            statusText = snap.rawPretty
            lastUpdated = Date()
            errorText = nil
        } catch {
            if let apiErr = error as? ApiError {
                switch apiErr {
                case .http(let code, _):
                    if code == 401 || code == 403 {
                        errorText = "Device token is invalid or not linked. Link this device again in the web UI."
                        logout()
                        return
                    }
                default:
                    break
                }
            }
            errorText = error.localizedDescription
        }
    }

    private func logout() {
        TokenStore.shared.clearToken()
        pollTask?.cancel()
        pollTask = nil
        statusText = ""
        snapshot = nil
        lastUpdated = nil
        errorText = nil
        screen = .pair
    }
}
