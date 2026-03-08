package com.winkys.omnistreammobile

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

@Composable
fun PlatformBadge(platformKey: String?, modifier: Modifier = Modifier) {
    val key = platformKey?.trim()?.lowercase().orEmpty()
    val label = platformLabelForKey(key)

    val (bg, fg, border) = when (key) {
        // Match the web UI preference: Roku is a solid accent tile with white text.
        "roku" -> Triple(
            MaterialTheme.colorScheme.primary,
            MaterialTheme.colorScheme.onPrimary,
            BorderStroke(0.dp, MaterialTheme.colorScheme.primary)
        )
        else -> Triple(
            MaterialTheme.colorScheme.surface,
            MaterialTheme.colorScheme.onSurfaceVariant,
            BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.35f))
        )
    }

    Surface(
        modifier = modifier.defaultMinSize(minHeight = 28.dp),
        shape = RoundedCornerShape(10.dp),
        color = bg,
        contentColor = fg,
        border = border
    ) {
        Text(
            text = label,
            modifier = Modifier.padding(PaddingValues(horizontal = 10.dp, vertical = 6.dp)),
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.ExtraBold,
            maxLines = 1
        )
    }
}

private fun platformLabelForKey(key: String): String {
    return when (key) {
        "roku" -> "Roku"
        "androidtv" -> "Android TV"
        "android" -> "Android"
        "ios" -> "iOS"
        "tvos" -> "tvOS"
        "firetv" -> "Fire TV"
        "chromecast" -> "Chromecast"
        "webos" -> "webOS"
        "tizen" -> "Tizen"
        "xbox" -> "Xbox"
        "playstation" -> "PlayStation"
        "shield" -> "Shield"
        "windows" -> "Windows"
        "mac" -> "macOS"
        "linux" -> "Linux"
        "web" -> "Web"
        "tv" -> "TV"
        "unknown" -> "Unknown"
        else -> if (key.isBlank()) "Unknown" else key.replaceFirstChar { it.uppercaseChar() }
    }
}
