package sh.mailexpert.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import androidx.core.app.NotificationManagerCompat;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

public class MailExpertNotificationActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;

        String action = intent.getAction();
        String messageId = intent.getStringExtra("messageId");
        if (messageId == null || messageId.isEmpty()) return;
        if (!MailExpertNativePlugin.isTrustedNativeIntent(context, intent)) return;
        if (!MailExpertNativePlugin.ACTION_DELETE_MESSAGE.equals(action)
            && !MailExpertNativePlugin.ACTION_STAR_MESSAGE.equals(action)) return;

        int notificationId = intent.getIntExtra("notificationId", -1);
        if (notificationId != -1) {
            NotificationManagerCompat.from(context).cancel(notificationId);
        }

        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build();
        Data input = new Data.Builder()
            .putString(MailExpertNotificationActionWorker.KEY_ACTION, action)
            .putString(MailExpertNotificationActionWorker.KEY_MESSAGE_ID, messageId)
            .build();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(MailExpertNotificationActionWorker.class)
            .setInputData(input)
            .setConstraints(constraints)
            .build();

        WorkManager.getInstance(context.getApplicationContext()).enqueue(request);
    }
}
