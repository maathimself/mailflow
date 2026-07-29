package sh.mailflow.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class NativeSecurityTest {
    @Test
    public void normalizeHostAllowsHttpsAndStripsNonOriginComponents() {
        assertEquals(
            "https://mail.example.com:8443",
            NativeSecurity.normalizeHost(" https://MAIL.example.com:8443/inbox?q=all#today ")
        );
    }

    @Test
    public void normalizeHostAllowsOnlyLocalAndRfc1918Cleartext() {
        assertEquals("http://localhost:3000", NativeSecurity.normalizeHost("http://localhost:3000"));
        assertEquals("http://127.0.0.1", NativeSecurity.normalizeHost("http://127.0.0.1"));
        assertEquals("http://10.0.0.8", NativeSecurity.normalizeHost("http://10.0.0.8"));
        assertEquals("http://172.16.0.1", NativeSecurity.normalizeHost("http://172.16.0.1"));
        assertEquals("http://172.31.255.255", NativeSecurity.normalizeHost("http://172.31.255.255"));
        assertEquals("http://192.168.1.20", NativeSecurity.normalizeHost("http://192.168.1.20"));
        assertEquals("http://[::1]:8080", NativeSecurity.normalizeHost("http://[::1]:8080"));

        assertNull(NativeSecurity.normalizeHost("http://mail.example.com"));
        assertNull(NativeSecurity.normalizeHost("http://localhost.example.com"));
        assertNull(NativeSecurity.normalizeHost("http://172.32.0.1"));
        assertNull(NativeSecurity.normalizeHost("http://192.169.0.1"));
        assertNull(NativeSecurity.normalizeHost("http://169.254.1.1"));
    }

    @Test
    public void sameOriginRejectsPrefixLookalikesAndPortChanges() {
        assertTrue(NativeSecurity.isSameOrigin(
            "https://mail.example.com",
            "https://mail.example.com/inbox"
        ));
        assertTrue(NativeSecurity.isSameOrigin(
            "https://mail.example.com",
            "https://mail.example.com:443/inbox"
        ));
        assertFalse(NativeSecurity.isSameOrigin(
            "https://mail.example.com",
            "https://mail.example.com.attacker.test"
        ));
        assertFalse(NativeSecurity.isSameOrigin(
            "https://mail.example.com",
            "https://mail.example.com:444"
        ));
    }

    @Test
    public void updateUrlsMustRemainHttpsAcrossRedirects() {
        assertTrue(NativeSecurity.isHttpsUrl("https://github.com/release.apk"));
        assertFalse(NativeSecurity.isHttpsUrl("http://github.com/release.apk"));
        assertFalse(NativeSecurity.isHttpsUrl("file:///tmp/release.apk"));
        assertFalse(NativeSecurity.isHttpsUrl("not a url"));
    }

    @Test
    public void secretComparisonRejectsMissingAndDifferentValues() {
        assertTrue(NativeSecurity.secretsMatch("install-secret", "install-secret"));
        assertFalse(NativeSecurity.secretsMatch("install-secret", "different"));
        assertFalse(NativeSecurity.secretsMatch("", ""));
        assertFalse(NativeSecurity.secretsMatch(null, "install-secret"));
    }

    @Test
    public void onlyInternalCustomActionsRequireIntentAuthentication() {
        assertTrue(MailFlowNativePlugin.isPrivilegedNativeAction(
            MailFlowNativePlugin.ACTION_OPEN_MESSAGE
        ));
        assertTrue(MailFlowNativePlugin.isPrivilegedNativeAction(
            MailFlowNativePlugin.ACTION_INSTALL_UPDATE
        ));
        assertFalse(MailFlowNativePlugin.isPrivilegedNativeAction(
            "android.intent.action.VIEW"
        ));
        assertFalse(MailFlowNativePlugin.isPrivilegedNativeAction(null));
    }
}
