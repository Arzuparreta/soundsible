package com.soundsible.player.ui

/** Page transport actions shared by widget and notification buttons. */
object WebCommand {
    const val TOGGLE = "com.soundsible.player.ui.WEB_TOGGLE"
    const val NEXT = "com.soundsible.player.ui.WEB_NEXT"
    const val PREV = "com.soundsible.player.ui.WEB_PREV"
    const val PAUSE = "com.soundsible.player.ui.WEB_PAUSE"

    fun isCommand(action: String?): Boolean =
        action == TOGGLE || action == NEXT || action == PREV
}
