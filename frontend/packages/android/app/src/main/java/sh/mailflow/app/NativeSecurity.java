package sh.mailflow.app;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

final class NativeSecurity {
    private NativeSecurity() {}

    static String normalizeHost(String value) {
        try {
            URI uri = new URI(value == null ? "" : value.trim());
            String scheme = uri.getScheme();
            String host = uri.getHost();
            if (scheme == null || host == null) return null;

            scheme = scheme.toLowerCase(Locale.ROOT);
            host = host.toLowerCase(Locale.ROOT);
            if (!"http".equals(scheme) && !"https".equals(scheme)) return null;
            if ("http".equals(scheme) && !isAllowedCleartextHost(host)) return null;

            return new URI(scheme, null, host, uri.getPort(), null, null, null).toString();
        } catch (Exception ignored) {
            return null;
        }
    }

    static boolean isSameOrigin(String configuredHost, String candidateUrl) {
        try {
            URI configured = new URI(configuredHost);
            URI candidate = new URI(candidateUrl);
            return configured.getScheme() != null
                && configured.getHost() != null
                && configured.getScheme().equalsIgnoreCase(candidate.getScheme())
                && configured.getHost().equalsIgnoreCase(candidate.getHost())
                && effectivePort(configured) == effectivePort(candidate);
        } catch (Exception ignored) {
            return false;
        }
    }

    // The page origin for a saved host, as location.origin reports it: no default port.
    static String originOf(String host) {
        try {
            URI uri = new URI(host);
            String scheme = uri.getScheme();
            String name = uri.getHost();
            if (scheme == null || name == null) return null;
            scheme = scheme.toLowerCase(Locale.ROOT);
            if (!"http".equals(scheme) && !"https".equals(scheme)) return null;
            int port = uri.getPort();
            boolean defaultPort = port == -1 || port == effectivePort(new URI(scheme, null, name, -1, null, null, null));
            return scheme + "://" + name.toLowerCase(Locale.ROOT) + (defaultPort ? "" : ":" + port);
        } catch (Exception ignored) {
            return null;
        }
    }

    // Wraps a script so it does nothing unless the page showing is the host's.
    static String hostGuardedScript(String host, String script) {
        String origin = originOf(host);
        if (origin == null || script == null) return null;
        if (!origin.matches("[a-z]+://[A-Za-z0-9.\\-\\[\\]:]+")) return null;
        return "(function(){if(location.origin!=='" + origin + "')return;" + script + "})();";
    }

    static boolean isHttpsUrl(String value) {
        try {
            URI uri = new URI(value);
            return "https".equalsIgnoreCase(uri.getScheme()) && uri.getHost() != null;
        } catch (Exception ignored) {
            return false;
        }
    }

    static boolean secretsMatch(String expected, String supplied) {
        if (expected == null || supplied == null || expected.isEmpty() || supplied.isEmpty()) {
            return false;
        }
        return MessageDigest.isEqual(
            expected.getBytes(StandardCharsets.UTF_8),
            supplied.getBytes(StandardCharsets.UTF_8)
        );
    }

    private static int effectivePort(URI uri) {
        if (uri.getPort() != -1) return uri.getPort();
        if ("https".equalsIgnoreCase(uri.getScheme())) return 443;
        if ("http".equalsIgnoreCase(uri.getScheme())) return 80;
        return -1;
    }

    private static boolean isAllowedCleartextHost(String host) {
        String normalized = host == null ? "" : host.toLowerCase(Locale.ROOT);
        if ("localhost".equals(normalized) || "::1".equals(normalized) || "[::1]".equals(normalized)) {
            return true;
        }

        String[] parts = normalized.split("\\.", -1);
        if (parts.length != 4) return false;

        int[] octets = new int[4];
        for (int i = 0; i < parts.length; i++) {
            if (!parts[i].matches("0|[1-9]\\d{0,2}")) return false;
            try {
                octets[i] = Integer.parseInt(parts[i]);
            } catch (NumberFormatException ignored) {
                return false;
            }
            if (octets[i] > 255) return false;
        }

        return octets[0] == 127
            || octets[0] == 10
            || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
            || (octets[0] == 192 && octets[1] == 168)
            // Shared address space (RFC 6598). Tailscale gives devices addresses here, and
            // its traffic is already encrypted (#776). The unencrypted-connection prompt still shows.
            || (octets[0] == 100 && octets[1] >= 64 && octets[1] <= 127);
    }
}
