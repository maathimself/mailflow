package sh.mailflow.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.security.KeyChain;
import android.webkit.ClientCertRequest;
import androidx.annotation.NonNull;
import androidx.lifecycle.DefaultLifecycleObserver;
import androidx.lifecycle.LifecycleOwner;
import java.net.HttpURLConnection;
import java.net.Socket;
import java.security.GeneralSecurityException;
import java.security.Principal;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.KeyManager;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.X509ExtendedKeyManager;

final class MailFlowClientCertificate {
    private static final String PREF_HOST = "clientCertHost";
    private static final String PREF_ALIAS = "clientCertAlias";
    private static final Executor executor = Executors.newSingleThreadExecutor();
    // Requests waiting on the picker or the key load, all for the configured host.
    private static final List<ClientCertRequest> pending = new ArrayList<>();

    private MailFlowClientCertificate() {}

    static void handle(MainActivity activity, ClientCertRequest request, String configuredHost) {
        if (!isConfiguredOrigin(configuredHost, request.getHost(), request.getPort())) {
            request.cancel();
            return;
        }
        synchronized (pending) {
            pending.add(request);
            if (pending.size() > 1) return;
        }

        Context context = activity.getApplicationContext();
        String alias = savedAlias(context, configuredHost);
        if (alias == null) {
            choose(activity, request, configuredHost);
            return;
        }
        executor.execute(() -> {
            if (proceed(context, configuredHost, alias)) return;
            clear(context);
            activity.runOnUiThread(() -> choose(activity, request, configuredHost));
        });
    }

    // Loaded before connecting, so a KeyChain failure becomes a retry rather than an error thrown
    // from inside the TLS handshake.
    static SSLSocketFactory socketFactory(Context context, String host) throws Exception {
        String alias = savedAlias(context, host);
        if (alias == null) return null;
        PrivateKey key;
        X509Certificate[] chain;
        try {
            key = KeyChain.getPrivateKey(context, alias);
            chain = KeyChain.getCertificateChain(context, alias);
        } catch (AssertionError error) {
            throw new GeneralSecurityException("KeyChain is unavailable", error);
        }
        if (key == null || chain == null) throw new GeneralSecurityException("The client certificate is no longer available");
        SSLContext tls = SSLContext.getInstance("TLS");
        tls.init(new KeyManager[] {new AliasKeyManager(alias, key, chain)}, null, null);
        return tls.getSocketFactory();
    }

    static void use(HttpURLConnection connection, SSLSocketFactory socketFactory) {
        if (socketFactory == null || !(connection instanceof HttpsURLConnection)) return;
        ((HttpsURLConnection) connection).setSSLSocketFactory(socketFactory);
        // A redirect keeps the factory, so following one could offer the certificate to another host.
        connection.setInstanceFollowRedirects(false);
    }

    static void clear(Context context) {
        MailFlowNativePlugin.getPrefs(context).edit().remove(PREF_HOST).remove(PREF_ALIAS).apply();
    }

    static boolean isConfiguredOrigin(String configuredHost, String requestHost, int requestPort) {
        if (configuredHost == null || requestHost == null) return false;
        return NativeSecurity.isSameOrigin(configuredHost, "https://" + requestHost + (requestPort == -1 ? "" : ":" + requestPort));
    }

    static String aliasForHost(String savedHost, String savedAlias, String host) {
        return host != null && host.equals(savedHost) ? savedAlias : null;
    }

    private static String savedAlias(Context context, String host) {
        SharedPreferences prefs = MailFlowNativePlugin.getPrefs(context);
        return aliasForHost(prefs.getString(PREF_HOST, null), prefs.getString(PREF_ALIAS, null), host);
    }

