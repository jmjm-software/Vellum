package dev.vellum.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest

/** Tracks default-network availability so the shell can flip offline serving. */
class NetworkMonitor(context: Context, private val onChange: (online: Boolean) -> Unit) {
    private val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    @Volatile
    var online: Boolean = cm.activeNetwork?.let { net ->
        cm.getNetworkCapabilities(net)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    } ?: false
        private set

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            online = true
            onChange(true)
        }

        override fun onLost(network: Network) {
            online = cm.activeNetwork != null
            onChange(online)
        }

        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
            val now = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            if (now != online) {
                online = now
                onChange(now)
            }
        }
    }

    fun start() {
        val req = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        runCatching { cm.registerNetworkCallback(req, callback) }
    }

    fun stop() = runCatching { cm.unregisterNetworkCallback(callback) }
}
