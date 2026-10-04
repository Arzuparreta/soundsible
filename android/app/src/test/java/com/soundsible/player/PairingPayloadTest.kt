package com.soundsible.player

import com.soundsible.player.data.PairingPayload
import org.junit.Assert.*
import org.junit.Test

class PairingPayloadTest {
    private val qr = """{"type":"soundsible_pairing","version":1,"code":"AB12CD34","claim_url":"http://192.168.1.40:5005/api/pairing/sessions/claim","player_url":"http://192.168.1.40:5005/player/"}"""

    @Test fun parsesTheEngineQRPayload() {
        val payload = PairingPayload.parse(qr)!!
        assertEquals("AB12CD34", payload.code)
        assertEquals("http://192.168.1.40:5005", payload.baseUrl())
    }

    @Test fun fallsBackToPlayerUrlWhenClaimUrlIsMissing() {
        val payload = PairingPayload.parse(
            """{"type":"soundsible_pairing","version":1,"code":"X","player_url":"http://10.0.0.5:5005/player/"}""",
        )!!
        assertEquals("http://10.0.0.5:5005", payload.baseUrl())
    }

    @Test fun rejectsBarcodesThatAreNotSoundsible() {
        assertNull(PairingPayload.parse("https://example.com"))
        assertNull(PairingPayload.parse("""{"type":"other","code":"AB12"}"""))
        assertNull(PairingPayload.parse("""{"type":"soundsible_pairing"}"""))
        assertNull(PairingPayload.parse(""))
    }
}
