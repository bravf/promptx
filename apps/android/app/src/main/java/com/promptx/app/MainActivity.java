package com.promptx.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

public class MainActivity extends Activity {
  private static final String PREFS_NAME = "promptx_android";
  private static final String PREF_URL = "base_url";
  private static final String PREF_SITES = "sites";
  private static final int FILE_CHOOSER_REQUEST_CODE = 1001;
  private static final long LOAD_TIMEOUT_MS = 10000L;

  private final Handler handler = new Handler(Looper.getMainLooper());

  private SharedPreferences preferences;
  private EditText addressInput;
  private Button siteSwitchButton;
  private ProgressBar progressBar;
  private WebView webView;
  private LinearLayout overlay;
  private TextView overlayTitle;
  private TextView overlayMessage;
  private Button overlayPrimaryButton;
  private ValueCallback<Uri[]> fileChooserCallback;
  private String currentUrl = "";
  private String pendingUrl = "";
  private boolean loading = false;
  private boolean hasMainFrameError = false;
  private boolean shouldPersistNextSuccess = false;

  private final Runnable loadTimeoutRunnable = () -> {
    if (!loading) {
      return;
    }
    hasMainFrameError = true;
    shouldPersistNextSuccess = false;
    loading = false;
    webView.stopLoading();
    setLoading(false);
    showErrorState(
      "加载超时",
      "10 秒内没有打开页面，请检查访问地址或网络。"
    );
  };

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    preferences = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    configureSystemBars();
    buildLayout();
    configureWebView();

