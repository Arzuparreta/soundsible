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
        webView.webViewClient = WebViewClient()
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
        if (savedInstanceState == null) {
            webView.loadUrl("$base/player/desktop/")
        }
    }

    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else {
            // The library is the landing screen; back with no web history
            // falls through to the native browser (playback entry point).
            startActivity(Intent(this, BrowseActivity::class.java))
            finish()
        }
    }

    override fun onDestroy() {
        if (::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }
}
