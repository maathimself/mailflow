package sh.mailflow.app;

import static org.junit.Assert.*;

import android.app.Instrumentation;
import android.content.Intent;
import android.view.View;
import android.view.ViewGroup;
import android.view.inspector.WindowInspector;
import android.webkit.CookieManager;
import android.webkit.WebView;
import android.widget.TextView;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.filters.SdkSuppress;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.security.KeyStore;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.SSLSocket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
@SdkSuppress(minSdkVersion = 29)
public class MailFlowOidcFlowTest {
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    private final List<String> requests = java.util.Collections.synchronizedList(new ArrayList<>());
    private ServerSocket server;
    private SSLServerSocket tlsServer;
    private MainActivity activity;
    private WebView appView;
    private String host;

    @Before
    public void start() throws Exception {
        server = new ServerSocket(0, 10, InetAddress.getByName("127.0.0.1"));
        host = "http://127.0.0.1:" + server.getLocalPort();
        Thread serving = new Thread(() -> {
            while (!server.isClosed()) {
                try (Socket socket = server.accept()) {
                    socket.setSoTimeout(2000);
                    BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                    String first = reader.readLine();
                    if (first == null) continue;
                    String headers = "";
                    for (String line; (line = reader.readLine()) != null && !line.isEmpty();) headers += line + "\n";
                    requests.add(first + "\n" + headers);
                    String path = first.split(" ")[1];
                    String extra = "";
                    String body = "<html><body>MailFlow test</body></html>";
                    int status = 200;
                    if (path.startsWith("/auth/oidc/company/start")) {
                        status = 302;
                        extra = "Location: " + (path.contains("blocked=1") ? "http://localhost:" + server.getLocalPort() + "/provider" : host + "/provider?hint=a|b") + "\r\n";
                        extra += "Set-Cookie: pending=test; Path=/; HttpOnly\r\n";
                    } else if (path.startsWith("/auth/oidc/company/callback")) {
                        status = 302;
                        extra = "Location: /?oidc_success=login\r\n";
                    } else if (path.startsWith("/provider/end")) {
                        status = 302;
                        extra = "Set-Cookie: provider=; Max-Age=0; Path=/\r\nLocation: /login\r\n";
                    } else if (path.startsWith("/provider")) {
                        extra = "Set-Cookie: provider=session; Path=/; HttpOnly\r\n";
                    }
                    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                    OutputStream out = socket.getOutputStream();
                    out.write(("HTTP/1.1 " + status + " Test\r\nContent-Type: text/html; charset=utf-8\r\n" + extra
                        + "Content-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                    out.write(bytes);
                } catch (Exception error) {
                    if (!server.isClosed() && !(error instanceof java.net.SocketTimeoutException)) throw new RuntimeException(error);
                }
            }
        });
        serving.setDaemon(true);
        serving.start();
        instrumentation.getTargetContext().getSharedPreferences("mailflow-native", 0).edit().putString("host", host).commit();
        activity = (MainActivity) instrumentation.startActivitySync(new Intent(instrumentation.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        instrumentation.waitForIdleSync();
        instrumentation.runOnMainSync(() -> appView = activity.getBridge().getWebView());
        waitForScript("location.origin === '" + host + "' && document.readyState === 'complete' && !!window.mailflowNative");
        instrumentation.runOnMainSync(() -> appView.getSettings().setUserAgentString(appView.getSettings().getUserAgentString() + " MailFlowAppTest"));
    }

    @After
    public void stop() throws Exception {
        if (activity != null) instrumentation.runOnMainSync(() -> activity.finish());
        if (server != null) server.close();
        if (tlsServer != null) tlsServer.close();
    }

    private String evaluate(WebView view, String script) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> view.evaluateJavascript(script, result -> { value.set(result); done.countDown(); }));
        assertTrue("JavaScript response timed out", done.await(10, TimeUnit.SECONDS));
        return value.get();
    }

    private void waitForScript(String script) throws Exception {
        waitForScript(appView, script);
    }

    private void waitForScript(WebView view, String script) throws Exception {
        long deadline = System.currentTimeMillis() + 10000;
        while (System.currentTimeMillis() < deadline) {
            if ("true".equals(evaluate(view, script))) return;
            Thread.sleep(50);
        }
        fail("Timed out: " + script);
    }

    private WebView findLoginView(View view) {
        if (view instanceof WebView && view != appView) return (WebView) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) {
                WebView found = findLoginView(group.getChildAt(i));
                if (found != null) return found;
            }
        }
        return null;
    }