    // The callback arrives on a binder thread. No key type or issuer filter: Chromium reports an EC
    // key as "ECDSA" where KeyChain expects "EC", so filtering could hide a valid certificate.
    private static void choose(MainActivity activity, ClientCertRequest request, String host) {
        Context context = activity.getApplicationContext();
        AtomicBoolean answered = new AtomicBoolean(false);
        PickerWatcher watcher = new PickerWatcher(activity, answered);
        activity.getLifecycle().addObserver(watcher);
        try {
            KeyChain.choosePrivateKeyAlias(
                activity,
                alias -> {
                    if (!answered.compareAndSet(false, true)) return;
                    activity.runOnUiThread(() -> activity.getLifecycle().removeObserver(watcher));
                    executor.execute(() -> {
                        if (alias == null || !proceed(context, host, alias)) cancelPending();
                    });
                },
                null,
                null,
                request.getHost(),
                request.getPort(),
                null
            );
        } catch (Exception error) {
            answered.set(true);
            activity.getLifecycle().removeObserver(watcher);
            cancelPending();
        }
    }

    // Must run off the main thread. The alias is saved only once its key has loaded. KeyChain throws
    // AssertionError when it cannot bind to its service in time.
    private static boolean proceed(Context context, String host, String alias) {
        PrivateKey key;
        X509Certificate[] chain;
        try {
            key = KeyChain.getPrivateKey(context, alias);
            chain = KeyChain.getCertificateChain(context, alias);
        } catch (Exception | AssertionError error) {
            return false;
        }
        if (key == null || chain == null) return false;

        MailFlowNativePlugin.getPrefs(context).edit().putString(PREF_HOST, host).putString(PREF_ALIAS, alias).apply();
        for (ClientCertRequest request : drainPending()) request.proceed(key, chain);
        return true;
    }

    private static void cancelPending() {
        for (ClientCertRequest request : drainPending()) request.cancel();
    }

    private static List<ClientCertRequest> drainPending() {
        synchronized (pending) {
            List<ClientCertRequest> requests = new ArrayList<>(pending);
            pending.clear();
            return requests;
        }
    }

    // The system can close the picker without answering: the launcher icon brings the singleTask
    // activity back and clears the picker above it. A picker still unanswered a moment after the
    // app resumes counts as cancelled, or the request would wait forever.
    private static final class PickerWatcher implements DefaultLifecycleObserver {
        private static final long ANSWER_GRACE_MS = 1000;
        private final MainActivity activity;
        private final AtomicBoolean answered;
        private boolean paused = false;

        PickerWatcher(MainActivity activity, AtomicBoolean answered) {
            this.activity = activity;
            this.answered = answered;
        }

        @Override
        public void onPause(@NonNull LifecycleOwner owner) {
            paused = true;
        }

        @Override
        public void onResume(@NonNull LifecycleOwner owner) {
            if (!paused) return;
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                if (!answered.compareAndSet(false, true)) return;
                activity.getLifecycle().removeObserver(this);
                executor.execute(MailFlowClientCertificate::cancelPending);
            }, ANSWER_GRACE_MS);
        }

        @Override
        public void onDestroy(@NonNull LifecycleOwner owner) {
            owner.getLifecycle().removeObserver(this);
            if (answered.compareAndSet(false, true)) executor.execute(MailFlowClientCertificate::cancelPending);
        }
    }

    private static final class AliasKeyManager extends X509ExtendedKeyManager {
        private final String alias;
        private final PrivateKey key;
        private final X509Certificate[] chain;

        AliasKeyManager(String alias, PrivateKey key, X509Certificate[] chain) {
            this.alias = alias;
            this.key = key;
            this.chain = chain;
        }

        @Override
        public String[] getClientAliases(String keyType, Principal[] issuers) {
            return new String[] {alias};
        }

        @Override
        public String chooseClientAlias(String[] keyTypes, Principal[] issuers, Socket socket) {
            return alias;
        }

        @Override
        public String chooseEngineClientAlias(String[] keyTypes, Principal[] issuers, SSLEngine engine) {
            return alias;
        }

        @Override
        public String[] getServerAliases(String keyType, Principal[] issuers) {
            return null;
        }

        @Override
        public String chooseServerAlias(String keyType, Principal[] issuers, Socket socket) {
            return null;
        }

        @Override
        public X509Certificate[] getCertificateChain(String alias) {
            return chain;
        }

        @Override
        public PrivateKey getPrivateKey(String alias) {
            return key;
        }
    }
}
