package com.ncsf.league;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.Context;
import android.content.BroadcastReceiver;
import android.content.IntentFilter;
import android.content.ClipData;
import android.database.Cursor;
import android.content.pm.PackageManager;
import android.content.pm.ActivityInfo;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.Build;
import android.provider.Settings;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.URLUtil;
import android.widget.FrameLayout;
import android.widget.Toast;
import java.util.HashMap;
import java.util.Locale;

public class MainActivity extends Activity {
    private static final String HOME_URL = "https://ncsf-production.up.railway.app/";
    private static final int FILE_CHOOSER_REQUEST = 501;
    private static final int MEDIA_PERMISSION_REQUEST = 502;
    private static final int STORAGE_PERMISSION_REQUEST = 503;
    private static final String PREFS_NAME = "ncsf_permissions";
    private static final String PREF_CAMERA_ASKED = "camera_asked";
    private static final String PREF_MIC_ASKED = "mic_asked";

    private WebView webView;
    private FrameLayout root;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingMediaPermission;
    private boolean liveFullscreen = false;
    private boolean downloadReceiverRegistered = false;
    private final HashMap<Long, String> activeDownloads = new HashMap<>();
    private PendingDownload pendingDownload;

    private static class PendingDownload {
        final String url, userAgent, disposition, mimeType;

        PendingDownload(String url, String userAgent, String disposition, String mimeType) {
            this.url = url;
            this.userAgent = userAgent;
            this.disposition = disposition;
            this.mimeType = mimeType;
        }
    }

    // The system DownloadManager delivers completion notifications even when NCSF is closed.
    // While this activity is visible, offer Open / Share immediately as well.
    private final BroadcastReceiver downloadReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (!DownloadManager.ACTION_DOWNLOAD_COMPLETE.equals(intent.getAction())) return;
            long downloadId = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
            String name = activeDownloads.remove(downloadId);
            if (name == null) return; // Ignore downloads from other apps.

            DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            DownloadManager.Query query = new DownloadManager.Query().setFilterById(downloadId);
            try (Cursor result = manager.query(query)) {
                if (!result.moveToFirst()) return;
                int status = result.getInt(result.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                if (status != DownloadManager.STATUS_SUCCESSFUL) {
                    Toast.makeText(MainActivity.this, "Download failed. Please try again.", Toast.LENGTH_LONG).show();
                    return;
                }
                Uri fileUri = manager.getUriForDownloadedFile(downloadId);
                if (fileUri == null || isFinishing() || isDestroyed()) return;
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("PDF saved to Downloads")
                        .setMessage(name + "\n\nFind it in My Files > Downloads.")
                        .setPositiveButton("Open PDF", (dialog, which) -> openDownloadedPdf(fileUri))
                        .setNeutralButton("Share PDF", (dialog, which) -> shareDownloadedPdf(fileUri, name))
                        .setNegativeButton("Close", null)
                        .show();
            } catch (Exception error) {
                Toast.makeText(MainActivity.this, "Saved to Downloads. Open My Files to view it.", Toast.LENGTH_LONG).show();
            }
        }
    };
    private boolean broadcastActive = false;
    private int orientationBeforeBroadcast = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applyImmersiveMode();
        getWindow().setStatusBarColor(Color.rgb(7, 24, 44));
        getWindow().setNavigationBarColor(Color.rgb(7, 24, 44));

        root = new FrameLayout(this);
        webView = new WebView(this);

        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        setContentView(root);
        applyImmersiveMode();

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setUserAgentString(settings.getUserAgentString() + " NCSFAndroid/1.17");

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        webView.addJavascriptInterface(new AppBridge(), "NCSFApp");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String host = uri.getHost();
                if (host != null && host.endsWith("railway.app")) {
                    return false;
                }
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                webView.setVisibility(View.GONE);
                root.addView(customView, new FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.MATCH_PARENT));
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
                webView.postDelayed(() ->
                        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE), 180);
                applyImmersiveMode();
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                root.removeView(customView);
                customView = null;
                webView.setVisibility(View.VISIBLE);
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                applyImmersiveMode();
                if (customViewCallback != null) {
                    customViewCallback.onCustomViewHidden();
                    customViewCallback = null;
                }
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    boolean wantsCamera = false;
                    boolean wantsAudio = false;
                    for (String resource : request.getResources()) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) wantsCamera = true;
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) wantsAudio = true;
                    }

                    boolean cameraGranted = !wantsCamera || checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
                    boolean audioGranted = !wantsAudio || checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;

                    if (cameraGranted && audioGranted) {
                        request.grant(request.getResources());
                    } else {
                        pendingMediaPermission = request;
                        java.util.ArrayList<String> permissions = new java.util.ArrayList<>();
                        if (wantsCamera && !cameraGranted) permissions.add(Manifest.permission.CAMERA);
                        if (wantsAudio && !audioGranted) permissions.add(Manifest.permission.RECORD_AUDIO);
                        requestPermissions(permissions.toArray(new String[0]), MEDIA_PERMISSION_REQUEST);
                    }
                });
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (pendingMediaPermission == request) pendingMediaPermission = null;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = params.createIntent();
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                    return true;
                } catch (Exception ex) {
                    fileCallback = null;
                    Toast.makeText(MainActivity.this, "No file picker available.", Toast.LENGTH_SHORT).show();
                    return false;
                }
            }
        });

        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            PendingDownload download = new PendingDownload(url, userAgent, contentDisposition, mimeType);
            // Only Android 9 and older require storage access to use public Downloads.
            if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P &&
                    checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                            != PackageManager.PERMISSION_GRANTED) {
                pendingDownload = download;
                requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE},
                        STORAGE_PERMISSION_REQUEST);
                return;
            }
            enqueuePublicDownload(download);
        });

        if (savedInstanceState == null) {
            webView.loadUrl(HOME_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    private void enqueuePublicDownload(PendingDownload download) {
        try {
            Uri downloadUrl = Uri.parse(download.url);
            String scheme = downloadUrl.getScheme();
            if (!"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme)) {
                Toast.makeText(this, "This file cannot be downloaded.", Toast.LENGTH_LONG).show();
                return;
            }
            String rawName = URLUtil.guessFileName(download.url, download.disposition, download.mimeType);
            String cleanName = rawName.replaceAll("[^A-Za-z0-9._-]+", "-");
            if (cleanName.isEmpty() || ".".equals(cleanName)) cleanName = "NCSF-document.pdf";

            String mimeType = download.mimeType == null ? "" : download.mimeType.trim();
            if (mimeType.isEmpty()) {
                mimeType = cleanName.toLowerCase(Locale.ROOT).endsWith(".pdf")
                        ? "application/pdf" : "application/octet-stream";
            }

            // Unique names prevent a failed second download of the same scoresheet.
            int dot = cleanName.lastIndexOf('.');
            String suffix = "-" + System.currentTimeMillis();
            String fileName = dot > 0
                    ? cleanName.substring(0, dot) + suffix + cleanName.substring(dot)
                    : cleanName + suffix;

            DownloadManager.Request request = new DownloadManager.Request(downloadUrl);
            String cookies = CookieManager.getInstance().getCookie(download.url);
            if (cookies != null && !cookies.isEmpty()) {
                request.addRequestHeader("Cookie", cookies);
            }
            if (download.userAgent != null && !download.userAgent.isEmpty()) {
                request.addRequestHeader("User-Agent", download.userAgent);
            }
            request.setMimeType(mimeType);
            request.setTitle(fileName);
            request.setDescription("NCSF scoresheet / document");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            // Public Downloads is visible under Samsung My Files > Downloads.
            // App-specific external files are deliberately NOT used here.
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            long downloadId = manager.enqueue(request);
            activeDownloads.put(downloadId, fileName);
            Toast.makeText(this, "Downloading to My Files > Downloads", Toast.LENGTH_LONG).show();
        } catch (Exception error) {
            Toast.makeText(this, "Unable to save file to Downloads.", Toast.LENGTH_LONG).show();
        }
    }

    private void openDownloadedPdf(Uri fileUri) {
        try {
            Intent open = new Intent(Intent.ACTION_VIEW);
            open.setDataAndType(fileUri, "application/pdf");
            open.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            open.setClipData(ClipData.newRawUri("NCSF PDF", fileUri));
            startActivity(Intent.createChooser(open, "Open PDF"));
        } catch (Exception error) {
            Toast.makeText(this, "No PDF viewer found. Open My Files > Downloads.", Toast.LENGTH_LONG).show();
        }
    }

    private void shareDownloadedPdf(Uri fileUri, String fileName) {
        try {
            Intent share = new Intent(Intent.ACTION_SEND);
            share.setType("application/pdf");
            share.putExtra(Intent.EXTRA_STREAM, fileUri);
            share.putExtra(Intent.EXTRA_TITLE, fileName);
            share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            share.setClipData(ClipData.newRawUri(fileName, fileUri));
            startActivity(Intent.createChooser(share, "Share NCSF PDF"));
        } catch (Exception error) {
            Toast.makeText(this, "Unable to share PDF. Open it in My Files.", Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (!downloadReceiverRegistered) {
            IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                // DownloadManager may send completion from the Download Provider process.
                registerReceiver(downloadReceiver, filter, Context.RECEIVER_EXPORTED);
            } else {
                registerReceiver(downloadReceiver, filter);
            }
            downloadReceiverRegistered = true;
        }
    }

    @Override
    protected void onStop() {
        if (downloadReceiverRegistered) {
            unregisterReceiver(downloadReceiver);
            downloadReceiverRegistered = false;
        }
        super.onStop();
    }

    private void applyImmersiveMode() {
        int flags = View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
        getWindow().getDecorView().setSystemUiVisibility(flags);
    }

    private class AppBridge {
        @JavascriptInterface
        public void printPage() {
            runOnUiThread(() -> {
                try {
                    PrintManager printManager = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                    PrintDocumentAdapter adapter = webView.createPrintDocumentAdapter("NCSF Blackball Scoresheet");
                    printManager.print("NCSF Blackball Scoresheet", adapter, null);
                } catch (Exception ex) {
                    Toast.makeText(MainActivity.this, "Unable to open the Android print dialog.", Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void enterLiveFullscreen() {
            runOnUiThread(() -> forceLandscapeOrientation(true));
        }

        @JavascriptInterface
        public void exitLiveFullscreen() {
            runOnUiThread(() -> exitLiveFullscreenNative());
        }

        @JavascriptInterface
        public void setBroadcastLandscape(boolean active) {
            runOnUiThread(() -> {
                if (active) {
                    forceLandscapeOrientation(false);
                } else {
                    restorePortraitOrientation(false);
                }
            });
        }

        @JavascriptInterface
        public void setBroadcastActive(boolean active) {
            runOnUiThread(() -> {
                if (active) {
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    if (!broadcastActive) {
                        orientationBeforeBroadcast = getRequestedOrientation();
                        broadcastActive = true;
                        // Keep the app's current orientation while streaming so camera
                        // metadata and the live preview do not rotate when the phone moves.
                        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LOCKED);
                    }
                } else {
                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    if (broadcastActive) {
                        broadcastActive = false;
                        if (!liveFullscreen) {
                            setRequestedOrientation(orientationBeforeBroadcast);
                        }
                    }
                }
            });
        }

        @JavascriptInterface
        public void setVideoFullscreen(boolean active) {
            runOnUiThread(() -> {
                if (active) {
                    getWindow().getDecorView().setSystemUiVisibility(
                            View.SYSTEM_UI_FLAG_FULLSCREEN |
                            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
                            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
                } else {
                    applyImmersiveMode();
                }
            });
        }

        @JavascriptInterface
        public boolean hasCameraPermission() {
            return checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
        }

        @JavascriptInterface
        public boolean hasMicrophonePermission() {
            return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        }

        @JavascriptInterface
        public void requestBroadcastPermissions() {
            runOnUiThread(() -> {
                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                boolean cameraMissing =
                        checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED;
                boolean micMissing =
                        checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED;

                boolean cameraPreviouslyAsked = prefs.getBoolean(PREF_CAMERA_ASKED, false);
                boolean micPreviouslyAsked = prefs.getBoolean(PREF_MIC_ASKED, false);

                boolean cameraBlocked = cameraMissing
                        && cameraPreviouslyAsked
                        && !shouldShowRequestPermissionRationale(Manifest.permission.CAMERA);
                boolean micBlocked = micMissing
                        && micPreviouslyAsked
                        && !shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO);

                if (cameraBlocked) {
                    Toast.makeText(
                            MainActivity.this,
                            "Camera permission is blocked. Enable Camera for NCSF in App permissions.",
                            Toast.LENGTH_LONG).show();
                    openPermissionSettingsNative();
                    notifyWebMediaPermissionResult();
                    return;
                }

                java.util.ArrayList<String> permissions = new java.util.ArrayList<>();
                SharedPreferences.Editor editor = prefs.edit();

                if (cameraMissing) {
                    permissions.add(Manifest.permission.CAMERA);
                    editor.putBoolean(PREF_CAMERA_ASKED, true);
                }
                if (micMissing && !micBlocked) {
                    permissions.add(Manifest.permission.RECORD_AUDIO);
                    editor.putBoolean(PREF_MIC_ASKED, true);
                }
                editor.apply();

                if (permissions.isEmpty()) {
                    if (micBlocked) {
                        Toast.makeText(
                                MainActivity.this,
                                "Microphone permission is blocked. You can enable it in App permissions.",
                                Toast.LENGTH_LONG).show();
                    }
                    notifyWebMediaPermissionResult();
                } else {
                    requestPermissions(permissions.toArray(new String[0]), MEDIA_PERMISSION_REQUEST);
                }
            });
        }

        @JavascriptInterface
        public void openAppPermissionSettings() {
            runOnUiThread(() -> openPermissionSettingsNative());
        }
    }

    private void openPermissionSettingsNative() {
        try {
            Intent permissionIntent = new Intent("android.settings.APP_PERMISSION_SETTINGS");
            permissionIntent.setData(Uri.parse("package:" + getPackageName()));
            permissionIntent.putExtra("android.intent.extra.PACKAGE_NAME", getPackageName());
            startActivity(permissionIntent);
            return;
        } catch (Exception ignored) {
        }

        try {
            Intent detailsIntent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            detailsIntent.setData(Uri.parse("package:" + getPackageName()));
            startActivity(detailsIntent);
        } catch (Exception ex) {
            Toast.makeText(
                    MainActivity.this,
                    "Open Settings > Apps > NCSF > Permissions and allow Camera and Microphone.",
                    Toast.LENGTH_LONG).show();
        }
    }

    private void notifyWebMediaPermissionResult() {
        final boolean cameraGranted =
                checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
        final boolean audioGranted =
                checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        if (webView != null) {
            webView.evaluateJavascript(
                    "window.onNcsfMediaPermissionResult&&window.onNcsfMediaPermissionResult(" +
                            cameraGranted + "," + audioGranted + ");",
                    null);
        }
    }

    private void forceLandscapeOrientation(boolean immersive) {
        liveFullscreen = immersive;

        // Reset first, then force landscape twice. This works even when the
        // phone's Auto rotate setting is off and avoids stale WebView orientation.
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        webView.postDelayed(
                () -> setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE),
                70);
        webView.postDelayed(
                () -> {
                    setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
                    webView.evaluateJavascript(
                            "window.dispatchEvent(new Event('resize'));window.dispatchEvent(new Event('orientationchange'));",
                            null);
                },
                280);

        // Keep the whole app immersive in both landscape capture and video views.
        applyImmersiveMode();
    }

    private void restorePortraitOrientation(boolean fromFullscreen) {
        liveFullscreen = false;
        applyImmersiveMode();
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);

        webView.postDelayed(() -> {
            if (!liveFullscreen) {
                // Keep an active broadcaster locked at the restored portrait
                // orientation; normal viewers return to sensor-driven rotation.
                setRequestedOrientation(broadcastActive
                        ? ActivityInfo.SCREEN_ORIENTATION_LOCKED
                        : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                webView.evaluateJavascript(
                        "window.__ncsfRestoreLivePage&&window.__ncsfRestoreLivePage();",
                        null);
            }
        }, 550);
    }

    private void exitLiveFullscreenNative() {
        restorePortraitOrientation(true);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersiveMode();
    }

    @Override
    protected void onResume() {
        super.onResume();
        applyImmersiveMode();
        if (webView != null) {
            webView.postDelayed(() -> notifyWebMediaPermissionResult(), 250);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == STORAGE_PERMISSION_REQUEST) {
            PendingDownload download = pendingDownload;
            pendingDownload = null;
            if (download != null && grantResults.length > 0 &&
                    grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                enqueuePublicDownload(download);
            } else {
                Toast.makeText(this, "Storage access is required to save to Downloads on this Android version.",
                        Toast.LENGTH_LONG).show();
            }
            return;
        }
        if (requestCode == MEDIA_PERMISSION_REQUEST) {
            if (pendingMediaPermission != null) {
                java.util.ArrayList<String> grantedResources = new java.util.ArrayList<>();
                for (String resource : pendingMediaPermission.getResources()) {
                    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)
                            && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        grantedResources.add(resource);
                    }
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)
                            && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        grantedResources.add(resource);
                    }
                }
                if (!grantedResources.isEmpty()) {
                    pendingMediaPermission.grant(grantedResources.toArray(new String[0]));
                } else {
                    pendingMediaPermission.deny();
                }
                pendingMediaPermission = null;
            }
            boolean cameraGranted =
                    checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
            if (!cameraGranted) {
                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                boolean askedBefore = prefs.getBoolean(PREF_CAMERA_ASKED, false);
                boolean blocked = askedBefore
                        && !shouldShowRequestPermissionRationale(Manifest.permission.CAMERA);
                if (blocked) {
                    Toast.makeText(
                            MainActivity.this,
                            "Camera permission is blocked. Enable Camera for NCSF in App permissions.",
                            Toast.LENGTH_LONG).show();
                    openPermissionSettingsNative();
                }
            }
            notifyWebMediaPermissionResult();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST) {
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
                }
            }
            if (fileCallback != null) {
                fileCallback.onReceiveValue(results);
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (liveFullscreen) {
            webView.evaluateJavascript(
                    "window.exitNcsfLiveFullscreen&&window.exitNcsfLiveFullscreen();",
                    null);
            exitLiveFullscreenNative();
            return;
        }
        if (customView != null) {
            WebChromeClient chrome = (WebChromeClient) webView.getWebChromeClient();
            if (chrome != null) chrome.onHideCustomView();
            return;
        }
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

}
