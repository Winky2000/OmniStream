package com.winkys.omnistreammobile

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Devices
import androidx.compose.material.icons.filled.Smartphone
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp

@Composable
fun PlatformIcon(plat: String?, modifier: Modifier = Modifier) {
    val p = plat?.lowercase() ?: ""
    when (p) {
        "roku" -> RokuPlatformIcon(modifier = modifier)
        "android" -> AndroidHeadIcon(modifier = modifier)
        "ios" -> AppleIcon(modifier = modifier)
        "mobile" -> Icon(
            Icons.Default.Smartphone,
            contentDescription = null,
            modifier = modifier,
            tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.75f)
        )
        "tv" -> Icon(
            Icons.Default.Tv,
            contentDescription = null,
            modifier = modifier,
            tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.75f)
        )
        "pc" -> Icon(
            Icons.Default.Computer,
            contentDescription = null,
            modifier = modifier,
            tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.75f)
        )
        else -> Icon(
            Icons.Default.Devices,
            contentDescription = null,
            modifier = modifier,
            tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.75f)
        )
    }
}

@Preview(showBackground = true)
@Composable
fun PlatformIconRowPreview() {
    MaterialTheme(colorScheme = darkColorScheme()) {
        Surface {
            Row(
                modifier = Modifier.padding(16.dp),
                horizontalArrangement = Arrangement.spacedBy(14.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                val icons = listOf("roku", "android", "ios", "mobile", "tv", "pc", "other")
                for (p in icons) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        PlatformIcon(plat = p, modifier = Modifier)
                        Text(p, style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }
    }
}

@Preview(showBackground = true)
@Composable
fun PlatformBadgeRowPreview() {
    MaterialTheme(colorScheme = darkColorScheme()) {
        Surface {
            Row(
                modifier = Modifier.padding(16.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                val platforms = listOf(
                    "roku",
                    "android",
                    "androidtv",
                    "ios",
                    "tvos",
                    "firetv",
                    "web",
                    "windows",
                    "mac",
                    "linux",
                    "unknown"
                )
                for (p in platforms) {
                    PlatformBadge(platformKey = p)
                }
            }
        }
    }
}
