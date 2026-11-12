package com.metyu.board;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.Menu;
import android.view.MenuItem;
import android.view.WindowManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.Toast;

/**
 * Metyu Board: a phone window onto the Metyu Live Board (virtual money only).
 *
 * By default it opens the board bundled in the APK (the same board.html / metyu-agent.js as the
 * website), which reads live Polymarket prices directly. "Connect to my server" opens the board
 * from your own server.py instead (e.g. http://192.168.1.20:8000), which adds the 24/7 autopilot
 * panel. The app has no wallet, no keys and never places an order.
 */
public class MainActivity extends Activity {
    private static final String BUNDLED = "file:///android_asset/www/";
    private static final String PREFS = "metyu";
    private static final String KEY_SERVER = "server";
    private static final int MENU_BOARD = 1, MENU_LAB = 2, MENU_SERVER = 3, MENU_BUNDLED = 4, MENU_RELOAD = 5;

    private WebView web;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);   // a board is watched

        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);              // the board saves its account in localStorage
        settings.setAllowFileAccess(true);
        // The bundled pages (file://) read Polymarket's public API, which allows any origin.
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setTextZoom(100);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (isOwnPage(url)) return false;
                // polymarket.com and every other site open in the phone's browser.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (Exception ignored) {
                    Toast.makeText(MainActivity.this, url.toString(), Toast.LENGTH_LONG).show();
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && !"file".equals(request.getUrl().getScheme())) {
                    Toast.makeText(MainActivity.this, "Server unreachable: " + error.getDescription() + ". Showing the built-in board.", Toast.LENGTH_LONG).show();
                    view.loadUrl(BUNDLED + "board.html");
                }
            }
        });
        setContentView(web);

        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) open("board.html");
    }

    /** Pages of the app itself (bundled or on the configured server) stay inside the app. */
    private boolean isOwnPage(Uri url) {
        if ("file".equals(url.getScheme())) return true;
        String server = prefs.getString(KEY_SERVER, "");
        return !server.isEmpty() && url.toString().startsWith(server);
    }

    private void open(String page) {
        String server = prefs.getString(KEY_SERVER, "");
        web.loadUrl(server.isEmpty() ? BUNDLED + page : server + "/" + page);
        setTitle(server.isEmpty() ? "Metyu Board" : "Metyu Board · " + Uri.parse(server).getHost());
    }

    private void askForServer() {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("http://192.168.1.20:8000");
        input.setText(prefs.getString(KEY_SERVER, ""));
        new AlertDialog.Builder(this)
            .setTitle("Connect to my server")
            .setMessage("Address of your server.py (start it with --host 0.0.0.0). It adds the 24/7 autopilot panel.")
            .setView(input)
            .setPositiveButton("Connect", (dialog, which) -> {
                String value = input.getText().toString().trim().replaceAll("/+$", "");
                if (!value.startsWith("http://") && !value.startsWith("https://")) {
                    Toast.makeText(this, "Use an address starting with http:// or https://", Toast.LENGTH_LONG).show();
                    return;
                }
                prefs.edit().putString(KEY_SERVER, value).apply();
                open("board.html");
            })
            .setNegativeButton("Cancel", null)
            .show();
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, MENU_BOARD, 0, "Live Board");
        menu.add(0, MENU_LAB, 1, "Prediction Lab");
        menu.add(0, MENU_SERVER, 2, "Connect to my server…");
        menu.add(0, MENU_BUNDLED, 3, "Use the built-in board");
        menu.add(0, MENU_RELOAD, 4, "Reload");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        switch (item.getItemId()) {
            case MENU_BOARD: open("board.html"); return true;
            case MENU_LAB: open("polymarket.html"); return true;
            case MENU_SERVER: askForServer(); return true;
            case MENU_BUNDLED: prefs.edit().remove(KEY_SERVER).apply(); open("board.html"); return true;
            case MENU_RELOAD: web.reload(); return true;
            default: return super.onOptionsItemSelected(item);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
