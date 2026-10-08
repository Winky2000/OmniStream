package com.winkys.omnistreammobile

import android.content.Context
import androidx.core.content.edit

class SettingsStore(private val context: Context) {
    private val prefs = context.getSharedPreferences("omnistream_settings", Context.MODE_PRIVATE)

    fun loadToken(): String? {
        val t = prefs.getString("token", null)?.trim()
        return if (t.isNullOrBlank()) null else t
    }

    fun saveToken(token: String) {
        val t = token.trim()
        if (t.isBlank()) {
            clearToken()
            return
        }
        prefs.edit { putString("token", t) }
    }

    fun clearToken() {
        prefs.edit { remove("token") }
    }

    fun loadBaseUrl(): String? = prefs.getString("base_url", null)
    fun saveBaseUrl(url: String) {
        val normalized = url.trim().removeSuffix("/")
        prefs.edit { putString("base_url", normalized) }
    }
}
