package com.soundsible.android;

import static org.junit.Assert.assertEquals;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.lang.reflect.Method;
import org.junit.Test;

/** A queued bridge call or permission reply can outlive its Activity. */
public class OfflinePluginLifecycleTest {
    private static class LateCall extends PluginCall {
        String rejection;
        LateCall() { super(null, "SoundsibleOffline", "late", "command", new JSObject()); }
        @Override public void reject(String message, String code) { rejection = code; }
    }

    @Test public void destroyedBridgeRejectsLateCallsAndPermissionReplies() throws Exception {
        OfflinePlugin plugin = new OfflinePlugin();
        Method destroy = OfflinePlugin.class.getDeclaredMethod("handleOnDestroy");
        destroy.setAccessible(true);
        destroy.invoke(plugin);

        LateCall command = new LateCall();
        plugin.command(command);
        assertEquals("OFFLINE_FAILED", command.rejection);

        Method answer = OfflinePlugin.class.getDeclaredMethod("notificationsAnswered", PluginCall.class);
        answer.setAccessible(true);
        LateCall permission = new LateCall();
        answer.invoke(plugin, permission);
        assertEquals("OFFLINE_FAILED", permission.rejection);
    }
}
