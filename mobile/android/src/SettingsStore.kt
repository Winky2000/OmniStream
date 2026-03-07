package com.winkys.omnistreammobile

import android.content.Context
import androidx.core.content.edit

class SettingsStore(private val context: Context) {
    private val prefs = context.getSharedPreferences("omnistream_settings", Context.MODE_PRIVATE)

    fun loadToken(): String? = prefs.getString("token", null)
    fun saveToken(token: String) {
        prefs.edit { putString("token", token) }
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
