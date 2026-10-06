package com.soundsible.android

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import org.json.JSONObject

/** Reads a Soundsible pairing QR from a camera luminance plane; anything else is ignored so scanning continues. */
internal object PairingQr {
    private val hints = mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE), DecodeHintType.CHARACTER_SET to "UTF-8")

    fun decode(luminance: ByteArray, rowStride: Int, width: Int, height: Int): String? {
        if (width <= 0 || height <= 0 || rowStride < width || luminance.size < rowStride * (height - 1) + width) return null
        val text = try {
            val source = PlanarYUVLuminanceSource(luminance, rowStride, height, 0, 0, width, height, false)
            QRCodeReader().decode(BinaryBitmap(HybridBinarizer(source)), hints).text
        } catch (_: ReaderException) { return null }
        catch (_: IllegalArgumentException) { return null }
        return text.takeIf(::isPairing)
    }

    /** The engine's `qr_text`: compact JSON with type and code. The WebView validates the server address before any request. */
    fun isPairing(text: String): Boolean = text.length <= 4096 && runCatching {
        val payload = JSONObject(text)
        payload.optString("type") == "soundsible_pairing" && payload.optString("code").trim().isNotEmpty()
    }.getOrDefault(false)
}
