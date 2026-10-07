package com.soundsible.android

import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairingQrTest {
    private val payload = """{"type":"soundsible_pairing","version":1,"code":"ABCD2345","claim_url":"https://music.example/api/pairing/sessions/claim","player_url":"https://music.example/player/"}"""

    /** A camera Y plane: dark modules on a light background, rows padded to [stride] like real devices. */
    private fun plane(text: String, size: Int = 240, stride: Int = 256): ByteArray {
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 4))
        return ByteArray(stride * size) { index ->
            val x = index % stride; val y = index / stride
            if (x < size && matrix[x, y]) 16 else 235.toByte()
        }
    }

    @Test fun readsTheEngineCodeFromAPaddedLuminancePlane() {
        assertEquals(payload, PairingQr.decode(plane(payload), 256, 240, 240))
    }

    @Test fun keepsScanningPastOtherCodesAndNoise() {
        assertNull(PairingQr.decode(plane("https://example.com/menu"), 256, 240, 240))
        assertNull(PairingQr.decode(plane("""{"type":"other","code":"ABCD2345"}"""), 256, 240, 240))
        assertNull(PairingQr.decode(plane("""{"type":"soundsible_pairing","code":"  "}"""), 256, 240, 240))
        assertNull(PairingQr.decode(ByteArray(256 * 240) { (it * 31).toByte() }, 256, 240, 240))
    }

    @Test fun rejectsPlanesThatDoNotMatchTheirDimensions() {
        assertNull(PairingQr.decode(ByteArray(10), 256, 240, 240))
        assertNull(PairingQr.decode(plane(payload), 200, 240, 240))
    }
}
