package com.soundsible.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Full-screen camera that returns the first Soundsible pairing code it reads. Nothing is stored or sent from here. */
class PairingScanActivity : AppCompatActivity() {
    companion object {
        const val EXTRA_TEXT = "pairingText"
        const val EXTRA_ERROR = "pairingError"
        const val EXTRA_HINT = "hint"
        const val EXTRA_CLOSE = "close"
    }
    private lateinit var analysis: ExecutorService
    private lateinit var preview: PreviewView
    private val delivered = AtomicBoolean(false)
    private val permission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) start() else finishWith(null, "camera_denied")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        analysis = Executors.newSingleThreadExecutor { task -> Thread(task, "soundsible-pairing-scan").apply { isDaemon = true } }
        preview = PreviewView(this).apply { scaleType = PreviewView.ScaleType.FILL_CENTER }
        val density = resources.displayMetrics.density
        val hint = TextView(this).apply {
            text = intent.getStringExtra(EXTRA_HINT).orEmpty(); setTextColor(0xFFFFFFFF.toInt()); textSize = 16f
            setBackgroundColor(0x99000000.toInt()); gravity = Gravity.CENTER
            val pad = (16 * density).toInt(); setPadding(pad, pad, pad, pad)
        }
        val close = Button(this).apply { text = intent.getStringExtra(EXTRA_CLOSE) ?: "×"; setOnClickListener { finishWith(null, "cancelled") } }
        setContentView(FrameLayout(this).apply {
            setBackgroundColor(0xFF000000.toInt())
            addView(preview, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
            addView(hint, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
            addView(close, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.END).apply {
                val margin = (16 * density).toInt(); setMargins(margin, margin, margin, margin)
            })
        })
        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = finishWith(null, "cancelled")
        })
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) start()
        else permission.launch(Manifest.permission.CAMERA)
    }

    private fun start() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val provider = runCatching { future.get() }.getOrNull() ?: return@addListener finishWith(null, "camera_unavailable")
            if (isFinishing || isDestroyed) return@addListener
            val shown = Preview.Builder().build().also { it.setSurfaceProvider(preview.surfaceProvider) }
            val reader = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
            reader.setAnalyzer(analysis) { image ->
                try {
                    if (delivered.get()) return@setAnalyzer
                    val plane = image.planes[0]
                    val buffer = plane.buffer.duplicate().apply { rewind() }
                    val bytes = ByteArray(buffer.remaining()).also(buffer::get)
                    val text = PairingQr.decode(bytes, plane.rowStride, image.width, image.height)
                    if (text != null) runOnUiThread { finishWith(text, null) }
                } finally { image.close() }
            }
            val selector = if (provider.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA)) CameraSelector.DEFAULT_BACK_CAMERA
                else if (provider.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA)) CameraSelector.DEFAULT_FRONT_CAMERA
                else return@addListener finishWith(null, "camera_unavailable")
            try { provider.unbindAll(); provider.bindToLifecycle(this, selector, shown, reader) }
            catch (_: Exception) { finishWith(null, "camera_unavailable") }
        }, androidx.core.content.ContextCompat.getMainExecutor(this))
    }

    private fun finishWith(text: String?, error: String?) {
        if (!delivered.compareAndSet(false, true)) return
        setResult(if (text != null) RESULT_OK else RESULT_CANCELED, Intent().apply {
            if (text != null) putExtra(EXTRA_TEXT, text) else putExtra(EXTRA_ERROR, error)
        })
        finish()
    }

    override fun onDestroy() { analysis.shutdownNow(); super.onDestroy() }
}
