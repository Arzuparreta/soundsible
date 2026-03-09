"""
Haptics Engine (GTK) - Soundsible 'Cyber-Premium' Tactile Feedback

Provides a centralized API for high-fidelity vibration patterns.
Currently acts as a parity stub for the Linux application, with optional
system bell support for accessibility.
"""
from gi.repository import Gdk

class Haptics:
    # Note: Tactile vocabulary (parity with webui)
    PATTERNS = {
        'TICK': [5],
        'LOCK': [15],
        'HEAVY': [30],
        'SUCCESS': [10, 50, 10],
        'ERROR': [50, 50, 50]
    }

    ENABLED = True # Note: TODO: bind to player config

    @staticmethod
    def trigger(pattern_name):
        """
        Triggers a haptic event.
        On standard Linux desktops without haptic hardware, this is a no-op
        or optional system beep.
        """
        if not Haptics.ENABLED:
            return

        # Note: Future gamepad vibration or specific hardware driver
        # Note: For now, we log for debug parity
        # Note: Print(f"[haptics] trigger {pattern_name}")
        pass

    # Note: Semantic aliases
    @staticmethod
    def tick():
        Haptics.trigger('TICK')

    @staticmethod
    def lock():
        Haptics.trigger('LOCK')

    @staticmethod
    def heavy():
        Haptics.trigger('HEAVY')

    @staticmethod
    def success():
        Haptics.trigger('SUCCESS')

    @staticmethod
    def error():
        # Note: For errors, we can use the system bell as an accessible fallback
        display = Gdk.Display.get_default()
        if display:
            display.beep()
        Haptics.trigger('ERROR')
