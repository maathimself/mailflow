package sh.mailflow.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class MailFlowOidcLoginTest {
    private static final String HOST = "https://mail.example.com";

    @Test
    public void onlyConfiguredServerOidcStartsOpenTheLoginView() {
        assertTrue(MailFlowOidcLogin.isStartUrl(HOST, HOST + "/auth/oidc/corporate/start"));
        assertTrue(MailFlowOidcLogin.isStartUrl(HOST, HOST + "/auth/oidc/corporate/start?action=link"));
        assertTrue(MailFlowOidcLogin.isStartUrl(HOST, "https://mail.example.com:443/auth/oidc/sso/start"));

        for (String url : new String[] {
            HOST + "/auth/oidc/corporate/callback?code=test&state=test",
            HOST + "/auth/oidc/corporate/start/extra",
            HOST + "/auth/oidc/corporate/extra/start",
            HOST + "/inbox?next=/auth/oidc/corporate/start",
            "https://mail.example.com.attacker.test/auth/oidc/sso/start",
            "https://mail.example.com:444/auth/oidc/sso/start",
            "https://id.example.com/auth/oidc/sso/start",
            "http://mail.example.com/auth/oidc/sso/start",
            "not a URL"
        }) {
            assertFalse(url, MailFlowOidcLogin.isStartUrl(HOST, url));
        }
        assertFalse(MailFlowOidcLogin.isStartUrl(null, HOST + "/auth/oidc/sso/start"));
    }

    @Test
    public void callbackAndErrorsReturnToTheAppButProviderPagesDoNot() {
        assertTrue(MailFlowOidcLogin.isReturnUrl(HOST, HOST + "/auth/oidc/corporate/callback?code=test&state=test"));
        assertTrue(MailFlowOidcLogin.isReturnUrl(HOST, HOST + "/login?oidc_error=test"));
        assertTrue(MailFlowOidcLogin.isReturnUrl(HOST, HOST + "/?oidc_success=login"));
        assertFalse(MailFlowOidcLogin.isReturnUrl(HOST, HOST + "/auth/oidc/corporate/start"));
        assertFalse(MailFlowOidcLogin.isReturnUrl(HOST, "https://id.example.com/authorize"));
        assertFalse(MailFlowOidcLogin.isReturnUrl(HOST, "https://mail.example.com.attacker.test/callback"));
    }

    @Test
    public void sameOriginProviderPagesStayInTheLoginView() {
        for (String url : new String[] {
            HOST + "/realms/company/protocol/openid-connect/auth",
            HOST + "/if/flow/authentication/",
            HOST + "/login",
            HOST + "/",
            HOST + "/login?next=oidc_error=test",
            HOST + "/other?oidc_success=login",
            HOST + "/auth/oidc/corporate/callback/extra?code=test"
        }) {
            assertTrue(url, MailFlowOidcLogin.isAllowedUrl(HOST, url));
            assertFalse(url, MailFlowOidcLogin.isReturnUrl(HOST, url));
        }
        assertTrue(MailFlowOidcLogin.isReturnUrl(HOST, HOST + "/?oidc_error=denied"));
        assertTrue(MailFlowOidcLogin.isReturnUrl(HOST, HOST + "/?oidc_success=linked"));
        assertTrue(MailFlowOidcLogin.isReturnUrl(HOST, HOST + "/login?other=value&oidc_error=denied"));
    }

    @Test
    public void browserQueryCharactersDoNotChangeTheOriginOrPathPolicy() {
        for (String query : new String[] { "code=a|b&state=test", "code={value}", "code=100%" }) {
            assertTrue(MailFlowOidcLogin.isReturnUrl(HOST, HOST + "/auth/oidc/corporate/callback?" + query));
            assertTrue(MailFlowOidcLogin.isAllowedUrl(HOST, "https://id.example.com/login?" + query));
            assertTrue(MailFlowOidcLogin.isStartUrl(HOST, HOST + "/auth/oidc/corporate/start?" + query));
            assertFalse(MailFlowOidcLogin.isStartUrl(HOST, "https://mail.example.com.attacker.test/auth/oidc/corporate/start?" + query));
        }
        assertFalse(MailFlowOidcLogin.isReturnUrl(HOST, HOST + "/login#?oidc_error=test"));
    }

    @Test
    public void logoutReturnsOnlyToTheConfiguredLoginPage() {
        assertTrue(MailFlowOidcLogin.isLogoutReturnUrl(HOST, HOST + "/login"));
        assertTrue(MailFlowOidcLogin.isLogoutReturnUrl(HOST, HOST + "/login?result=a|b"));
        assertFalse(MailFlowOidcLogin.isLogoutReturnUrl(HOST, "https://id.example.com/login"));
        assertFalse(MailFlowOidcLogin.isLogoutReturnUrl(HOST, HOST + "/login/extra"));
        assertFalse(MailFlowOidcLogin.isLogoutReturnUrl(HOST, HOST + "/auth/oidc/corporate/callback"));
    }

    @Test
    public void providerNavigationRequiresHttpsAndNeverAcceptsLocalSchemes() {
        assertTrue(MailFlowOidcLogin.isAllowedUrl(HOST, "https://id.example.com/authorize"));
        assertTrue(MailFlowOidcLogin.isAllowedUrl(HOST, "https://federated.example.com/login"));
        assertTrue(MailFlowOidcLogin.isAllowedUrl("http://192.168.1.10", "http://192.168.1.10/auth/oidc/sso/start"));

        for (String url : new String[] {
            "http://id.example.com/login",
            "http://192.168.1.20/login",
            "javascript:alert(1)",
            "file:///data/local/tmp/test.html",
            "content://test/login",
            "intent://test",
            "mailflow://compose",
            "not a URL"
        }) {
            assertFalse(url, MailFlowOidcLogin.isAllowedUrl(HOST, url));
        }
    }
}
