package com.winkys.omnistreammobile

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

class Api(private val client: OkHttpClient = OkHttpClient()) {
    private val json = Json { ignoreUnknownKeys = true }
    private val prettyJson = Json { prettyPrint = true }

    fun fetchStatusSnapshot(baseUrl: String, token: String): StatusSnapshot {
        val req = Request.Builder()
            .url("$baseUrl/api/status")
            .get()
            .header("Authorization", "Bearer $token")
            .build()

        client.newCall(req).execute().use { resp ->
            val raw = resp.body.string()
            if (!resp.isSuccessful) {
                throw RuntimeException("HTTP ${resp.code}: ${raw.ifBlank { "Request failed" }}")
            }

            val el = runCatching { json.parseToJsonElement(raw) }.getOrNull()
            val rawPretty = if (el != null) {
                runCatching {
                    prettyJson.encodeToString(JsonElement.serializer(), el)
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

            return parseSnapshot(baseUrl, token, el, rawPretty)
        }
    }

    private fun parseSnapshot(baseUrl: String, token: String, root: JsonObject, rawPretty: String): StatusSnapshot {
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

            val sessionsArr = st?.get("sessions") as? JsonArray
            if (sessionsArr != null) {
                for (sessEl in sessionsArr) {
                    val sess = sessEl as? JsonObject ?: continue
                    val user = sess["user"].asString() ?: sess["userName"].asString() ?: ""
                    
                    val sTitle = sess["seriesTitle"].asString() ?: sess["series_title"].asString()
                    val gTitle = sess["grandparentTitle"].asString() ?: sess["grandparent_title"].asString()
                    val cTitle = sess["channelTitle"].asString() ?: sess["channel_title"].asString() ?: sess["channelName"].asString()
                    val pTitle = sess["parentTitle"].asString() ?: sess["parent_title"].asString()
                    val epTitle = sess["title"].asString() ?: ""
                    
                    val displayTitle = when {
                        !sTitle.isNullOrBlank() -> "$sTitle / $epTitle"
                        !gTitle.isNullOrBlank() -> "$gTitle / $epTitle"
                        !cTitle.isNullOrBlank() -> "$cTitle / $epTitle"
                        !pTitle.isNullOrBlank() -> "$pTitle / $epTitle"
                        else -> epTitle
                    }

                    val mediaType = sess["mediaType"].asString() ?: sess["type"].asString()
                    val channel = sess["channelTitle"].asString() ?: sess["channelName"].asString() ?: sess["channel"].asString()
                    val isLive = (sess["isLive"].asBoolean() == true) || (mediaType?.lowercase() == "live") || !channel.isNullOrBlank()
                    
                    // SUPPRESS YEAR FOR LIVE TV OR PLACEHOLDER >= 2025
                    var year = sess["year"].asInt()
                    if (isLive || (year != null && year >= 2025)) year = null

                    val duration = sess["duration"].asLong() ?: sess["durationMs"].asLong()
                    val viewOffset = sess["viewOffset"].asLong() ?: sess["view_offset"].asLong() ?: sess["progress"].asLong()
                    
                    val rawPlatform = sess["platform"].asString()?.lowercase() ?: ""
                    val rawProduct = sess["product"].asString()?.lowercase() ?: ""
                    val rawPlayer = sess["player"].asString()?.lowercase() ?: ""
                    
                    // Explicit categorization for icon mapping (Apple priority)
                    val platformCat = when {
                        rawPlatform.contains("ios") || rawPlatform.contains("iphone") || rawPlatform.contains("ipad") || rawPlatform.contains("apple") || rawProduct.contains("apple") -> "ios"
                        rawPlatform.contains("roku") || rawProduct.contains("roku") || rawPlayer.contains("roku") -> "roku"
                        rawProduct.contains("tv") || rawPlatform.contains("tv") || rawPlayer.contains("tv") || rawProduct.contains("fire") || rawPlatform.contains("fire") -> "tv"
                        rawPlatform.contains("android") -> "android"
                        rawPlatform.contains("mobile") -> "mobile"
                        rawPlatform.contains("web") || rawPlatform.contains("chrome") || rawPlatform.contains("firefox") || rawPlatform.contains("windows") || rawPlatform.contains("pc") || rawPlatform.contains("safari") -> "pc"
                        else -> "other"
                    }

                    val transcoding = isTranscoding(sess)
                    val bw = sess["bandwidth"].asDouble()

                    val sid = sess["sessionId"].asString() ?: sess["sessionKey"].asString() ?: sess["id"].asString() ?: ""
                    val rowId = listOf(id, sid, user, displayTitle).joinToString("|")

                    // Resolve Poster URL
                    val posterPath = sess["seriesPoster"].asString() 
                        ?: sess["series_poster"].asString()
                        ?: sess["grandparentThumb"].asString()
                        ?: sess["grandparent_thumb"].asString()
                        ?: sess["channelThumb"].asString()
                        ?: sess["channel_thumb"].asString()
                        ?: sess["networkThumb"].asString()
                        ?: sess["network_thumb"].asString()
                        ?: sess["parentThumb"].asString()
                        ?: sess["parent_thumb"].asString()
                        ?: sess["poster"].asString() 
                        ?: sess["thumb"].asString()
                        ?: sess["image"].asString()
                    
                    val posterUrl = posterPath?.let { path ->
                        val isExternal = path.startsWith("http")
                        val full = if (isExternal) path else "$baseUrl/${path.trimStart('/')}"
                        
                        if (!isExternal) {
                            val connector = if (full.contains("?")) "&" else "?"
                            "$full${connector}token=$token&X-Plex-Token=$token&X-Omnistream-Token=$token"
                        } else {
                            full
                        }
                    }

                    // Resolve Background Art URL
                    val backPath = sess["background"].asString()
                        ?: sess["art"].asString() 
                        ?: sess["backdrop"].asString() 
                        ?: sess["seriesArt"].asString() 
                        ?: sess["series_art"].asString()
                        ?: sess["channelArt"].asString()
                        ?: sess["channel_art"].asString()
                        ?: sess["parentArt"].asString()
                        ?: sess["parent_art"].asString()
                        ?: sess["fanart"].asString()
                        
                    val backgroundUrl = backPath?.let { path ->
                        val isExternal = path.startsWith("http")
                        val full = if (isExternal) path else "$baseUrl/${path.trimStart('/')}"
                        
                        if (!isExternal) {
                            val connector = if (full.contains("?")) "&" else "?"
                            "$full${connector}token=$token&X-Plex-Token=$token&X-Omnistream-Token=$token"
                        } else {
                            full
                        }
                    }

                    sessionRows.add(
                        StatusSessionRow(
                            id = rowId,
                            serverName = name,
                            user = user,
                            title = displayTitle,
                            detail = "",
                            transcoding = transcoding,
                            bandwidthMbps = bw,
                            posterUrl = posterUrl,
                            backgroundUrl = backgroundUrl,
                            year = year,
                            mediaType = mediaType,
                            duration = duration,
                            viewOffset = viewOffset,
                            channelName = channel,
                            platform = platformCat,
                            product = rawProduct
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
        return state.contains("transcode")
    }

    private fun JsonElement?.asString(): String? {
        val p = this as? JsonPrimitive ?: return null
        if (p.isString) {
            val content = p.content
            if (content == "null" || content.isBlank()) return null
            return content
        }
        if (p.content == "null") return null
        return p.content
    }

    private fun JsonElement?.asInt(): Int? {
        val p = this as? JsonPrimitive ?: return null
        return p.doubleOrNull?.toInt() ?: p.intOrNull
    }

    private fun JsonElement?.asLong(): Long? {
        val p = this as? JsonPrimitive ?: return null
        return p.doubleOrNull?.toLong() ?: p.content.toLongOrNull()
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