    private boolean containsHost(View view) {
        if (view instanceof TextView && ((TextView) view).getText().toString().equals(host)) return true;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) if (containsHost(group.getChildAt(i))) return true;
        }
        return false;
    }

    private String findRequest(String prefix) {
        synchronized (requests) {
            for (String request : requests) if (request.startsWith(prefix)) return request;
        }
        return "";
    }

    private void assertLoginClosed() {
        instrumentation.runOnMainSync(() -> {
            for (View root : WindowInspector.getGlobalWindowViews()) assertNull(findLoginView(root));
        });
    }

    private WebView waitForLoginView() throws Exception {
        AtomicReference<WebView> login = new AtomicReference<>();
        long deadline = System.currentTimeMillis() + 10000;
        while (login.get() == null && System.currentTimeMillis() < deadline) {
            instrumentation.runOnMainSync(() -> {
                for (View root : WindowInspector.getGlobalWindowViews()) {
                    WebView found = findLoginView(root);
                    if (found != null) login.set(found);
                }
            });
            Thread.sleep(50);
        }
        assertNotNull("OIDC link must open a separate WebView; app=" + evaluate(appView, "location.href") + "; requests=" + requests, login.get());
        return login.get();
    }

    @Test
    public void loginAndLogoutShareCookiesWithoutExposingNativeFunctions() throws Exception {
        evaluate(appView, "location.href='/auth/oidc/company/start'");
        WebView login = waitForLoginView();
        waitForScript(login, "location.pathname === '/provider' && document.readyState === 'complete'");
        instrumentation.runOnMainSync(() -> {
            boolean visibleHost = false;
            for (View root : WindowInspector.getGlobalWindowViews()) visibleHost |= containsHost(root);
            assertTrue("Provider origin must be visible", visibleHost);
        });
        assertEquals("true", evaluate(login, "typeof MailFlowAndroid === 'undefined' && typeof androidBridge === 'undefined' && typeof Capacitor === 'undefined'"));
        evaluate(login, "location.href='/auth/oidc/company/callback?code=a|b&state=test'");
        waitForScript("location.search === '?oidc_success=login' && typeof window.mailflowNative?.openOidcLogout === 'function'");
        assertLoginClosed();
        String callback = findRequest("GET /auth/oidc/company/callback");
        assertTrue(callback, callback.contains("MailFlowAppTest") && callback.contains("pending=test"));
        evaluate(appView, "window.mailflowNative.openOidcLogout('" + host + "/provider/end')");
        waitForScript("location.pathname === '/login'");
        assertLoginClosed();
        String logout = findRequest("GET /provider/end");
        assertTrue(logout, logout.contains("provider=session"));
        assertFalse("Logout must use the unprivileged view", logout.contains("MailFlowAppTest"));
        AtomicReference<String> cookies = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> cookies.set(CookieManager.getInstance().getCookie(host)));
        assertFalse(String.valueOf(cookies.get()), String.valueOf(cookies.get()).contains("provider=session"));
    }

    @Test
    public void blockedRedirectReturnsAnErrorForBothLoginAndLinking() throws Exception {
        for (String action : new String[] { "login", "link" }) {
            evaluate(appView, "location.href='/auth/oidc/company/start?action=" + action + "&blocked=1'");
            waitForScript("location.search.includes('oidc_error=') && location.pathname === '" + (action.equals("link") ? "/" : "/login") + "'");
        }
    }

    @Test
    public void certificateErrorsOnlyCloseTheWindowForMainPageLoads() throws Exception {
        KeyStore keys = KeyStore.getInstance("PKCS12");
        try (java.io.InputStream input = instrumentation.getContext().getAssets().open("untrusted-provider.p12")) {
            keys.load(input, "test-only".toCharArray());
        }
        KeyManagerFactory managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        managers.init(keys, "test-only".toCharArray());
        SSLContext tls = SSLContext.getInstance("TLS");
        tls.init(managers.getKeyManagers(), null, null);
        tlsServer = (SSLServerSocket) tls.getServerSocketFactory().createServerSocket(0, 10, InetAddress.getByName("127.0.0.1"));
        Thread serving = new Thread(() -> {
            while (!tlsServer.isClosed()) {
                try (SSLSocket socket = (SSLSocket) tlsServer.accept()) {
                    socket.setSoTimeout(2000);
                    socket.startHandshake();
                } catch (java.io.IOException expected) {
                    // The WebView must reject this test server's self-signed certificate.
                }
            }
        });
        serving.setDaemon(true);
        serving.start();
        String provider = "https://127.0.0.1:" + tlsServer.getLocalPort();
        for (String action : new String[] { "login", "link" }) {
            instrumentation.runOnMainSync(() -> MailFlowOidcLogin.open(activity, appView, host, host + "/provider?action=" + action));
            WebView login = waitForLoginView();
            waitForScript(login, "document.readyState === 'complete' && location.pathname === '/provider'");
            evaluate(login, "window.imageFailed=false; var img=new Image(); img.onerror=()=>window.imageFailed=true; img.src='" + provider + "/image'; document.body.append(img)");
            waitForScript(login, "window.imageFailed === true");
            evaluate(login, "location.href='" + provider + "/login'");
            waitForScript("location.search.includes('oidc_error=') && location.pathname === '" + (action.equals("link") ? "/" : "/login") + "'");
            assertLoginClosed();
        }
    }
}
