package com.example.omnistreammobile

import android.content.Context

class TokenStore(private val context: Context) {
    private val prefs = context.getSharedPreferences("omnistream", Context.MODE_PRIVATE)

    fun loadToken(): String? = prefs.getString("token", null)

    fun saveToken(token: String) {
        prefs.edit().putString("token", token).apply()
    }

    fun clearToken() {
        prefs.edit().remove("token").apply()
    }
}
