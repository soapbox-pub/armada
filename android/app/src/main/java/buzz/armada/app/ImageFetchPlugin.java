package buzz.armada.app;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.Proxy;
import java.net.ProxySelector;
import java.net.URI;
import java.net.UnknownHostException;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;

/** {@link ImageFetch} for the page: `fetchImage({ url })` → `{ type, data }` (base64), or `{}`. */
@CapacitorPlugin(name = "ArmadaImageFetch")
public class ImageFetchPlugin extends Plugin {
    /** As the page's own image downloads in flight (FETCH_CONCURRENCY in src/lib/imageThumb.ts). */
    private final ExecutorService pool = Executors.newFixedThreadPool(4);

    /** No cookie jar, no cache, no redirects: each hop is ImageFetch's to check. */
    private final OkHttpClient base = new OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .callTimeout(15, TimeUnit.SECONDS)
        .build();

    @PluginMethod
    public void fetchImage(PluginCall call) {
        String url = call.getString("url");
        // The <img> request's own User-Agent, so this is the request the page already makes.
        String userAgent = call.getString("userAgent");
        if (url == null) {
            call.resolve(new JSObject());
            return;
        }
        pool.execute(() -> {
            ImageFetch.Image image = ImageFetch.fetch(url, (u, pinned) -> get(u, pinned, userAgent), ImageFetchPlugin::resolve);
            JSObject out = new JSObject();
            if (image != null) {
                out.put("type", image.type);
                out.put("data", Base64.encodeToString(image.data, Base64.NO_WRAP));
            }
            call.resolve(out);
        });
    }

    /** The proxy the system would use for {@code url}; DIRECT when none. */
    private static Proxy proxyFor(URI url) {
        try {
            List<Proxy> proxies = ProxySelector.getDefault().select(url);
            return proxies.isEmpty() ? Proxy.NO_PROXY : proxies.get(0);
        } catch (Exception e) {
            return Proxy.NO_PROXY;
        }
    }

    /** Through a proxy the proxy resolves the name; asking here would leak it to local DNS. */
    private static List<InetAddress> resolve(URI url) throws UnknownHostException {
        if (proxyFor(url).type() != Proxy.Type.DIRECT) return null;
        return Arrays.asList(InetAddress.getAllByName(url.getHost()));
    }

    private ImageFetch.Response get(URI url, List<InetAddress> pinned, String userAgent) throws IOException {
        OkHttpClient.Builder client = base.newBuilder();
        if (pinned == null) {
            client.proxy(proxyFor(url));
        } else {
            // Connect only to the addresses that were checked: a second lookup could rebind.
            String host = url.getHost();
            client.proxy(Proxy.NO_PROXY).dns(name -> {
                if (!name.equalsIgnoreCase(host)) throw new UnknownHostException(name);
                return pinned;
            });
        }
        Request.Builder request = new Request.Builder().url(url.toString()).header("Accept", "image/*");
        if (userAgent != null && !userAgent.isEmpty()) request.header("User-Agent", userAgent);
        okhttp3.Response res = client.build().newCall(request.get().build()).execute();
        return new ImageFetch.Response() {
            @Override public int status() { return res.code(); }
            @Override public String location() { return res.header("Location"); }
            @Override public InputStream body() { return res.body() == null ? null : res.body().byteStream(); }
            @Override public void close() { res.close(); }
        };
    }

    @Override
    protected void handleOnDestroy() {
        pool.shutdownNow();
    }
}
