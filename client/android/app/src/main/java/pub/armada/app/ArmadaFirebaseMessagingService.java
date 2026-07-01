package pub.armada.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Receives FCM push messages from the shared nostr-push server.
 *
 * This is the battery-free, OS-delivered path (an alternative to the persistent
 * {@link NotificationRelayService} relay connection). The server can't decrypt
 * DMs (NIP-04) or Concord messages (NIP-44), so it sends a generic title/body
 * — matching the opaque fallbacks the persistent path already shows. The tapped
 * notification deep-links via the same {@code armada://open<path>} ACTION_VIEW
 * contract, and the WebView enriches the content once open.
 *
 * When the app is backgrounded/killed and the message carries a `notification`
 * block, Android auto-displays it (this service's onMessageReceived is only
 * called for the `data` block then). In the foreground onMessageReceived always
 * fires, so we render it here for parity — reusing the persistent path's channel
 * and icon so notifications look identical regardless of delivery method.
 */
public class ArmadaFirebaseMessagingService extends FirebaseMessagingService {

    private static final String TAG = "ArmadaFCM";
    /** Reuse the persistent path's high-importance message channel. */
    private static final String CHANNEL_ID = "armada_notifications_v2";
    private static int notificationCounter = 3_000_000;

    @Override
    public void onNewToken(String token) {
        // The token can rotate. The JS layer (useFcmNotifications) re-fetches and
        // re-registers on app start; nothing to do here beyond logging.
        Log.d(TAG, "FCM token refreshed (len=" + (token != null ? token.length() : 0) + ")");
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        String title = null;
        String body = null;

        RemoteMessage.Notification notification = message.getNotification();
        if (notification != null) {
            title = notification.getTitle();
            body = notification.getBody();
        }

        Map<String, String> data = message.getData();
        String path = null;
        if (data != null) {
            if (title == null) title = data.get("title");
            if (body == null) body = data.get("body");
            path = data.get("url");
        }

        if (title == null && body == null) {
            Log.d(TAG, "Received FCM message with no title/body — ignoring");
            return;
        }

        showNotification(title != null ? title : "Armada", body != null ? body : "", path);
    }

    private void showNotification(String title, String body, String path) {
        createNotificationChannel();

        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;

        int id = notificationCounter++;

        // Same deep-link contract as NotificationRelayService: ACTION_VIEW with
        // an armada://open<path> data URI so @capacitor/app surfaces the launch
        // URL and useNotificationNavigation / coldLaunchDeepLink route it.
        String deepLink = "armada://open" + (path != null && path.startsWith("/") ? path : "/");
        Intent intent = new Intent(this, MainActivity.class);
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(Uri.parse(deepLink));
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (path != null) intent.putExtra("armada_path", path);

        PendingIntent pendingIntent = PendingIntent.getActivity(
                this, id, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(body)
                .setSmallIcon(R.drawable.ic_stat_armada)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(pendingIntent)
                .setAutoCancel(true);

        manager.notify(id, builder.build());
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager == null) return;
            // If the persistent service already created this channel, this is a
            // no-op; otherwise define it with matching high importance.
            if (manager.getNotificationChannel(CHANNEL_ID) != null) return;
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Messages",
                    NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("New messages and mentions");
            manager.createNotificationChannel(channel);
        }
    }
}
