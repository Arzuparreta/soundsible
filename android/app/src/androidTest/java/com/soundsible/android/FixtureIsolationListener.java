package com.soundsible.android;

import androidx.test.platform.app.InstrumentationRegistry;
import java.net.InetAddress;
import java.util.List;
import java.util.concurrent.TimeUnit;
import okhttp3.Dns;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.MediaType;
import org.junit.runner.Description;
import org.junit.runner.notification.RunListener;

/** Independent cases share real engines, but never inherit another case's login budget. */
public class FixtureIsolationListener extends RunListener {
    @Override public void testStarted(Description description) throws Exception {
        var arguments=InstrumentationRegistry.getArguments();
        for(String name:new String[]{"fixtureOrigin","passwordlessOrigin","tlsOrigin"}){
            String value=arguments.getString(name);if(value==null)continue;
            HttpUrl origin=HttpUrl.get(value);
            // A credential-free test client follows the same verified HTTPS and
            // private cleartext routing as the app, without changing its session.
            var client=new OkHttpClient.Builder().retryOnConnectionFailure(false)
                .connectTimeout(5,TimeUnit.SECONDS).callTimeout(8,TimeUnit.SECONDS)
                .followRedirects(false).followSslRedirects(false)
                .dns(host->{if(!host.equals(EngineConnection.PRIVATE_ALIAS))return Dns.SYSTEM.lookup(host);List<InetAddress> addresses=Dns.SYSTEM.lookup(origin.host());for(var address:addresses)if(!EngineConnection.Companion.privateAddress(address))throw new java.net.UnknownHostException("Fixture must be private");return addresses;})
                .addInterceptor(chain->{var request=chain.request();if(!origin.isHttps())request=request.newBuilder().url(request.url().newBuilder().host(EngineConnection.PRIVATE_ALIAS).build()).header("Host",origin.host()+":"+origin.port()).build();return chain.proceed(request);}).build();
            try(var response=client.newCall(new Request.Builder().url(origin.resolve("/__fixture/reset-auth-limit"))
                .header("X-Android-Fixture","isolated").post(RequestBody.create("{}",MediaType.get("application/json"))).build()).execute()){
                if(response.code()!=200)throw new AssertionError("Fixture login budget reset failed: "+response.code());
            }finally{client.connectionPool().evictAll();client.dispatcher().executorService().shutdown();}
        }
    }
}
