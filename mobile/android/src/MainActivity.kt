package com.winkys.omnistreammobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cast
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Devices
import androidx.compose.material.icons.filled.LiveTv
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Smartphone
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import coil.request.ImageRequest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val settingsStore = SettingsStore(this)
        val api = Api()

        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    OmniStreamApp(settingsStore = settingsStore, api = api)
                }
            }
        }
    }
}

@Composable
private fun OmniStreamApp(settingsStore: SettingsStore, api: Api) {
    var baseUrl by remember { mutableStateOf(settingsStore.loadBaseUrl()) }
    var token by remember { mutableStateOf(settingsStore.loadToken()) }
    
    var screen by remember { mutableStateOf(if (baseUrl == null) "setup" else if (token == null) "pair" else "status") }
    
    var deviceTokenInput by remember { mutableStateOf("") }
    var errorText by remember { mutableStateOf<String?>(null) }

    var snapshot by remember { mutableStateOf<StatusSnapshot?>(null) }
    var showRaw by remember { mutableStateOf(false) }

    val scope = rememberCoroutineScope()

    LaunchedEffect(screen, token, baseUrl) {
        if (screen != "status" || token.isNullOrBlank() || baseUrl.isNullOrBlank()) return@LaunchedEffect

        while (true) {
            try {
                val b = baseUrl ?: break
                val t = token ?: break
                val snap = kotlinx.coroutines.withContext(Dispatchers.IO) { api.fetchStatusSnapshot(b, t) }
                snapshot = snap
                errorText = null
            } catch (e: Exception) {
                errorText = e.message
                val msg = e.message ?: ""
                if (msg.startsWith("HTTP 401") || msg.startsWith("HTTP 403")) {
                    // Token is missing/invalid (not paired) — force relink.
                    settingsStore.clearToken()
                    token = null
                    snapshot = null
                    screen = "pair"
                    break
                }
            }
            delay(AppConfig.POLL_INTERVAL_MS)
        }
    }

    when (screen) {
        "setup" -> {
            SetupScreen(
                initialUrl = baseUrl ?: "",
                onSave = { newUrl ->
                    settingsStore.saveBaseUrl(newUrl)
                    baseUrl = settingsStore.loadBaseUrl()
                    screen = if (token == null) "pair" else "status"
                }
            )
        }
        "pair" -> {
            PairScreen(
                baseUrl = baseUrl ?: "",
                deviceToken = deviceTokenInput,
                onDeviceTokenChange = { deviceTokenInput = it },
                errorText = errorText,
                onLink = {
                    val t = deviceTokenInput.trim()
                    if (t.isBlank()) return@PairScreen
                    settingsStore.saveToken(t)
                    token = t
                    deviceTokenInput = ""
                    errorText = null
                    screen = "status"
                },
                onEditUrl = { screen = "setup" }
            )
        }
        "status" -> {
            StatusScreen(
                snapshot = snapshot,
                token = token,
                errorText = errorText,
                showRaw = showRaw,
                onToggleRaw = { showRaw = !showRaw },
                onLogout = {
                    settingsStore.clearToken()
                    token = null
                    snapshot = null
                    errorText = null
                    screen = "pair"
                },
                onSettings = { screen = "setup" }
            )
        }
    }
}

