package com.soundsible.player.ui

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.soundsible.player.R
import com.soundsible.player.SoundsibleApp

/**
 * Full library management through the engine's own web player.
 *
 * Loads `/player/desktop/` from the connected engine, the route into which
 * the server injects its owner token -- so this WebView is authenticated
 * with no token plumbing on the Android side. Playback stays in the native
 * [NowPlayingActivity]; this screen is for search, playlists, favourites,
 * downloads and settings.
 */
class LibraryActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private var fileChooser: ValueCallback<Array<Uri>>? = null
    private var webSession: WebMediaSession? = null
    private var pageReady = false
    private var pendingCommand: String? = null

    private val pickFile = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val uris = if (result.resultCode == RESULT_OK) {
            val data = result.data
            when {
                data?.clipData != null -> Array(data.clipData!!.itemCount) { i -> data.clipData!!.getItemAt(i).uri }
                data?.data != null -> arrayOf(data.data!!)
                else -> null
            }
        } else {
            null
        }
        fileChooser?.onReceiveValue(uris)
        fileChooser = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_library)
        webView = findViewById(R.id.libraryWebView)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.addJavascriptInterface(SoundsibleNative(this), "SoundsibleNative")
        WebAudio.attach(webView)
        webSession = WebMediaSession(this, webView)
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                pageReady = true
                pendingCommand?.let {
                    pendingCommand = null
                    WebAudio.command(it)
                }
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?,
            ): Boolean {
                fileChooser?.onReceiveValue(null)
                fileChooser = callback
                return try {
                    val intent = params?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "audio/*"
                    }
                    pickFile.launch(intent)
                    true
                } catch (_: Exception) {
                    fileChooser = null
                    false
                }
            }
        }
        val base = (application as SoundsibleApp).tokenStore.load()?.baseUrl?.trimEnd('/')
            ?: return finish()
        handleCommand(intent.action)
        if (savedInstanceState == null) {
            webView.loadUrl("$base/player/desktop/")
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleCommand(intent.action)
    }

    /** Run a widget/notification command now, or stash it until the page loads. */
    private fun handleCommand(action: String?) {
        if (!WebCommand.isCommand(action)) return
        if (pageReady) {
            WebAudio.command(action)
        } else {
            pendingCommand = action
        }
    }

    /**
     * Web playback state from the bridge: mirror it into the widget, the
     * media notification and the system media session -- the surfaces
     * Media3 never sees for page audio.
     */
    fun onWebNowPlaying(
        title: String,
        artist: String,
        album: String,
        isPlaying: Boolean,
        artwork: android.graphics.Bitmap?,
    ) {
        try {
            WebPlaybackHold.setHeld(this, isPlaying && title.isNotEmpty())
            com.soundsible.player.widgets.SoundsibleWidgetProvider.updateAll(
                this,
                title = title,
                subtitle = artist,
                isPlaying = isPlaying,
                artwork = artwork,
                background = artwork?.let { com.soundsible.player.playback.ArtworkLoader.dominantColor(it) },
            )
            webSession?.publish(title, artist, album, isPlaying, artwork)
            if (title.isEmpty()) {
                WebNowPlaying.cancel(this)
            } else {
                WebNowPlaying.show(this, title, artist, isPlaying, artwork)
            }
        } catch (_: Exception) {
        }
    }

    override fun onBackPressed() {
        // The library is the home screen now that native browse is gone;
        // back with no web history leaves the app.
        if (::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        WebAudio.detach(webView)
        try {
            WebPlaybackHold.setHeld(this, false)
        } catch (_: Exception) {
        }
        try {
            WebNowPlaying.cancel(this)
        } catch (_: Exception) {
        }
        try {
            webSession?.release()
        } catch (_: Exception) {
        }
        webSession = null
        if (::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }
}
