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
            || (octets[0] == 192 && octets[1] == 168);
    }
}
