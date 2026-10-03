package com.soundsible.android

import androidx.media3.common.PlaybackException
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.HttpDataSource

/** Classify the actual transport error; Certificate/handshake failures never become network retries. */
@UnstableApi
object PlaybackRecovery {
    fun kind(error: PlaybackException?): String {
        if (error == null) return ""
        val causes = generateSequence(error as Throwable) { it.cause }.toList()
        val status = causes.filterIsInstance<HttpDataSource.InvalidResponseCodeException>().firstOrNull()?.responseCode
        return when {
            status == 401 -> "auth"
            status == 403 -> "permission"
            causes.any { it is javax.net.ssl.SSLHandshakeException || it is javax.net.ssl.SSLPeerUnverifiedException || it is java.security.cert.CertificateException } -> "source"
            status == 408 || status == 429 || status in 500..599 -> "server"
            status != null -> "source"
            causes.any { it is HttpDataSource.HttpDataSourceException } || error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED || error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT -> "connection"
            else -> "source"
        }
    }
}
