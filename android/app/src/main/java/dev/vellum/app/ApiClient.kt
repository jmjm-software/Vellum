package dev.vellum.app

import dev.vellum.app.dto.StateDto
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Thin synchronous HTTP client for the vellum client API. */
object ApiClient {
    val json = Json { ignoreUnknownKeys = true }

    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

    class ApiException(val code: Int, message: String) : IOException("HTTP $code: $message")

    fun getState(serverUrl: String, token: String): StateDto {
        val body = getString("$serverUrl/api/state", token)
        return json.decodeFromString<StateDto>(body)
    }

    fun getHealth(serverUrl: String): Boolean = try {
        val req = Request.Builder().url("$serverUrl/api/health").get().build()
        http.newCall(req).execute().use { it.isSuccessful }
    } catch (_: IOException) {
        false
    }

    fun getString(url: String, token: String): String {
        val req = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $token")
            .get()
            .build()
        http.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw ApiException(res.code, res.message)
            return res.body?.string() ?: throw IOException("empty body")
        }
    }

    fun postAction(serverUrl: String, token: String, bodyJson: String): String {
        val req = Request.Builder()
            .url("$serverUrl/api/actions")
            .header("Authorization", "Bearer $token")
            .post(bodyJson.toRequestBody(JSON_MEDIA))
            .build()
        http.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw ApiException(res.code, res.message)
            return res.body?.string() ?: ""
        }
    }

    fun getBytes(url: String, token: String?): ByteArray {
        val builder = Request.Builder().url(url).get()
        if (token != null) builder.header("Authorization", "Bearer $token")
        http.newCall(builder.build()).execute().use { res ->
            if (!res.isSuccessful) throw ApiException(res.code, res.message)
            return res.body?.bytes() ?: throw IOException("empty body")
        }
    }
}
