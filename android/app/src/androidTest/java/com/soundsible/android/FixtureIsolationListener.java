package com.soundsible.android;

import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.TimeUnit;
import okhttp3.HttpUrl;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.MediaType;
import org.junit.runner.Description;
import org.junit.runner.notification.RunListener;

/** Independent cases share real engines, but never inherit another case's login budget. */
public class FixtureIsolationListener extends RunListener {
    @Override public void testStarted(Description description) throws Exception {
        // Ordinary audio/offline tests do not interact with system permission dialogs.
        // Fresh-install runs of NotificationPermissionTest exercise both system choices.
        if (android.os.Build.VERSION.SDK_INT >= 33 && !description.getClassName().endsWith("NotificationPermissionTest")) {
            var instrumentation = InstrumentationRegistry.getInstrumentation();
            instrumentation.getUiAutomation().grantRuntimePermission(instrumentation.getTargetContext().getPackageName(), android.Manifest.permission.POST_NOTIFICATIONS);
        }
        var arguments=InstrumentationRegistry.getArguments();
        for(String name:new String[]{"fixtureOrigin","passwordlessOrigin","tlsOrigin"}){
            String value=arguments.getString(name);if(value==null)continue;
            HttpUrl origin=HttpUrl.get(value);
            // The reset is idempotent, so a call that timed out is repeated. One
            // 8 s timeout here used to fail the whole shard as "Test mechanism"
            // before the test it preceded had run (9 and 11 Nov 2026), while the
            // engine was busy with the previous test's work. A refusal (non-200)
            // is an answer and is not retried.
            java.io.IOException unanswered=null;
            for(int attempt=0;attempt<3;attempt++){
                // A credential-free test client that leaves the app's session alone.
                var client=FixtureClient.builder(origin).retryOnConnectionFailure(false)
                    .connectTimeout(5,TimeUnit.SECONDS).callTimeout(8,TimeUnit.SECONDS).build();
                try(var response=client.newCall(new Request.Builder().url(origin.resolve("/__fixture/reset-auth-limit"))
                    .header("X-Android-Fixture","isolated").post(RequestBody.create("{}",MediaType.get("application/json"))).build()).execute()){
                    if(response.code()!=200)throw new AssertionError("Fixture login budget reset failed: "+response.code());
                    unanswered=null;
                    break;
                }catch(java.io.IOException error){unanswered=error;
                }finally{client.connectionPool().evictAll();client.dispatcher().executorService().shutdown();}
            }
            if(unanswered!=null)throw unanswered;
        }
    }
}
