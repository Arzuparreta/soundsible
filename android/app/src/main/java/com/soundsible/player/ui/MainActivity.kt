package com.soundsible.player.ui

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import com.soundsible.player.SoundsibleApp
import com.soundsible.player.R

/** Entry point: routes to pairing or browsing depending on stored credential. */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        val app = application as SoundsibleApp
        if (app.tokenStore.load() != null) {
            startActivity(Intent(this, BrowseActivity::class.java))
        } else {
            startActivity(Intent(this, PairingActivity::class.java))
        }
        finish()
    }
}
