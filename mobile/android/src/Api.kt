package com.example.omnistreammobile

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

@Serializable
data class TokenResponse(
    val ok: Boolean? = null,
    val token: String? = null,
    val error: String? = null,
    @SerialName("expiresAtMs") val expiresAtMs: Long? = null,
    @SerialName("mustChangePassword") val mustChangePassword: Boolean? = null
)

class Api(private val client: OkHttpClient = OkHttpClient()) {
    private val json = Json { ignoreUnknownKeys = true }

    fun loginToken(username: String, password: String): TokenResponse {
        val payload = "{\"username\":\"${escape(username)}\",\"password\":\"${escape(password)}\"}"
        val body = payload.toRequestBody("application/json".toMediaType())

        val req = Request.Builder()
            .url("${AppConfig.BASE_URL}/api/auth/token")
            .post(body)
            .build()

        client.newCall(req).execute().use { resp ->
            val raw = resp.body?.string() ?: ""
            val decoded = runCatching { json.decodeFromString(TokenResponse.serializer(), raw) }
                .getOrElse { TokenResponse(ok = false, error = raw.ifBlank { "Request failed" }) }

            if (!resp.isSuccessful) {
                return decoded.copy(ok = false, error = decoded.error ?: "HTTP ${resp.code}")
            }
            return decoded
        }
    }

    fun fetchStatusSnapshot(token: String): StatusSnapshot {
        val req = Request.Builder()
            .url("${AppConfig.BASE_URL}/api/status")
            .get()
            .header("Authorization", "Bearer $token")
            .build()

        client.newCall(req).execute().use { resp ->
            val raw = resp.body?.string() ?: ""
            if (!resp.isSuccessful) {
                throw RuntimeException("HTTP ${resp.code}: ${raw.ifBlank { "Request failed" }}")
            }

            val el = runCatching { json.parseToJsonElement(raw) }.getOrNull()
            val rawPretty = if (el != null) {
                runCatching {
                    Json { prettyPrint = true }.encodeToString(JsonElement.serializer(), el)
                }.getOrNull() ?: raw
            } else {
                raw
            }

            if (el == null || el !is JsonObject) {
                return StatusSnapshot(
                    rawPretty = rawPretty,
                    serverCount = 0,
                    onlineCount = 0,
                    totalStreams = 0,
                    totalTranscodes = 0,
                    totalDirectPlays = 0,
                    lastPollAtIso = null,
                    servers = emptyList(),
                    sessions = emptyList()
                )
            }

            return parseSnapshot(el, rawPretty)
        }
    }

    private fun parseSnapshot(root: JsonObject, rawPretty: String): StatusSnapshot {
        val serversEl = root["servers"]
        val statusesEl = root["statuses"]
        val pollEl = root["poll"]

        val lastPollAtIso = (pollEl as? JsonObject)?.get("lastPollAt")?.asString()

        val serverRows = mutableListOf<StatusServerRow>()
        val sessionRows = mutableListOf<StatusSessionRow>()

        var onlineCount = 0
        var totalStreams = 0
        var totalTranscodes = 0
        var totalDirectPlays = 0

        val serversArr = (serversEl as? JsonArray)?.toList() ?: emptyList()
        val statusesMap = (statusesEl as? JsonObject)

        for (srvEl in serversArr) {
            val srv = srvEl as? JsonObject ?: continue
            val id = srv["id"].asString() ?: ""
            val name = srv["name"].asString() ?: srv["baseUrl"].asString() ?: id
            val type = srv["type"].asString() ?: "generic"

            val st = statusesMap?.get(id) as? JsonObject
            val online = st?.get("online")?.asBoolean() ?: false
            if (online) onlineCount++

            val latency = st?.get("latency")?.asInt()
            val sessionCount = st?.get("sessionCount")?.asInt() ?: 0
            totalStreams += sessionCount

            val summary = st?.get("summary") as? JsonObject
            val transcodes = summary?.get("transcodes")?.asInt() ?: 0
            val directPlays = summary?.get("directPlays")?.asInt() ?: 0
            totalTranscodes += transcodes
            totalDirectPlays += directPlays

            val lastChecked = st?.get("lastChecked")?.asString()

            serverRows.add(
                StatusServerRow(
                    id = id,
                    name = name,
                    type = type,
                    online = online,
                    latencyMs = latency,
                    sessionCount = sessionCount,
                    transcodes = transcodes,
                    directPlays = directPlays,
                    lastCheckedIso = lastChecked
                )
            )

            val sessions = st?.get("sessions") as? JsonArray
            if (sessions != null) {
                for (sessEl in sessions) {
                    val sess = sessEl as? JsonObject ?: continue
                    val user = sess["user"].asString() ?: sess["userName"].asString() ?: ""
                    val title = sess["title"].asString() ?: ""
                    val product = sess["product"].asString() ?: sess["platform"].asString() ?: ""
                    val player = sess["player"].asString() ?: ""
                    val location = sess["location"].asString() ?: ""
                    val quality = sess["quality"].asString() ?: ""

                    val transcoding = isTranscoding(sess)
                    val bw = sess["bandwidth"].asDouble()

                    val detailParts = listOf(
                        if (transcoding) "Transcode" else "Direct Play",
                        quality,
                        location,
                        if (player.isNotBlank()) "Player: $player" else "",
                        product
                    ).filter { it.isNotBlank() }

                    val sid = sess["sessionId"].asString() ?: sess["sessionKey"].asString() ?: sess["id"].asString() ?: ""
                    val rowId = listOf(id, sid, user, title).joinToString("|")

                    sessionRows.add(
                        StatusSessionRow(
                            id = rowId,
                            serverName = name,
                            user = user,
                            title = title,
                            detail = detailParts.joinToString(" • "),
                            transcoding = transcoding,
                            bandwidthMbps = bw
                        )
                    )
                }
            }
        }

        val sortedServers = serverRows.sortedBy { it.name.lowercase() }
        val sortedSessions = sessionRows.sortedWith(compareBy({ it.serverName.lowercase() }, { it.user.lowercase() }, { it.title.lowercase() }))

        return StatusSnapshot(
            rawPretty = rawPretty,
            serverCount = serversArr.size,
            onlineCount = onlineCount,
            totalStreams = totalStreams,
            totalTranscodes = totalTranscodes,
            totalDirectPlays = totalDirectPlays,
            lastPollAtIso = lastPollAtIso,
            servers = sortedServers,
            sessions = sortedSessions
        )
    }

    private fun isTranscoding(sess: JsonObject): Boolean {
        val t = sess["transcoding"]?.asBoolean()
        if (t != null) return t
        val stream = sess["stream"].asString()?.lowercase() ?: ""
        if (stream.contains("transcode")) return true
        val state = sess["state"].asString()?.lowercase() ?: ""
        if (state.contains("transcode")) return true
        return false
    }

    private fun JsonElement?.asString(): String? {
        val p = this as? JsonPrimitive ?: return null
        return p.content
    }

    private fun JsonElement?.asInt(): Int? {
        val p = this as? JsonPrimitive ?: return null
        return p.intOrNull
    }

    private fun JsonElement?.asDouble(): Double? {
        val p = this as? JsonPrimitive ?: return null
        return p.doubleOrNull
    }

    private fun JsonElement?.asBoolean(): Boolean? {
        val p = this as? JsonPrimitive ?: return null
        return p.booleanOrNull
    }

    private fun escape(s: String): String {
        return s
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t")
    }
}
