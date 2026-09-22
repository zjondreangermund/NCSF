package com.ncsf.league;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.pm.ActivityInfo;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
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

public class MainActivity extends Activity {
    private static final String HOME_URL = "https://ncsf-production.up.railway.app/";
    private static final int FILE_CHOOSER_REQUEST = 501;
    private static final int MEDIA_PERMISSION_REQUEST = 502;
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

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(7, 24, 44));
        getWindow().setNavigationBarColor(Color.rgb(7, 24, 44));

        root = new FrameLayout(this);
        webView = new WebView(this);

        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        setContentView(root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setUserAgentString(settings.getUserAgentString() + " NCSFAndroid/1.12");

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
                getWindow().getDecorView().setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_FULLSCREEN |
                        View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
                        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                root.removeView(customView);
                customView = null;
                webView.setVisibility(View.VISIBLE);
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
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
            try {
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                String cookies = CookieManager.getInstance().getCookie(url);
                if (cookies != null) request.addRequestHeader("Cookie", cookies);
                request.addRequestHeader("User-Agent", userAgent);
                request.setMimeType(mimeType);
                String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
                request.setTitle(fileName);
                request.setDescription("NCSF document");
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationInExternalFilesDir(MainActivity.this, Environment.DIRECTORY_DOWNLOADS, fileName);
                DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                manager.enqueue(request);
                Toast.makeText(MainActivity.this, "Downloading " + fileName, Toast.LENGTH_SHORT).show();
            } catch (Exception ex) {
                Toast.makeText(MainActivity.this, "Unable to download this file.", Toast.LENGTH_SHORT).show();
            }
        });

        if (savedInstanceState == null) {
            webView.loadUrl(HOME_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }
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
            runOnUiThread(() -> {
                liveFullscreen = true;
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
                getWindow().getDecorView().setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_FULLSCREEN |
                        View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
                        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
            });
        }

        @JavascriptInterface
        public void exitLiveFullscreen() {
            runOnUiThread(() -> exitLiveFullscreenNative());
        }

        @JavascriptInterface
        public void setBroadcastActive(boolean active) {
            runOnUiThread(() -> {
                if (active) {
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
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

    private void exitLiveFullscreenNative() {
        liveFullscreen = false;
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
    }

    @Override
    protected void onResume() {
        super.onResume();
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
