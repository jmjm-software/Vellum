package dev.vellum.app

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Server URL + client token in EncryptedSharedPreferences. The token is a
 * *client* token (read + local actions); agent edit/publish tokens never
 * belong on a phone.
 */
object Prefs {
    private const val FILE = "vellum_secure_prefs"
    private const val KEY_URL = "server_url"
    private const val KEY_TOKEN = "client_token"

    @Volatile
    private var cached: SharedPreferences? = null

    fun store(context: Context): SharedPreferences {
        cached?.let { return it }
        synchronized(this) {
            cached?.let { return it }
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            val prefs = EncryptedSharedPreferences.create(
                context,
                FILE,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
            cached = prefs
            return prefs
        }
    }

    var Context.serverUrl: String
        get() = store(this).getString(KEY_URL, null)?.trimEnd('/') ?: ""
        set(value) = store(this).edit().putString(KEY_URL, value.trimEnd('/')).apply()

    var Context.clientToken: String
        get() = store(this).getString(KEY_TOKEN, "") ?: ""
        set(value) = store(this).edit().putString(KEY_TOKEN, value).apply()

    fun Context.isConfigured(): Boolean = serverUrl.isNotBlank() && clientToken.isNotBlank()
}
