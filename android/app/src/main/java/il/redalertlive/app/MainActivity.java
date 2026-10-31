package il.redalertlive.app;

import android.app.Activity;
import android.os.Bundle;
import android.view.WindowManager;
import android.view.View;
import android.widget.FrameLayout;
import android.graphics.Color;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.JavascriptInterface;
import android.content.Intent;
import android.content.Context;
import android.content.SharedPreferences;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.media.AudioAttributes;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private WebView webView;
    private static final String HOME = "https://redalert-live.onrender.com/";
    private static final int REQUEST_SYSTEM_SOUND = 7104;
    private String pendingSoundSlot = "primary";
    private Ringtone previewRingtone;

    private void showSystemBarsOutsideAppContent() {
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().setStatusBarColor(Color.rgb(14, 16, 19));
        getWindow().setNavigationBarColor(Color.rgb(14, 16, 19));
        getWindow().getDecorView().setSystemUiVisibility(0);
    }

    private SharedPreferences soundPrefs() {
        return getSharedPreferences("system_sounds", Context.MODE_PRIVATE);
    }

    private void sendSoundToPage(String slot, String uri, String title) {
        if (webView == null) return;
        try {
            String script = "window.onNativeSystemSoundSelected && window.onNativeSystemSoundSelected("
                + JSONObject.quote(slot) + "," + JSONObject.quote(uri == null ? "" : uri) + ","
                + JSONObject.quote(title == null ? "" : title) + ");";
            webView.post(() -> webView.evaluateJavascript(script, null));
        } catch (Exception ignored) {}
    }

    private class SystemSoundBridge {
        @JavascriptInterface
        public void choose(String slot) {
            runOnUiThread(() -> openSystemSoundPicker(slot));
        }

        @JavascriptInterface
        public String getSelected(String slot) {
            try {
                JSONObject value = new JSONObject();
                value.put("uri", soundPrefs().getString(slot + "_uri", ""));
                value.put("title", soundPrefs().getString(slot + "_title", ""));
                return value.toString();
            } catch (Exception e) { return "{}"; }
        }

        @JavascriptInterface
        public boolean hasSelected(String slot) {
            return !soundPrefs().getString(slot + "_uri", "").isEmpty();
        }

        @JavascriptInterface
        public void preview(String slot) {
            runOnUiThread(() -> playSelectedSystemSound(slot));
        }

        @JavascriptInterface
        public void playSelected(String slot) {
            runOnUiThread(() -> playSelectedSystemSound(slot));
        }
    }

    private void openSystemSoundPicker(String slot) {
        if (!"secondary".equals(slot)) slot = "primary";
        pendingSoundSlot = slot;
        Uri existing = null;
        String saved = soundPrefs().getString(slot + "_uri", "");
        if (!saved.isEmpty()) {
            try { existing = Uri.parse(saved); } catch (Exception ignored) {}
        }
        Intent intent = new Intent(RingtoneManager.ACTION_RINGTONE_PICKER);
        intent.putExtra(RingtoneManager.EXTRA_RINGTONE_TYPE, RingtoneManager.TYPE_NOTIFICATION);
        intent.putExtra(RingtoneManager.EXTRA_RINGTONE_TITLE, "בחירת צליל התרעה");
        intent.putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_SILENT, false);
        intent.putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_DEFAULT, true);
        if (existing != null) intent.putExtra(RingtoneManager.EXTRA_RINGTONE_EXISTING_URI, existing);
        try { startActivityForResult(intent, REQUEST_SYSTEM_SOUND); }
        catch (Exception e) { sendSoundToPage(pendingSoundSlot, "", "לא ניתן לפתוח את בורר הצלילים"); }
    }

    private void playSelectedSystemSound(String slot) {
        String saved = soundPrefs().getString(slot + "_uri", "");
        if (saved.isEmpty()) return;
        try {
            if (previewRingtone != null && previewRingtone.isPlaying()) previewRingtone.stop();
            previewRingtone = RingtoneManager.getRingtone(this, Uri.parse(saved));
            if (previewRingtone != null) {
                if (android.os.Build.VERSION.SDK_INT >= 21) {
                    previewRingtone.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
                }
                previewRingtone.play();
            }
        } catch (Exception ignored) {}
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_SYSTEM_SOUND || resultCode != RESULT_OK || data == null) return;
        Uri picked = data.getParcelableExtra(RingtoneManager.EXTRA_RINGTONE_PICKED_URI);
        if (picked == null) return;
        String title = RingtoneManager.getRingtone(this, picked) != null
            ? RingtoneManager.getRingtone(this, picked).getTitle(this) : "צליל מערכת";
        soundPrefs().edit().putString(pendingSoundSlot + "_uri", picked.toString())
            .putString(pendingSoundSlot + "_title", title).apply();
        sendSoundToPage(pendingSoundSlot, picked.toString(), title);
        playSelectedSystemSound(pendingSoundSlot);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        showSystemBarsOutsideAppContent();
        // Use the platform's normal safe content area. targetSdk 34 below avoids
        // Android 15's forced edge-to-edge layout for targetSdk 35 applications.
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(14, 16, 19));

        webView = new WebView(this);
        webView.setBackgroundColor(0xFF0E1013);
        root.addView(webView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setLoadsImagesAutomatically(true);
        webView.getSettings().setSupportZoom(false);
        webView.getSettings().setAllowFileAccess(false);
        webView.getSettings().setAllowContentAccess(false);
        webView.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        webView.addJavascriptInterface(new SystemSoundBridge(), "AndroidSystemSounds");
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("https".equalsIgnoreCase(uri.getScheme()) &&
                    "redalert-live.onrender.com".equalsIgnoreCase(uri.getHost())) return false;
                if ("https".equalsIgnoreCase(uri.getScheme()) || "http".equalsIgnoreCase(uri.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception ignored) {}
                    return true;
                }
                return true;
            }
        });
        setContentView(root);
        root.requestApplyInsets();
        if (savedInstanceState == null) webView.loadUrl(HOME);
        else webView.restoreState(savedInstanceState);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) showSystemBarsOutsideAppContent();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (previewRingtone != null && previewRingtone.isPlaying()) previewRingtone.stop();
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}