package com.latexsnipper.app.ocr;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;

/**
 * Progress notification for long model downloads (rectification P1-01).
 *
 * Extracted from NativeOcrBridge, where notification handling sat alongside
 * OCR, model management and secret storage.
 *
 * Every method fails soft: a notification is a convenience, and a device that
 * refuses it (permission denied, channel unavailable, OEM restriction) must not
 * take the download down with it.
 */
final class DownloadNotifier {

    private static final String TAG = "DownloadNotifier";
    private static final String CHANNEL_ID = "model_download";
    private static final int NOTIFICATION_ID = 1001;
    private static final int PERMISSION_REQUEST_CODE = 1002;
    private static final String POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS";
    /** Android 13 (TIRAMISU) is where notifications became a runtime permission. */
    private static final int ANDROID_13 = 33;

    private final Context context;

    DownloadNotifier(Context context) {
        this.context = context;
    }

    private boolean canPost() {
        if (Build.VERSION.SDK_INT < ANDROID_13) return true;
        return context.checkSelfPermission(POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    /** @param max 0 renders an indeterminate bar */
    void show(String title, int progress, int max) {
        try {
            NotificationManager nm =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (!canPost()) {
                Log.w(TAG, "POST_NOTIFICATIONS not granted, skipping notification");
                return;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "Model Download", NotificationManager.IMPORTANCE_LOW);
                channel.setDescription("Model package download progress");
                nm.createNotificationChannel(channel);
            }
            NotificationCompat.Builder builder =
                new NotificationCompat.Builder(context, CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.stat_sys_download)
                    .setContentTitle(title)
                    .setProgress(max, progress, max == 0)
                    .setOngoing(true)
                    // Without this every progress tick re-alerts, which on a
                    // long download is a stream of sounds and vibrations.
                    .setOnlyAlertOnce(true);
            nm.notify(NOTIFICATION_ID, builder.build());
        } catch (Exception e) {
            Log.w(TAG, "show failed: " + e.getMessage());
        }
    }

    void hide() {
        try {
            NotificationManager nm =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(NOTIFICATION_ID);
        } catch (Exception e) {
            Log.w(TAG, "hide failed: " + e.getMessage());
        }
    }

    /**
     * @return true when notifications may already be posted; false when a
     *         request was started (its result arrives asynchronously)
     */
    boolean requestPermission() {
        if (canPost()) return true;
        if (context instanceof android.app.Activity) {
            ((android.app.Activity) context)
                .requestPermissions(new String[]{POST_NOTIFICATIONS}, PERMISSION_REQUEST_CODE);
        }
        return false;
    }
}
