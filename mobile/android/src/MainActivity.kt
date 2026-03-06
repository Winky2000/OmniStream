package com.example.omnistreammobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val tokenStore = TokenStore(this)
        val api = Api()

        setContent {
            MaterialTheme {
                OmniStreamApp(tokenStore = tokenStore, api = api)
            }
        }
    }
}

@Composable
private fun OmniStreamApp(tokenStore: TokenStore, api: Api) {
    var screen by remember { mutableStateOf("login") }
    var username by remember { mutableStateOf("admin") }
    var password by remember { mutableStateOf("") }

    var isBusy by remember { mutableStateOf(false) }

    var token by remember { mutableStateOf(tokenStore.loadToken()) }
    var errorText by remember { mutableStateOf<String?>(null) }
    var mustChangePassword by remember { mutableStateOf(false) }

    var snapshot by remember { mutableStateOf<StatusSnapshot?>(null) }
    var showRaw by remember { mutableStateOf(false) }

    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        if (!token.isNullOrBlank()) {
            screen = "status"
        }
    }

    LaunchedEffect(screen, token) {
        if (screen != "status" || token.isNullOrBlank()) return@LaunchedEffect

        while (true) {
            try {
                val t = token ?: return@LaunchedEffect
                val snap = kotlinx.coroutines.withContext(Dispatchers.IO) { api.fetchStatusSnapshot(t) }
                snapshot = snap
                errorText = null
            } catch (e: Exception) {
                errorText = e.message
            }
            delay(AppConfig.POLL_INTERVAL_MS)
        }
    }

    if (screen == "login") {
        LoginScreen(
            baseUrl = AppConfig.BASE_URL,
            username = username,
            onUsernameChange = { username = it },
            password = password,
            onPasswordChange = { password = it },
            isBusy = isBusy,
            errorText = errorText,
            mustChangePassword = mustChangePassword,
            onLogin = {
                if (isBusy) return@LoginScreen
                errorText = null
                mustChangePassword = false
                isBusy = true
                scope.launch {
                    try {
                        val resp = kotlinx.coroutines.withContext(Dispatchers.IO) { api.loginToken(username, password) }
                        if (resp.ok == true && !resp.token.isNullOrBlank()) {
                            if (resp.mustChangePassword == true) {
                                mustChangePassword = true
                                tokenStore.clearToken()
                                token = null
                                return@launch
                            }
                            tokenStore.saveToken(resp.token!!)
                            token = resp.token
                            password = ""
                            screen = "status"
                        } else {
                            errorText = resp.error ?: "Login failed"
                        }
                    } finally {
                        isBusy = false
                    }
                }
            }
        )
        return
    }

    StatusScreen(
        snapshot = snapshot,
        errorText = errorText,
        showRaw = showRaw,
        onToggleRaw = { showRaw = !showRaw },
        onLogout = {
            tokenStore.clearToken()
            token = null
            snapshot = null
            errorText = null
            screen = "login"
        }
    )
}

@Composable
private fun LoginScreen(
    baseUrl: String,
    username: String,
    onUsernameChange: (String) -> Unit,
    password: String,
    onPasswordChange: (String) -> Unit,
    isBusy: Boolean,
    errorText: String?,
    mustChangePassword: Boolean,
    onLogin: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("OmniStream", style = MaterialTheme.typography.headlineSmall)
        Text("Server: $baseUrl", style = MaterialTheme.typography.bodySmall)

        OutlinedTextField(
            value = username,
            onValueChange = onUsernameChange,
            label = { Text("Username") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )

        OutlinedTextField(
            value = password,
            onValueChange = onPasswordChange,
            label = { Text("Password") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth()
        )

        if (errorText != null) {
            Text(errorText, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }

        if (mustChangePassword) {
            Text(
                "Password change required. Use the web UI to change it, then log in again.",
                color = MaterialTheme.colorScheme.tertiary,
                style = MaterialTheme.typography.bodySmall
            )
        }

        Button(
            onClick = onLogin,
            enabled = !isBusy,
            modifier = Modifier.align(Alignment.End)
        ) {
            Text(if (isBusy) "Signing in…" else "Sign In")
        }
    }
}

@Composable
private fun StatusScreen(
    snapshot: StatusSnapshot?,
    errorText: String?,
    showRaw: Boolean,
    onToggleRaw: () -> Unit,
    onLogout: () -> Unit
) {
    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("Status", style = MaterialTheme.typography.titleMedium)
            Spacer(modifier = Modifier.weight(1f))
            TextButton(onClick = onLogout) { Text("Log out") }
        }

        if (errorText != null) {
            Text(
                errorText,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(horizontal = 12.dp)
            )
        }

        val scroll = rememberScrollState()
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(scroll)
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
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
                    if (snapshot.servers.isEmpty()) {
                        Text("No servers configured", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    snapshot.servers.forEach { s ->
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(s.name, style = MaterialTheme.typography.bodyMedium)
                                Spacer(modifier = Modifier.weight(1f))
                                val c = if (s.online) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.error
                                Text(if (s.online) "Online" else "Offline", style = MaterialTheme.typography.bodySmall, color = c)
                            }
                            val latency = s.latencyMs?.let { " • ${it}ms" } ?: ""
                            Text(
                                "Streams: ${s.sessionCount} • Transcodes: ${s.transcodes}$latency",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        Divider()
                    }
                }
            }

            OutlinedCard {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Live Sessions", style = MaterialTheme.typography.titleSmall)
                    if (snapshot.sessions.isEmpty()) {
                        Text("No active streams", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    snapshot.sessions.forEach { sess ->
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(if (sess.user.isBlank()) "(unknown user)" else sess.user, style = MaterialTheme.typography.bodyMedium)
                                Spacer(modifier = Modifier.weight(1f))
                                Text(sess.serverName, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            Text(if (sess.title.isBlank()) "(unknown title)" else sess.title, style = MaterialTheme.typography.bodySmall)

                            val bw = sess.bandwidthMbps?.let { String.format("%.1f Mbps", it) }
                            val detail = listOf(sess.detail, bw).filter { !it.isNullOrBlank() }.joinToString(" • ")
                            if (detail.isNotBlank()) {
                                Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        Divider()
                    }
                }
            }

            TextButton(onClick = onToggleRaw) {
                Text(if (showRaw) "Hide raw JSON" else "Show raw JSON")
            }

            if (showRaw) {
                OutlinedCard {
                    Text(
                        snapshot.rawPretty.ifBlank { "(empty)" },
                        fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(12.dp)
                    )
                }
            }
        }
    }
}