@Composable
private fun SetupScreen(initialUrl: String, onSave: (String) -> Unit) {
    var url by remember { mutableStateOf(initialUrl) }
    Column(modifier = Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Server Setup", style = MaterialTheme.typography.headlineSmall)
        Text("Enter the base URL of your OmniStream server", style = MaterialTheme.typography.bodyMedium)
        OutlinedTextField(
            value = url,
            onValueChange = { url = it },
            label = { Text("Server URL") },
            placeholder = { Text("https://...") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )
        Button(onClick = { if (url.isNotBlank()) onSave(url) }, enabled = url.isNotBlank(), modifier = Modifier.align(Alignment.End)) {
            Text("Save and Continue")
        }
    }
}

@Composable
private fun PairScreen(
    baseUrl: String,
    deviceToken: String,
    onDeviceTokenChange: (String) -> Unit,
    errorText: String?,
    onLink: () -> Unit,
    onEditUrl: () -> Unit
) {
    Column(modifier = Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("OmniStream", style = MaterialTheme.typography.headlineSmall)
            Spacer(modifier = Modifier.weight(1f))
            IconButton(onClick = onEditUrl) { Icon(Icons.Default.Settings, contentDescription = "Settings") }
        }
        Text("Connecting to: $baseUrl", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
        Text(
            "This mobile app must be linked from the OmniStream web UI after login (Settings → System → Tools → Mobile devices).",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.8f)
        )
        OutlinedTextField(
            value = deviceToken,
            onValueChange = onDeviceTokenChange,
            label = { Text("Device token") },
            singleLine = false,
            modifier = Modifier.fillMaxWidth()
        )
        if (errorText != null) Text(errorText, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        Button(
            onClick = { if (deviceToken.trim().isNotBlank()) onLink() },
            enabled = deviceToken.trim().isNotBlank(),
            modifier = Modifier.align(Alignment.End)
        ) {
            Text("Link device")
        }
    }
}

@Composable
private fun StatusScreen(
    snapshot: StatusSnapshot?,
    token: String?,
    errorText: String?,
    showRaw: Boolean,
    onToggleRaw: () -> Unit,
    onLogout: () -> Unit,
    onSettings: () -> Unit
) {
    val context = LocalContext.current
    
    Column(modifier = Modifier.fillMaxSize()) {
        Row(modifier = Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Status", style = MaterialTheme.typography.titleMedium)
            Spacer(modifier = Modifier.weight(1f))
            IconButton(onClick = onSettings) { Icon(Icons.Default.Settings, contentDescription = "Settings") }
            TextButton(onClick = onLogout) { Text("Log out") }
        }

        if (errorText != null) {
            Text(errorText, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 12.dp))
        }

        val scroll = rememberScrollState()
        Column(modifier = Modifier.fillMaxSize().verticalScroll(scroll).padding(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (snapshot == null) {
                Text("Loading status…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                return@Column
            }

            OutlinedCard {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Summary", style = MaterialTheme.typography.titleSmall)
                    Text("Servers: ${snapshot.onlineCount}/${snapshot.serverCount} online", style = MaterialTheme.typography.bodySmall)
                    Text("Active Streams: ${snapshot.totalStreams}", style = MaterialTheme.typography.bodySmall)
                    Text("Transcodes: ${snapshot.totalTranscodes}", style = MaterialTheme.typography.bodySmall)
                    Text("Direct Plays: ${snapshot.totalDirectPlays}", style = MaterialTheme.typography.bodySmall)
                    if (!snapshot.lastPollAtIso.isNullOrBlank()) {
                        Text("Last Poll: ${snapshot.lastPollAtIso}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }

            OutlinedCard {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Servers", style = MaterialTheme.typography.titleSmall)
                    if (snapshot.servers.isEmpty()) Text("No servers configured", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    snapshot.servers.forEach { s ->
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(s.name, style = MaterialTheme.typography.bodyMedium)
                                Spacer(modifier = Modifier.weight(1f))
                                val c = if (s.online) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.error
                                Text(if (s.online) "Online" else "Offline", style = MaterialTheme.typography.bodySmall, color = c)
                            }
                            val latency = s.latencyMs?.let { " • ${it}ms" } ?: ""
                            Text("Streams: ${s.sessionCount} • Transcodes: ${s.transcodes}$latency", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        HorizontalDivider()
                    }
                }
            }

            Text("Live Sessions", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp))
            if (snapshot.sessions.isEmpty()) Text("No active streams", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            
            snapshot.sessions.forEach { sess ->
                val posterRequest = ImageRequest.Builder(context)
                    .data(sess.posterUrl)
                    .addHeader("Authorization", "Bearer $token")
                    .addHeader("X-Plex-Token", token ?: "")
                    .addHeader("X-Omnistream-Token", token ?: "")
                    .crossfade(true)
                    .build()

                val backRequest = ImageRequest.Builder(context)
                    .data(sess.backgroundUrl)
                    .addHeader("Authorization", "Bearer $token")
                    .addHeader("X-Plex-Token", token ?: "")
                    .addHeader("X-Omnistream-Token", token ?: "")
                    .crossfade(true)
                    .build()

                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(8.dp),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
                ) {
                    Box(modifier = Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
                        AsyncImage(
                            model = backRequest,
                            contentDescription = null,
                            modifier = Modifier.fillMaxSize().alpha(0.25f),
                            contentScale = ContentScale.Crop
                        )
                        
                        Box(modifier = Modifier.fillMaxSize().background(
                            Brush.horizontalGradient(
                                colors = listOf(MaterialTheme.colorScheme.surfaceVariant, Color.Transparent),
                                startX = 0f, endX = 1000f
                            )
                        ))

                        Row(modifier = Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            AsyncImage(
                                model = posterRequest,
                                contentDescription = null,
                                modifier = Modifier.width(60.dp).height(90.dp).clip(RoundedCornerShape(4.dp)).background(Color.DarkGray),
                                contentScale = ContentScale.Crop
                            )
                            
                            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Row(modifier = Modifier.weight(1f)) {
                                        Text(if (sess.user.isBlank()) "(unknown user)" else sess.user, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                        Text(" @ ${sess.serverName}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    }
                                    
                                    // Platform Icon mapping
                                    val plat = sess.platform?.lowercase() ?: ""
                                    when (plat) {
                                        "roku" -> RokuBadge()
                                        "android" -> AndroidHeadIcon(modifier = Modifier.size(16.dp))
                                        "ios" -> AppleIcon(modifier = Modifier.size(16.dp))
                                        "mobile" -> Icon(Icons.Default.Smartphone, contentDescription = null, modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f))
                                        "tv" -> Icon(Icons.Default.Tv, contentDescription = null, modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f))
                                        "pc" -> Icon(Icons.Default.Computer, contentDescription = null, modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f))
                                        else -> Icon(Icons.Default.Devices, contentDescription = null, modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f))
                                    }
                                }
                                
                                Text(if (sess.title.isBlank()) "(unknown title)" else sess.title, style = MaterialTheme.typography.titleSmall)
                                
                                // Show year only if it's NOT Live TV
                                if (sess.year != null && sess.year > 0 && sess.channelName.isNullOrBlank()) {
                                    Text(sess.year.toString(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                                }
                            }
                        }

                        // Bottom Right Info
                        Column(
                            modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp),
                            horizontalAlignment = Alignment.End
                        ) {
                            val icon = when (sess.mediaType?.lowercase()) {
                                "movie" -> Icons.Default.Movie
                                "episode" -> Icons.Default.Tv
                                "live", "track", "channel" -> Icons.Default.LiveTv
                                else -> if (!sess.channelName.isNullOrBlank()) Icons.Default.LiveTv else Icons.Default.Movie
                            }
                            Icon(
                                icon,
                                contentDescription = null,
                                modifier = Modifier.size(18.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f)
                            )

                            val isOTA = sess.mediaType?.lowercase() == "live" || !sess.channelName.isNullOrBlank()
                            val bottomText = if (isOTA) {
                                sess.channelName ?: ""
                            } else {
                                formatTimeLeft(sess.duration, sess.viewOffset) ?: ""
                            }

                            if (bottomText.isNotBlank()) {
                                Text(
                                    bottomText,
                                    style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp, fontWeight = FontWeight.Bold),
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                    }
                }
            }

            TextButton(onClick = onToggleRaw) { Text(if (showRaw) "Hide raw JSON" else "Show raw JSON") }
            if (showRaw) {
                OutlinedCard {
                    Text(snapshot.rawPretty.ifBlank { "(empty)" }, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(12.dp))
                }
            }
        }
    }
}

@Composable
fun RokuBadge() {
    Surface(
        color = Color(0xFF662D91), // Roku Purple
        shape = RoundedCornerShape(4.dp),
        modifier = Modifier.padding(start = 4.dp).size(width = 38.dp, height = 18.dp)
    ) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
            Text(
                "Roku",
                color = Color.White,
                fontSize = 9.sp,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center
            )
        }
    }
}

@Composable
fun AppleIcon(modifier: Modifier = Modifier) {
    Canvas(modifier = modifier) {
        val w = size.width
        val h = size.height
        
        // Rainbow Gradient
        val rainbowBrush = Brush.linearGradient(
            colors = listOf(
                Color(0xFF5EBD3E), // Green
                Color(0xFFFFB900), // Yellow
                Color(0xFFF78200), // Orange
                Color(0xFFE23838), // Red
                Color(0xFF973999), // Purple
                Color(0xFF009CDF)  // Blue
            ),
            start = Offset(0f, 0f),
            end = Offset(0f, h)
        )

        // Stylized Apple Shape
        val path = Path().apply {
            moveTo(w * 0.5f, h * 0.95f)
            cubicTo(w * 0.4f, h * 0.95f, w * 0.15f, h * 0.8f, w * 0.15f, h * 0.55f)
            cubicTo(w * 0.15f, h * 0.25f, w * 0.35f, h * 0.15f, w * 0.5f, h * 0.15f)
            cubicTo(w * 0.65f, h * 0.15f, w * 0.85f, h * 0.25f, w * 0.85f, h * 0.5f)
            // Bite
            cubicTo(w * 0.85f, h * 0.4f, w * 0.7f, h * 0.45f, w * 0.7f, h * 0.55f)
            cubicTo(w * 0.7f, h * 0.65f, w * 0.85f, h * 0.7f, w * 0.85f, h * 0.6f)
            cubicTo(w * 0.85f, h * 0.85f, w * 0.65f, h * 0.95f, w * 0.5f, h * 0.95f)
            close()
        }
        drawPath(path, brush = rainbowBrush)
        
        // Leaf
        val leafPath = Path().apply {
            moveTo(w * 0.52f, h * 0.12f)
            cubicTo(w * 0.52f, h * 0.02f, w * 0.75f, h * 0.02f, w * 0.75f, h * 0.02f)
            cubicTo(w * 0.75f, h * 0.15f, w * 0.52f, h * 0.15f, w * 0.52f, h * 0.15f)
            close()
        }
        drawPath(leafPath, brush = rainbowBrush)
    }
}

@Composable
fun AndroidHeadIcon(modifier: Modifier = Modifier) {
    Canvas(modifier = modifier) {
        val color = Color(0xFFA4C639) // Android Green
        val headRadius = size.width / 2.5f
        val centerX = size.width / 2
        val centerY = size.height * 0.7f
        
        // Draw head (semi-circle)
        drawArc(
            color = color,
            startAngle = 180f,
            sweepAngle = 180f,
            useCenter = true,
            size = Size(headRadius * 2, headRadius * 2),
            topLeft = Offset(centerX - headRadius, centerY - headRadius)
        )
        
        // Eyes
        val eyeRadius = headRadius * 0.15f
        drawCircle(
            color = Color.Black,
            radius = eyeRadius,
            center = Offset(centerX - headRadius * 0.4f, centerY - headRadius * 0.4f)
        )
        drawCircle(
            color = Color.Black,
            radius = eyeRadius,
            center = Offset(centerX + headRadius * 0.4f, centerY - headRadius * 0.4f)
        )
        
        // Antennas
        val antennaWidth = 2.dp.toPx()
        val antennaLength = headRadius * 0.6f
        
        // Left antenna
        drawLine(
            color = color,
            start = Offset(centerX - headRadius * 0.5f, centerY - headRadius * 0.8f),
            end = Offset(centerX - headRadius * 0.8f, centerY - headRadius * 1.3f),
            strokeWidth = antennaWidth
        )
        
        // Right antenna
        drawLine(
            color = color,
            start = Offset(centerX + headRadius * 0.5f, centerY - headRadius * 0.8f),
            end = Offset(centerX + headRadius * 0.8f, centerY - headRadius * 1.3f),
            strokeWidth = antennaWidth
        )
    }
}

private fun formatTimeLeft(duration: Long?, viewOffset: Long?): String? {
    if (duration == null || viewOffset == null || duration <= 0) return null
    
    val dur = if (duration < 100000) duration * 1000 else duration
    val off = if (viewOffset < 100000 && viewOffset > 0) viewOffset * 1000 else viewOffset
    
    val leftMs = dur - off
    if (leftMs <= 0) return null
    
    val totalMinutes = leftMs / 60000
    val hours = totalMinutes / 60
    val minutes = totalMinutes % 60
    
    return when {
        hours > 0 -> "${hours}h, ${minutes}min left"
        else -> "${minutes}min left"
    }
}
