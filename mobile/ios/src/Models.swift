import Foundation

struct TokenResponse: Decodable {
    let ok: Bool?
    let token: String?
    let expiresAtMs: Double?
    let mustChangePassword: Bool?
    let error: String?
}

struct AuthMeResponse: Decodable {
    let mode: String?
    let internalAuthEnabled: Bool?
    let authenticated: Bool?
    let username: String?
    let mustChangePassword: Bool?
    let error: String?
}

struct StatusServerRow: Identifiable {
    let id: String
    let name: String
    let type: String
    let online: Bool
    let latencyMs: Int?
    let sessionCount: Int
    let transcodes: Int
    let directPlays: Int
    let lastCheckedIso: String?
}

struct StatusSessionRow: Identifiable {
    let id: String
    let serverName: String
    let user: String
    let title: String
    let detail: String
    let transcoding: Bool
    let bandwidthMbps: Double?
}

struct StatusSnapshot {
    let rawPretty: String
    let serverCount: Int
    let onlineCount: Int
    let totalStreams: Int
    let totalTranscodes: Int
    let totalDirectPlays: Int
    let lastPollAtIso: String?
    let servers: [StatusServerRow]
    let sessions: [StatusSessionRow]
}