    String savedUrl = preferences.getString(PREF_URL, "");
    if (savedUrl == null || savedUrl.trim().isEmpty()) {
      showWelcomeState();
    } else {
      addressInput.setText(savedUrl);
      loadUrl(savedUrl);
    }
  }

  private void configureSystemBars() {
    Window window = getWindow();
    window.clearFlags(
      WindowManager.LayoutParams.FLAG_FULLSCREEN
        | WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS
        | WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION
        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
    );

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
      window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
      window.setStatusBarColor(Color.rgb(250, 250, 249));
      window.setNavigationBarColor(Color.rgb(250, 250, 249));
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      window.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      window.setDecorFitsSystemWindows(true);
    }
  }

  @SuppressLint("SetJavaScriptEnabled")
  private void configureWebView() {
    WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);

    WebSettings settings = webView.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setDatabaseEnabled(true);
    settings.setLoadWithOverviewMode(true);
    settings.setUseWideViewPort(true);
    settings.setBuiltInZoomControls(false);
    settings.setDisplayZoomControls(false);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(true);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
    settings.setUserAgentString(settings.getUserAgentString() + " PromptXAndroid/0.1.0");

    CookieManager cookieManager = CookieManager.getInstance();
    cookieManager.setAcceptCookie(true);
    cookieManager.setAcceptThirdPartyCookies(webView, true);

    webView.setWebViewClient(new PromptXWebViewClient());
    webView.setWebChromeClient(new PromptXWebChromeClient());
    webView.setDownloadListener(createDownloadListener());
  }

  private void buildLayout() {
    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setBackgroundColor(Color.rgb(250, 250, 249));
    root.setFitsSystemWindows(true);
    root.setOnApplyWindowInsetsListener((view, insets) -> {
      int topInset;
      int bottomInset;
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        android.graphics.Insets systemBars = insets.getInsets(WindowInsets.Type.systemBars());
        topInset = systemBars.top;
        bottomInset = systemBars.bottom;
      } else {
        topInset = insets.getSystemWindowInsetTop();
        bottomInset = insets.getSystemWindowInsetBottom();
      }
      view.setPadding(0, topInset, 0, bottomInset);
      return insets;
    });
    setContentView(root);
    root.requestApplyInsets();

    LinearLayout toolbar = new LinearLayout(this);
    toolbar.setOrientation(LinearLayout.HORIZONTAL);
    toolbar.setGravity(Gravity.CENTER_VERTICAL);
    toolbar.setPadding(dp(10), dp(8), dp(10), dp(8));
    toolbar.setBackgroundColor(Color.rgb(250, 250, 249));
    root.addView(toolbar, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ));

    addressInput = new EditText(this);
    addressInput.setSingleLine(true);
    addressInput.setHint("输入 PromptX 访问地址");
    addressInput.setTextSize(14);
    addressInput.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
    addressInput.setImeOptions(EditorInfo.IME_ACTION_GO);
    addressInput.setSelectAllOnFocus(false);
    addressInput.setPadding(dp(12), 0, dp(12), 0);
    addressInput.setOnEditorActionListener((view, actionId, event) -> {
      boolean enterPressed = event != null
        && event.getKeyCode() == KeyEvent.KEYCODE_ENTER
        && event.getAction() == KeyEvent.ACTION_UP;
      if (actionId == EditorInfo.IME_ACTION_GO || enterPressed) {
        handleAddressConfirm();
        return true;
      }
      return false;
    });
    toolbar.addView(addressInput, new LinearLayout.LayoutParams(
      0,
      dp(44),
      1
    ));

    siteSwitchButton = new Button(this);
    siteSwitchButton.setText("▼");
    siteSwitchButton.setAllCaps(false);
    siteSwitchButton.setTextSize(13);
    siteSwitchButton.setOnClickListener((view) -> showSiteSwitcher());
    LinearLayout.LayoutParams switchParams = new LinearLayout.LayoutParams(dp(44), dp(44));
    switchParams.setMargins(dp(8), 0, 0, 0);
    toolbar.addView(siteSwitchButton, switchParams);

    progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
    progressBar.setIndeterminate(true);
    progressBar.setVisibility(View.GONE);
    root.addView(progressBar, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      dp(2)
    ));

    FrameLayout content = new FrameLayout(this);
    root.addView(content, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      0,
      1
    ));

    webView = new WebView(this);
    content.addView(webView, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));

    overlay = new LinearLayout(this);
    overlay.setOrientation(LinearLayout.VERTICAL);
    overlay.setGravity(Gravity.CENTER);
    overlay.setPadding(dp(28), dp(24), dp(28), dp(24));
    overlay.setBackgroundColor(Color.rgb(250, 250, 249));
    content.addView(overlay, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));

    overlayTitle = new TextView(this);
    overlayTitle.setTextColor(Color.rgb(28, 25, 23));
    overlayTitle.setTextSize(22);
    overlayTitle.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    overlayTitle.setGravity(Gravity.CENTER);
    overlay.addView(overlayTitle, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ));

    overlayMessage = new TextView(this);
    overlayMessage.setTextColor(Color.rgb(87, 83, 78));
    overlayMessage.setTextSize(15);
    overlayMessage.setGravity(Gravity.CENTER);
    overlayMessage.setLineSpacing(dp(4), 1.0f);
    LinearLayout.LayoutParams messageParams = new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    );
    messageParams.setMargins(0, dp(12), 0, dp(20));
    overlay.addView(overlayMessage, messageParams);

    overlayPrimaryButton = new Button(this);
    overlayPrimaryButton.setAllCaps(false);
    overlayPrimaryButton.setVisibility(View.GONE);
    overlay.addView(overlayPrimaryButton, new LinearLayout.LayoutParams(dp(112), dp(44)));
  }

  private void showWelcomeState() {
    currentUrl = "";
    setLoading(false);
    overlayTitle.setText("欢迎使用 PromptX");
    overlayMessage.setText("请在顶部输入你的 PromptX 访问地址，例如：\n\ndongdong.promptx.mushayu.com\n\n地址会在成功打开后保存在本机。");
    overlay.setVisibility(View.VISIBLE);
    webView.setVisibility(View.GONE);
    overlayPrimaryButton.setVisibility(View.GONE);
    addressInput.requestFocus();
  }

  private void showErrorState(String title, String message) {
    overlayTitle.setText(title);
    overlayMessage.setText(message);
    overlayPrimaryButton.setText("重新加载");
    overlayPrimaryButton.setVisibility(View.VISIBLE);
    overlayPrimaryButton.setOnClickListener((view) -> loadFromAddress(true));
    overlay.setVisibility(View.VISIBLE);
    webView.setVisibility(View.VISIBLE);
  }

  private void hideOverlay() {
    overlay.setVisibility(View.GONE);
    webView.setVisibility(View.VISIBLE);
  }

  private void loadFromAddress(boolean hideKeyboard) {
    String normalizedUrl = normalizeUrl(addressInput.getText().toString());
    if (normalizedUrl.isEmpty()) {
      Toast.makeText(this, "请输入有效访问地址", Toast.LENGTH_SHORT).show();
      showWelcomeState();
      return;
    }

    if (hideKeyboard) {
      hideKeyboard();
    }
    addressInput.setText(normalizedUrl);
    loadUrl(normalizedUrl);
  }

  private void loadUrl(String url) {
    String normalizedUrl = normalizeUrl(url);
    if (normalizedUrl.isEmpty()) {
      Toast.makeText(this, "请输入有效访问地址", Toast.LENGTH_SHORT).show();
      return;
    }

    pendingUrl = normalizedUrl;
    currentUrl = normalizedUrl;
    shouldPersistNextSuccess = true;
    addressInput.setText(normalizedUrl);
    hideOverlay();
    setLoading(true);
    loading = true;
    hasMainFrameError = false;
    handler.removeCallbacks(loadTimeoutRunnable);
    handler.postDelayed(loadTimeoutRunnable, LOAD_TIMEOUT_MS);
    webView.loadUrl(normalizedUrl);
  }

  private void saveSuccessfulUrl(String url) {
    String normalizedUrl = normalizeUrl(url);
    if (normalizedUrl.isEmpty() || hasMainFrameError || isInternalWebViewUrl(normalizedUrl)) {
      return;
    }
    currentUrl = normalizedUrl;
    addressInput.setText(normalizedUrl);
    if (!shouldPersistNextSuccess) {
      return;
    }

    String siteUrl = normalizeUrl(pendingUrl);
    if (siteUrl.isEmpty()) {
      siteUrl = normalizedUrl;
    }
    pendingUrl = "";
    shouldPersistNextSuccess = false;
    preferences.edit().putString(PREF_URL, siteUrl).apply();
    addSavedSite(siteUrl);
  }

  private boolean isInternalWebViewUrl(String url) {
    String value = url == null ? "" : url.trim().toLowerCase();
    return value.isEmpty()
      || value.equals("about:blank")
      || value.startsWith("data:")
      || value.startsWith("chrome-error:")
      || value.contains("chromewebdata");
  }

  private void handleAddressConfirm() {
    String normalizedUrl = normalizeUrl(addressInput.getText().toString());
    if (normalizedUrl.isEmpty()) {
      Toast.makeText(this, "请输入有效访问地址", Toast.LENGTH_SHORT).show();
      return;
    }

    if (normalizedUrl.equals(currentUrl) && webView != null) {
      hideKeyboard();
      webView.reload();
      return;
    }

    loadFromAddress(true);
  }

  private List<String> getSavedSites() {
    String raw = preferences.getString(PREF_SITES, "");
    Set<String> seen = new LinkedHashSet<>();
    if (raw != null && !raw.trim().isEmpty()) {
      String[] parts = raw.split("\\n");
      for (String part : parts) {
        String normalizedUrl = normalizeUrl(part);
        if (!normalizedUrl.isEmpty()) {
          seen.add(normalizedUrl);
        }
      }
    }

    String savedUrl = normalizeUrl(preferences.getString(PREF_URL, ""));
    if (!savedUrl.isEmpty()) {
      seen.add(savedUrl);
    }

    return new ArrayList<>(seen);
  }

  private void persistSavedSites(List<String> sites) {
    Set<String> seen = new LinkedHashSet<>();
    for (String site : sites) {
      String normalizedUrl = normalizeUrl(site);
      if (!normalizedUrl.isEmpty()) {
        seen.add(normalizedUrl);
      }
    }
    preferences.edit().putString(PREF_SITES, String.join("\n", seen)).apply();
  }

  private void addSavedSite(String url) {
    String normalizedUrl = normalizeUrl(url);
    if (normalizedUrl.isEmpty()) {
      return;
    }
    List<String> sites = getSavedSites();
    sites.remove(normalizedUrl);
    sites.add(0, normalizedUrl);
    persistSavedSites(sites);
  }

  private void removeSavedSite(String url) {
    String normalizedUrl = normalizeUrl(url);
    if (normalizedUrl.isEmpty()) {
      return;
    }
    List<String> sites = getSavedSites();
    sites.remove(normalizedUrl);
    persistSavedSites(sites);

    String savedUrl = normalizeUrl(preferences.getString(PREF_URL, ""));
    if (normalizedUrl.equals(savedUrl)) {
      if (sites.isEmpty()) {
        preferences.edit().remove(PREF_URL).apply();
        addressInput.setText("");
        webView.loadUrl("about:blank");
        showWelcomeState();
      } else {
        preferences.edit().putString(PREF_URL, sites.get(0)).apply();
        loadUrl(sites.get(0));
      }
    }
  }

  private void showSiteSwitcher() {
    hideKeyboard();
    List<String> sites = getSavedSites();
    List<String> labels = new ArrayList<>();
    String activeUrl = normalizeUrl(preferences.getString(PREF_URL, currentUrl));
    for (String site : sites) {
      labels.add((site.equals(activeUrl) ? "✓ " : "  ") + getSiteLabel(site));
    }
    labels.add("+ 添加站点");

    AlertDialog dialog = new AlertDialog.Builder(this)
      .setTitle("PromptX 站点")
      .setItems(labels.toArray(new String[0]), (d, which) -> {
        if (which >= sites.size()) {
          d.dismiss();
          addressInput.postDelayed(this::beginAddSite, 200);
          return;
        }
        String selectedSite = sites.get(which);
        preferences.edit().putString(PREF_URL, selectedSite).apply();
        addressInput.setText(selectedSite);
        loadUrl(selectedSite);
      })
      .create();

    dialog.setOnShowListener((d) -> {
      ListView listView = dialog.getListView();
      listView.setOnItemLongClickListener((parent, view, position, id) -> {
        if (position >= sites.size()) {
          return false;
        }
        confirmDeleteSite(sites.get(position));
        dialog.dismiss();
        return true;
      });
    });

    dialog.show();
  }

  private void beginAddSite() {
    addressInput.setText("");
    addressInput.setHint("输入新的 PromptX 访问地址");
    addressInput.requestFocus();
    addressInput.post(() -> {
      InputMethodManager inputMethodManager = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
      if (inputMethodManager != null) {
        inputMethodManager.showSoftInput(addressInput, InputMethodManager.SHOW_IMPLICIT);
      }
    });
  }

  private void confirmDeleteSite(String site) {
    new AlertDialog.Builder(this)
      .setTitle("删除站点？")
      .setMessage(getSiteLabel(site))
      .setNegativeButton("取消", null)
      .setPositiveButton("删除", (dialog, which) -> removeSavedSite(site))
      .show();
  }

  private String getSiteLabel(String url) {
    try {
      URI uri = new URI(url);
      String host = uri.getHost();
      String path = uri.getPath();
      String query = uri.getQuery();
      StringBuilder label = new StringBuilder(host == null || host.isEmpty() ? url : host);
      if (path != null && !path.isEmpty() && !path.equals("/")) {
        label.append(path);
      }
      if (query != null && !query.isEmpty()) {
        label.append("?").append(query);
      }
      return label.toString();
    } catch (URISyntaxException err) {
      return url;
    }
  }

  private void setLoading(boolean nextLoading) {
    progressBar.setVisibility(nextLoading ? View.VISIBLE : View.GONE);
  }

  private String normalizeUrl(String input) {
    String value = input == null ? "" : input.trim();
    if (value.isEmpty()) {
      return "";
    }
    if (!value.matches("(?i)^[a-z][a-z0-9+.-]*://.*")) {
      value = "https://" + value;
    }
    try {
      URI uri = new URI(value);
      String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
      if (!scheme.equals("http") && !scheme.equals("https")) {
        return "";
      }
      if (uri.getHost() == null || uri.getHost().trim().isEmpty()) {
        return "";
      }
      return uri.toString();
    } catch (URISyntaxException err) {
      return "";
    }
  }

  private void hideKeyboard() {
    InputMethodManager inputMethodManager = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
    if (inputMethodManager != null) {
      inputMethodManager.hideSoftInputFromWindow(addressInput.getWindowToken(), 0);
    }
    addressInput.clearFocus();
  }

  private DownloadListener createDownloadListener() {
    return (url, userAgent, contentDisposition, mimetype, contentLength) -> {
      try {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        startActivity(intent);
      } catch (ActivityNotFoundException err) {
        Toast.makeText(this, "没有可处理下载的应用", Toast.LENGTH_SHORT).show();
      }
    };
  }

  private void openExternalUrl(String url) {
    try {
      startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
    } catch (ActivityNotFoundException err) {
      Toast.makeText(this, "无法打开外部链接", Toast.LENGTH_SHORT).show();
    }
  }

  private int dp(int value) {
    float density = getResources().getDisplayMetrics().density;
    return Math.round(value * density);
  }

  @Override
  public void onBackPressed() {
    if (webView != null && webView.canGoBack()) {
      webView.goBack();
      return;
    }
    super.onBackPressed();
  }

  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode != FILE_CHOOSER_REQUEST_CODE || fileChooserCallback == null) {
      return;
    }

    Uri[] results = null;
    if (resultCode == RESULT_OK) {
      results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
    }
    fileChooserCallback.onReceiveValue(results);
    fileChooserCallback = null;
  }

  @Override
  protected void onDestroy() {
    handler.removeCallbacks(loadTimeoutRunnable);
    if (webView != null) {
      webView.destroy();
    }
    super.onDestroy();
  }

  private final class PromptXWebViewClient extends WebViewClient {
    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
      Uri uri = request.getUrl();
      String scheme = uri == null || uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
      if (scheme.equals("http") || scheme.equals("https")) {
        currentUrl = uri.toString();
        addressInput.setText(currentUrl);
        return false;
      }
      openExternalUrl(uri.toString());
      return true;
    }

    @Override
    public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
      currentUrl = url == null ? "" : url;
      hasMainFrameError = false;
      if (!currentUrl.equals("about:blank")) {
        addressInput.setText(currentUrl);
      }
      setLoading(true);
    }

    @Override
    public void onPageCommitVisible(WebView view, String url) {
      loading = false;
      handler.removeCallbacks(loadTimeoutRunnable);
      setLoading(false);
      hideOverlay();
      saveSuccessfulUrl(url);
    }

    @Override
    public void onPageFinished(WebView view, String url) {
      loading = false;
      handler.removeCallbacks(loadTimeoutRunnable);
      setLoading(false);
      if (url != null && !isInternalWebViewUrl(url) && !hasMainFrameError) {
        currentUrl = url;
        addressInput.setText(url);
      }
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
      if (request != null && !request.isForMainFrame()) {
        return;
      }
      loading = false;
      hasMainFrameError = true;
      shouldPersistNextSuccess = false;
      handler.removeCallbacks(loadTimeoutRunnable);
      setLoading(false);
      String detail = error == null ? "请检查访问地址或网络。" : String.valueOf(error.getDescription());
      showErrorState("无法打开 PromptX", detail + "\n\n请检查顶部地址，修改后按键盘确认重新加载。");
    }

    @Override
    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
      handler.cancel();
      loading = false;
      hasMainFrameError = true;
      shouldPersistNextSuccess = false;
      MainActivity.this.handler.removeCallbacks(loadTimeoutRunnable);
      setLoading(false);
      showErrorState("证书校验失败", "当前地址的 HTTPS 证书无法通过校验，请检查域名和证书配置。");
    }
  }

  private final class PromptXWebChromeClient extends WebChromeClient {
    @Override
    public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
      if (fileChooserCallback != null) {
        fileChooserCallback.onReceiveValue(null);
      }
      fileChooserCallback = filePathCallback;

      Intent intent = fileChooserParams.createIntent();
      try {
        startActivityForResult(intent, FILE_CHOOSER_REQUEST_CODE);
        return true;
      } catch (ActivityNotFoundException err) {
        fileChooserCallback = null;
        Toast.makeText(MainActivity.this, "没有可选择文件的应用", Toast.LENGTH_SHORT).show();
        return false;
      }
    }

    @Override
    public void onProgressChanged(WebView view, int newProgress) {
      if (newProgress >= 100) {
        setLoading(false);
      } else if (loading) {
        setLoading(true);
      }
    }
  }
}
