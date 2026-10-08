import Foundation

enum ApiError: Error, LocalizedError {
    case invalidResponse
    case http(Int, String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Invalid response"
        case .http(let code, let message):
            return "HTTP \(code): \(message)"
        }
    }
}

final class ApiClient {
    static let shared = ApiClient()

    private let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    func loginToken(username: String, password: String) async throws -> TokenResponse {
        var req = URLRequest(url: AppConfig.baseURL.appendingPathComponent("/api/auth/token"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: Any] = [
            "username": username,
            "password": password
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])

        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw ApiError.invalidResponse }

        let decoded = (try? JSONDecoder().decode(TokenResponse.self, from: data)) ?? TokenResponse(ok: nil, token: nil, expiresAtMs: nil, mustChangePassword: nil, error: String(data: data, encoding: .utf8))

        if http.statusCode >= 200 && http.statusCode < 300 {
            return decoded
        }

        throw ApiError.http(http.statusCode, decoded.error ?? "Request failed")
    }

    func fetchStatusSnapshot(token: String) async throws -> StatusSnapshot {
        var req = URLRequest(url: AppConfig.baseURL.appendingPathComponent("/api/status"))
        req.httpMethod = "GET"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw ApiError.invalidResponse }
        if http.statusCode < 200 || http.statusCode >= 300 {
            let msg = String(data: data, encoding: .utf8) ?? "Request failed"
            throw ApiError.http(http.statusCode, msg)
        }

        return parseStatusSnapshot(from: data)
    }

    private func parseStatusSnapshot(from data: Data) -> StatusSnapshot {
        let rawText = String(data: data, encoding: .utf8) ?? ""

        guard let obj = try? JSONSerialization.jsonObject(with: data, options: []),
              let root = obj as? [String: Any] else {
            return StatusSnapshot(
                rawPretty: rawText,
                serverCount: 0,
                onlineCount: 0,
                totalStreams: 0,
                totalTranscodes: 0,
                totalDirectPlays: 0,
                lastPollAtIso: nil,
                servers: [],
                sessions: []
            )
        }

        let rawPretty: String = {
            if let pretty = try? JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted]),
               let text = String(data: pretty, encoding: .utf8) {
                return text
            }
            return rawText
        }()

        let serversArr = (root["servers"] as? [[String: Any]]) ?? []
        let statusesMap = (root["statuses"] as? [String: Any]) ?? [:]
        let poll = root["poll"] as? [String: Any]
        let lastPollAtIso = poll?["lastPollAt"] as? String

        var serverRows: [StatusServerRow] = []
        serverRows.reserveCapacity(serversArr.count)

        var sessionRows: [StatusSessionRow] = []

        var onlineCount = 0
        var totalStreams = 0
        var totalTranscodes = 0
        var totalDirectPlays = 0

        func intVal(_ v: Any?) -> Int? {
            if let n = v as? Int { return n }
            if let n = v as? Double { return Int(n) }
            if let s = v as? String, let n = Int(s) { return n }
            return nil
        }

        func doubleVal(_ v: Any?) -> Double? {
            if let n = v as? Double { return n }
            if let n = v as? Int { return Double(n) }
            if let s = v as? String, let n = Double(s) { return n }
            return nil
        }

        func isTranscoding(_ sess: [String: Any]) -> Bool {
            if let b = sess["transcoding"] as? Bool { return b }
            if let s = (sess["stream"] as? String)?.lowercased(), s.contains("transcode") { return true }
            if let s = (sess["state"] as? String)?.lowercased(), s.contains("transcode") { return true }
            return false
        }

        for server in serversArr {
            let id = String(server["id"] ?? "")
            let name = (server["name"] as? String) ?? (server["baseUrl"] as? String) ?? id
            let type = (server["type"] as? String) ?? "generic"

            let stAny = statusesMap[id]
            let st = stAny as? [String: Any]
            let online = (st?["online"] as? Bool) ?? false
            if online { onlineCount += 1 }

            let latency = intVal(st?["latency"])
            let sessionCount = intVal(st?["sessionCount"]) ?? 0
            totalStreams += sessionCount

            let summary = st?["summary"] as? [String: Any]
            let transcodes = intVal(summary?["transcodes"]) ?? 0
            let directPlays = intVal(summary?["directPlays"]) ?? 0
            totalTranscodes += transcodes
            totalDirectPlays += directPlays

            let lastChecked = st?["lastChecked"] as? String

            serverRows.append(StatusServerRow(
                id: id,
                name: name,
                type: type,
                online: online,
                latencyMs: latency,
                sessionCount: sessionCount,
                transcodes: transcodes,
                directPlays: directPlays,
                lastCheckedIso: lastChecked
            ))

            let sessions = (st?["sessions"] as? [[String: Any]]) ?? []
            for sess in sessions {
                let user = (sess["user"] as? String) ?? (sess["userName"] as? String) ?? ""
                let title = (sess["title"] as? String) ?? ""
                let product = (sess["product"] as? String) ?? (sess["platform"] as? String) ?? ""
                let player = (sess["player"] as? String) ?? ""
                let location = (sess["location"] as? String) ?? ""
                let quality = (sess["quality"] as? String) ?? ""

                let transcoding = isTranscoding(sess)
                let bw = doubleVal(sess["bandwidth"]) // likely Mbps in current backend

                let detailParts = [
                    transcoding ? "Transcode" : "Direct Play",
                    quality,
                    location,
                    player.isEmpty ? "" : "Player: \(player)",
                    product.isEmpty ? "" : product
                ].filter { !$0.isEmpty }

                let sid = String((sess["sessionId"] ?? sess["sessionKey"] ?? sess["id"] ?? UUID().uuidString))
                sessionRows.append(StatusSessionRow(
                    id: "\(id)|\(sid)|\(user)|\(title)",
                    serverName: name,
                    user: user,
                    title: title,
                    detail: detailParts.joined(separator: " • "),
                    transcoding: transcoding,
                    bandwidthMbps: bw
                ))
            }
        }

        serverRows.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        sessionRows.sort {
            if $0.serverName == $1.serverName {
                if $0.user == $1.user { return $0.title < $1.title }
                return $0.user < $1.user
            }
            return $0.serverName < $1.serverName
        }

        return StatusSnapshot(
            rawPretty: rawPretty,
            serverCount: serversArr.count,
            onlineCount: onlineCount,
            totalStreams: totalStreams,
            totalTranscodes: totalTranscodes,
            totalDirectPlays: totalDirectPlays,
            lastPollAtIso: lastPollAtIso,
            servers: serverRows,
            sessions: sessionRows
        )
    }
}
