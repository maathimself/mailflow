package sh.mailflow.app;

import android.app.Activity;
import android.os.Bundle;

public class SyncShortcutActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        MailFlowBackgroundSync.syncNow(this);
        finish();
        overridePendingTransition(0, 0);
    }
}
