package com.winkys.omnistreammobile

data class StatusServerRow(
    val id: String,
    val name: String,
    val type: String,
    val online: Boolean,
    val latencyMs: Int?,
    val sessionCount: Int,
    val transcodes: Int,
    val directPlays: Int,
    val lastCheckedIso: String?
)

data class StatusSessionRow(
    val id: String,
    val serverName: String,
    val user: String,
    val title: String,
    val detail: String,
    val transcoding: Boolean,
    val bandwidthMbps: Double?,
    val posterUrl: String? = null,
    val backgroundUrl: String? = null,
    val year: Int? = null,
    val mediaType: String? = null,
    val duration: Long? = null,
    val viewOffset: Long? = null,
    val channelName: String? = null,
    val platform: String? = null,
    val product: String? = null
)

data class StatusSnapshot(
    val rawPretty: String,
    val serverCount: Int,
    val onlineCount: Int,
    val totalStreams: Int,
    val totalTranscodes: Int,
    val totalDirectPlays: Int,
    val lastPollAtIso: String?,
    val servers: List<StatusServerRow>,
    val sessions: List<StatusSessionRow>
)
